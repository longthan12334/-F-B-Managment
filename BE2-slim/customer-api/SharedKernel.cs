// =============================================================================
//  SharedKernel.cs — Mọi primitive, abstraction, middleware chung của mọi module.
//
//  Modular Monolith (Buổi 12) chỉ bắt buộc: nhiều module tách bounded context,
//  giao tiếp qua event bus. Không bắt buộc chia file nhỏ. Nên mọi thứ "shared"
//  gộp 1 file để dễ nhìn tổng thể.
//
//  Khi dự án lớn: tách file khi >400 dòng, hoặc khi cần thêm nhiều abstraction.
// =============================================================================

using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace RestoManager.SharedKernel;

// ─── 1. Primitives + Events ─────────────────────────────────────────────────

/// <summary>Base class cho mọi Entity (có Id + List DomainEvents).</summary>
public abstract class Entity
{
    private readonly List<IDomainEvent> _domainEvents = new();
    public Guid Id { get; protected set; }

    public IReadOnlyCollection<IDomainEvent> DomainEvents => _domainEvents.AsReadOnly();
    protected void RaiseEvent(IDomainEvent evt) => _domainEvents.Add(evt);
    public void ClearDomainEvents() => _domainEvents.Clear();

    protected Entity() { }
    protected Entity(Guid id)
    {
        if (id == Guid.Empty)
            throw new ArgumentException("Entity Id không được là Guid.Empty.", nameof(id));
        Id = id;
    }

    public override bool Equals(object? obj)
        => obj is Entity other && GetType() == other.GetType() && Id == other.Id;
    public override int GetHashCode() => HashCode.Combine(GetType(), Id);
}

/// <summary>Marker interface cho Domain Event (dispatch qua IEventBus).</summary>
public interface IDomainEvent
{
    DateTimeOffset OccurredAt { get; }
}

// ─── 2. Abstractions ────────────────────────────────────────────────────────

/// <summary>"Thời gian hiện tại" — DIP, inject thay vì DateTime.UtcNow trực tiếp.</summary>
public interface IDateTimeProvider
{
    DateTimeOffset UtcNow { get; }
}

/// <summary>
/// In-memory Event Bus — cốt lõi Modular Monolith (Buổi 12).
/// Module A phát event → mọi IEventHandler&lt;T&gt; đã đăng ký ở module khác chạy.
/// </summary>
public interface IEventBus
{
    Task PublishAsync<TEvent>(TEvent evt, CancellationToken ct = default)
        where TEvent : IDomainEvent;
}

public interface IEventHandler<in TEvent> where TEvent : IDomainEvent
{
    Task HandleAsync(TEvent evt, CancellationToken ct);
}

/// <summary>
/// Contract của 1 module. Program.cs chạy mỗi module qua interface này.
/// Thêm module mới = tạo class implement + thêm 1 dòng vào Program.cs.
/// </summary>
public interface IModule
{
    string Name { get; }
    void Register(IServiceCollection services, IConfiguration configuration);
    void MapEndpoints(WebApplication app) { }
}

// ─── 3. Exception base ──────────────────────────────────────────────────────

/// <summary>
/// Base cho mọi exception nghiệp vụ của mọi module. ExceptionHandlingMiddleware
/// map subclass → HTTP status qua property Code.
/// </summary>
public abstract class DomainException : Exception
{
    public abstract string Code { get; }
    protected DomainException(string message) : base(message) { }
}

// ─── 4. Implementations ─────────────────────────────────────────────────────

internal sealed class DateTimeProvider : IDateTimeProvider
{
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
}

internal sealed class InMemoryEventBus : IEventBus
{
    private readonly IServiceProvider _sp;
    private readonly ILogger<InMemoryEventBus> _logger;

    public InMemoryEventBus(IServiceProvider sp, ILogger<InMemoryEventBus> logger)
    {
        _sp = sp;
        _logger = logger;
    }

    public async Task PublishAsync<TEvent>(TEvent evt, CancellationToken ct = default)
        where TEvent : IDomainEvent
    {
        var handlers = _sp.GetServices<IEventHandler<TEvent>>().ToList();
        if (handlers.Count == 0)
        {
            _logger.LogDebug("No handler for event {EventType}", typeof(TEvent).Name);
            return;
        }

        foreach (var h in handlers)
        {
            try { await h.HandleAsync(evt, ct); }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Handler {Handler} failed on event {EventType}",
                    h.GetType().Name, typeof(TEvent).Name);
            }
        }
    }
}

// ─── 5. Middleware chung ────────────────────────────────────────────────────

/// <summary>
/// Global exception handler — map DomainException → HTTP 4xx theo Code, không
/// leak stack trace. Lỗi khác → 500 generic.
/// </summary>
public sealed class ExceptionHandlingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<ExceptionHandlingMiddleware> _logger;

    public ExceptionHandlingMiddleware(RequestDelegate next, ILogger<ExceptionHandlingMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        try { await _next(context); }
        catch (DomainException ex)
        {
            var status = ex.Code switch
            {
                "not_found"           => HttpStatusCode.NotFound,
                "session_expired"     => HttpStatusCode.Gone,
                "invalid_qr_token"    => HttpStatusCode.Forbidden,
                "invalid_session"     => HttpStatusCode.Unauthorized,
                "invalid_order_state" => HttpStatusCode.Conflict,
                _                     => HttpStatusCode.Conflict,
            };
            await WriteAsync(context, status, new { code = ex.Code, message = ex.Message });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Unhandled exception for {Method} {Path}",
                context.Request.Method, context.Request.Path);
            await WriteAsync(context, HttpStatusCode.InternalServerError, new
            {
                code = "internal_error",
                message = "Đã có lỗi xảy ra. Vui lòng thử lại sau.",
            });
        }
    }

    private static Task WriteAsync(HttpContext ctx, HttpStatusCode status, object body)
    {
        ctx.Response.StatusCode  = (int)status;
        ctx.Response.ContentType = "application/json; charset=utf-8";
        var json = JsonSerializer.Serialize(body, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        });
        return ctx.Response.WriteAsync(json);
    }
}

/// <summary>Thêm security headers chuẩn OWASP cho mọi response.</summary>
public sealed class SecurityHeadersMiddleware
{
    private readonly RequestDelegate _next;
    public SecurityHeadersMiddleware(RequestDelegate next) => _next = next;

    public Task InvokeAsync(HttpContext context)
    {
        var h = context.Response.Headers;
        h["X-Content-Type-Options"] = "nosniff";
        h["X-Frame-Options"]        = "DENY";
        h["Referrer-Policy"]        = "strict-origin-when-cross-origin";
        h["Permissions-Policy"]     = "geolocation=(), camera=(), microphone=()";
        return _next(context);
    }
}

// ─── 6. DI extension ────────────────────────────────────────────────────────

public static class SharedKernelExtensions
{
    public static IServiceCollection AddSharedKernel(this IServiceCollection services)
    {
        services.AddSingleton<IDateTimeProvider, DateTimeProvider>();
        services.AddScoped<IEventBus, InMemoryEventBus>();
        return services;
    }
}
