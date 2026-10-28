// =============================================================================
//  Api.cs — Presentation layer của module.
//
//  Gồm:
//   - DTOs                      (request + response)
//   - Security filter + middleware (RequireGuestSession, AntiReplay)
//   - 3 Controllers              (Session, Menu, Order)
// =============================================================================

using System.ComponentModel.DataAnnotations;
using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.OpenApi.Models;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace RestoManager.Modules.CustomerOrdering;

// ─── 1. DTOs ────────────────────────────────────────────────────────────────

public sealed record InitSessionRequest
{
    [Required, MaxLength(32)]
    public string TableCode { get; init; } = string.Empty;

    [Required, MinLength(64), MaxLength(64)]
    public string QrToken { get; init; } = string.Empty;

    [MaxLength(128)]
    public string? DeviceFingerprint { get; init; }
}

public sealed record SessionInitResponse(
    string SessionToken,
    Guid TableSessionId,
    DateTimeOffset ExpiresAt,
    TableInfoDto Table,
    IReadOnlyList<MenuCategoryDto> Categories,
    IReadOnlyList<MenuItemDto> Items);

public sealed record SessionExtendResponse(
    Guid TableSessionId,
    string TableCode,
    DateTimeOffset ExpiresAt,
    string Status);

public sealed record TableInfoDto(Guid Id, string Code, string Zone, int Capacity);
public sealed record MenuDto(IReadOnlyList<MenuCategoryDto> Categories, IReadOnlyList<MenuItemDto> Items);
public sealed record MenuCategoryDto(Guid Id, string Code, string Name, int SortOrder);
public sealed record MenuItemDto(Guid Id, string Name, string? Description, decimal Price,
    Guid? CategoryId, string? Emoji, string? ImageUrl);

public sealed record CreateOrderRequest
{
    [MaxLength(500)]
    public string? Notes { get; init; }

    [Required, MinLength(1)]
    public List<CreateOrderItemRequest> Items { get; init; } = new();
}

public sealed record CreateOrderItemRequest
{
    [Required] public Guid MenuItemId { get; init; }
    [Range(1, 99)] public int Quantity { get; init; }
    [MaxLength(500)] public string? Notes { get; init; }
}

public sealed record GuestOrderDto(
    Guid Id, string Code, string TableCode, string Status,
    decimal TotalAmount, string? Notes,
    DateTimeOffset CreatedAt, DateTimeOffset? ConfirmedAt,
    IReadOnlyList<GuestOrderItemDto> Items);

public sealed record GuestOrderItemDto(
    Guid Id, Guid MenuItemId, string ItemName, int Quantity,
    decimal Price, decimal TotalPrice, string? Notes);

// ─── 2. Security: SessionContext + Filter + AntiReplay middleware ──────────

public sealed record GuestSessionContext(
    Guid TableSessionId, Guid DeviceSessionId, string TableCode, DateTimeOffset ExpiresAt)
{
    public const string ItemKey = "co.guest-session-context";
}

/// <summary>
/// Validate X-Session-Token, attach GuestSessionContext vào HttpContext.Items.
/// 401 nếu thiếu/sai token · 410 nếu session hết hạn.
/// </summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method)]
public sealed class RequireGuestSessionAttribute : Attribute, IAsyncAuthorizationFilter
{
    public const string HeaderName = "X-Session-Token";

    public async Task OnAuthorizationAsync(AuthorizationFilterContext context)
    {
        var http = context.HttpContext;
        if (!http.Request.Headers.TryGetValue(HeaderName, out var tokenHeader) ||
            string.IsNullOrWhiteSpace(tokenHeader))
        {
            context.Result = new UnauthorizedObjectResult(new
            {
                code = "missing_session_token",
                message = $"Thiếu header {HeaderName}.",
            });
            return;
        }

        if (!SessionToken.TryParse(tokenHeader.ToString(), out _))
        {
            context.Result = new UnauthorizedObjectResult(new
            {
                code = "invalid_session_token",
                message = "Session token không đúng định dạng.",
            });
            return;
        }

        var sessions = http.RequestServices.GetRequiredService<SessionService>();
        try
        {
            var tuple = await sessions.ValidateAsync(tokenHeader.ToString(), http.RequestAborted);
            if (tuple is null)
            {
                context.Result = new UnauthorizedObjectResult(new
                {
                    code = "invalid_session_token",
                    message = "Session token không tồn tại.",
                });
                return;
            }

            var (device, tableSession) = tuple.Value;
            http.Items[GuestSessionContext.ItemKey] = new GuestSessionContext(
                tableSession.Id, device.Id, tableSession.TableCode, tableSession.ExpiresAt);
        }
        catch (SessionExpiredException ex)
        {
            context.Result = new ObjectResult(new { code = ex.Code, message = ex.Message })
            { StatusCode = StatusCodes.Status410Gone };
        }
    }
}

public static class HttpContextSessionExtensions
{
    public static GuestSessionContext GetGuestSession(this HttpContext http)
    {
        if (http.Items[GuestSessionContext.ItemKey] is not GuestSessionContext ctx)
            throw new InvalidOperationException(
                "GuestSessionContext chưa set. Action phải có [RequireGuestSession].");
        return ctx;
    }
}

/// <summary>
/// Chống replay POST /public-api/*. Header: X-Request-Id + X-Timestamp.
/// Drift ≤ 30s + Request-Id chưa dùng trong 5 phút.
/// </summary>
public sealed class AntiReplayMiddleware
{
    private const string RequestIdHeader = "X-Request-Id";
    private const string TimestampHeader = "X-Timestamp";
    private static readonly TimeSpan MaxDrift  = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan ReplayTtl = TimeSpan.FromMinutes(5);

    private readonly RequestDelegate _next;
    public AntiReplayMiddleware(RequestDelegate next) => _next = next;

    public async Task InvokeAsync(HttpContext context, IAntiReplayStore store)
    {
        var isPublicPost = HttpMethods.IsPost(context.Request.Method)
            && context.Request.Path.StartsWithSegments("/public-api");
        if (!isPublicPost) { await _next(context); return; }

        var reqId = context.Request.Headers[RequestIdHeader].ToString();
        var tsStr = context.Request.Headers[TimestampHeader].ToString();

        if (string.IsNullOrWhiteSpace(reqId) || string.IsNullOrWhiteSpace(tsStr))
        {
            await Deny(context, "missing_antireplay_headers",
                $"Thiếu header {RequestIdHeader} hoặc {TimestampHeader}.");
            return;
        }

        if (!long.TryParse(tsStr, out var tsSeconds))
        {
            await Deny(context, "invalid_timestamp", $"{TimestampHeader} phải là unix seconds.");
            return;
        }

        var drift = DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeSeconds(tsSeconds);
        if (drift < -MaxDrift || drift > MaxDrift)
        {
            await Deny(context, "timestamp_out_of_range",
                $"Client lệch quá {MaxDrift.TotalSeconds}s so với server.");
            return;
        }

        if (!store.TryRegister(reqId, ReplayTtl))
        {
            await Deny(context, "replay_detected", $"Request-Id '{reqId}' đã dùng.");
            return;
        }

        await _next(context);
    }

    private static Task Deny(HttpContext ctx, string code, string message)
    {
        ctx.Response.StatusCode  = (int)HttpStatusCode.BadRequest;
        ctx.Response.ContentType = "application/json; charset=utf-8";
        return ctx.Response.WriteAsync(JsonSerializer.Serialize(new { code, message }));
    }
}

// ─── 2b. Swagger: tự điền X-Request-Id + X-Timestamp cho POST ──────────────

/// <summary>
/// Swagger OperationFilter — tự hiện ô nhập X-Request-Id (mặc định GUID)
/// và X-Timestamp (mặc định unix seconds hiện tại) cho mọi POST /public-api/*.
/// Không cần mở terminal gõ curl để test nữa.
/// </summary>
public sealed class AntiReplaySwaggerFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        // 1. Chỉ áp cho POST
        var httpMethod = context.ApiDescription.HttpMethod;
        var path = context.ApiDescription.RelativePath ?? "";

        if (string.Equals(httpMethod, "POST", StringComparison.OrdinalIgnoreCase) &&
            path.StartsWith("public-api", StringComparison.OrdinalIgnoreCase))
        {
            operation.Parameters ??= new List<OpenApiParameter>();

            if (!operation.Parameters.Any(p => p.Name.Equals("X-Request-Id", StringComparison.OrdinalIgnoreCase)))
            {
                operation.Parameters.Add(new OpenApiParameter
                {
                    Name        = "X-Request-Id",
                    In          = ParameterLocation.Header,
                    Required    = true,
                    Description = "UUID duy nhất cho mỗi request (chống replay). Ví dụ: " + Guid.NewGuid(),
                    Schema      = new OpenApiSchema { Type = "string", Default = new Microsoft.OpenApi.Any.OpenApiString(Guid.NewGuid().ToString()) },
                });
            }

            if (!operation.Parameters.Any(p => p.Name.Equals("X-Timestamp", StringComparison.OrdinalIgnoreCase)))
            {
                operation.Parameters.Add(new OpenApiParameter
                {
                    Name        = "X-Timestamp",
                    In          = ParameterLocation.Header,
                    Required    = true,
                    Description = "Unix timestamp (seconds). Lệch tối đa ±30s so với server.",
                    Schema      = new OpenApiSchema { Type = "string", Default = new Microsoft.OpenApi.Any.OpenApiString(DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString()) },
                });
            }
        }

        // 2. Gắn security requirement cho action hoặc controller có [RequireGuestSession]
        var hasGuestSession = context.MethodInfo.GetCustomAttributes(true).OfType<RequireGuestSessionAttribute>().Any()
            || (context.MethodInfo.DeclaringType?.GetCustomAttributes(true).OfType<RequireGuestSessionAttribute>().Any() ?? false);

        if (hasGuestSession)
        {
            operation.Security ??= new List<OpenApiSecurityRequirement>();
            operation.Security.Add(new OpenApiSecurityRequirement
            {
                [new OpenApiSecurityScheme
                {
                    Reference = new OpenApiReference
                    {
                        Type = ReferenceType.SecurityScheme,
                        Id = "SessionToken"
                    }
                }] = Array.Empty<string>()
            });
        }
    }
}

// ─── 3. Controllers ────────────────────────────────────────────────────────

[ApiController]
[Route("public-api/session")]
public sealed class SessionController : ControllerBase
{
    private readonly SessionService _sessions;
    public SessionController(SessionService sessions) => _sessions = sessions;

    [HttpPost("init")]
    [EnableRateLimiting("session-init")]
    public async Task<ActionResult<SessionInitResponse>> Init(
        [FromBody] InitSessionRequest body, CancellationToken ct)
    {
        var ip = HttpContext.Connection.RemoteIpAddress?.ToString();
        var ua = Request.Headers.UserAgent.ToString();
        return Ok(await _sessions.InitAsync(body, ip, ua, ct));
    }

    [HttpPost("extend")]
    [RequireGuestSession]
    [EnableRateLimiting("session-init")]
    public async Task<ActionResult<SessionExtendResponse>> Extend(CancellationToken ct)
    {
        var s = HttpContext.GetGuestSession();
        return Ok(await _sessions.ExtendAsync(s.TableSessionId, ct));
    }
}

[ApiController]
[Route("public-api/menu")]
public sealed class MenuController : ControllerBase
{
    private readonly MenuService _menu;
    public MenuController(MenuService menu) => _menu = menu;

    [HttpGet]
    [EnableRateLimiting("menu-read")]
    public async Task<ActionResult<MenuDto>> Get(CancellationToken ct)
        => Ok(await _menu.GetAsync(ct));
}

[ApiController]
[Route("public-api/orders")]
[RequireGuestSession]
public sealed class OrderController : ControllerBase
{
    private readonly OrderService _orders;
    public OrderController(OrderService orders) => _orders = orders;

    [HttpPost]
    [EnableRateLimiting("create-order")]
    public async Task<ActionResult<GuestOrderDto>> Create(
        [FromBody] CreateOrderRequest body, CancellationToken ct)
    {
        var s = HttpContext.GetGuestSession();
        var order = await _orders.CreateAsync(s.TableSessionId, s.DeviceSessionId, s.TableCode, body, ct);
        return CreatedAtAction(nameof(GetById), new { id = order.Id }, order);
    }

    [HttpGet("{id:guid}")]
    [EnableRateLimiting("order-status")]
    public async Task<ActionResult<GuestOrderDto>> GetById(Guid id, CancellationToken ct)
    {
        var s = HttpContext.GetGuestSession();
        return Ok(await _orders.GetStatusAsync(id, s.TableSessionId, ct));
    }

    [HttpGet]
    [EnableRateLimiting("order-status")]
    public async Task<ActionResult<IReadOnlyList<GuestOrderDto>>> List(CancellationToken ct)
    {
        var s = HttpContext.GetGuestSession();
        return Ok(await _orders.ListForSessionAsync(s.TableSessionId, ct));
    }
}
