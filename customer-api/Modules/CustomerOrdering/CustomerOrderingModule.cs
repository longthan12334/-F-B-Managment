// =============================================================================
//  CustomerOrderingModule.cs — Module registration (Buổi 12).
//
//  Program.cs chỉ gọi: new CustomerOrderingModule().Register(services, config)
//  Thêm module mới = tạo class implement IModule + thêm 1 dòng vào Program.cs.
// =============================================================================

using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using RestoManager.SharedKernel;

namespace RestoManager.Modules.CustomerOrdering;

public sealed class CustomerOrderingModule : IModule
{
    public string Name => "CustomerOrdering";

    public void Register(IServiceCollection services, IConfiguration configuration)
    {
        // 1. DbContext riêng của module
        var cs = configuration.GetConnectionString("DefaultConnection")
            ?? throw new InvalidOperationException("Thiếu ConnectionStrings:DefaultConnection.");

        services.AddDbContext<CustomerOrderingDbContext>(opt =>
            opt.UseNpgsql(cs, npgsql => npgsql.EnableRetryOnFailure(3)));

        // 2. Services
        services.AddScoped<MenuReadService>();
        services.AddScoped<MenuService>();
        services.AddScoped<SessionService>();
        services.AddScoped<OrderService>();
        services.AddScoped<StaffCallService>();   // BE-2

        // 3. Infrastructure
        services.AddMemoryCache();
        services.AddSingleton<IAntiReplayStore, MemoryAntiReplayStore>();
        services.AddHostedService<SessionCleanupService>();

        // 4. Rate limit policies của module
        services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

            options.AddPolicy("session-init", http =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 5, Window = TimeSpan.FromMinutes(1), QueueLimit = 0,
                    }));

            options.AddPolicy("menu-read", http =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 30, Window = TimeSpan.FromMinutes(1), QueueLimit = 0,
                    }));

            options.AddPolicy("create-order", http =>
            {
                var token = http.Request.Headers[RequireGuestSessionAttribute.HeaderName].ToString();
                var key = !string.IsNullOrEmpty(token) ? $"sess:{token}" : $"ip:{http.Connection.RemoteIpAddress}";
                return RateLimitPartition.GetFixedWindowLimiter(key,
                    _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 3, Window = TimeSpan.FromMinutes(1), QueueLimit = 0,
                    });
            });

            options.AddPolicy("order-status", http =>
            {
                var token = http.Request.Headers[RequireGuestSessionAttribute.HeaderName].ToString();
                var key = !string.IsNullOrEmpty(token) ? $"sess:{token}" : $"ip:{http.Connection.RemoteIpAddress}";
                return RateLimitPartition.GetFixedWindowLimiter(key,
                    _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 20, Window = TimeSpan.FromMinutes(1), QueueLimit = 0,
                    });
            });

            // BE-2: gọi nhân viên — chặt (2/phút/session) chống spam.
            options.AddPolicy("call-staff", http =>
            {
                var token = http.Request.Headers[RequireGuestSessionAttribute.HeaderName].ToString();
                var key = !string.IsNullOrEmpty(token) ? $"sess:{token}" : $"ip:{http.Connection.RemoteIpAddress}";
                return RateLimitPartition.GetFixedWindowLimiter(key,
                    _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 2, Window = TimeSpan.FromMinutes(1), QueueLimit = 0,
                    });
            });
        });
    }

    public void MapEndpoints(WebApplication app)
    {
        // Module này dùng attribute routing qua Controllers nên không cần map thêm.
    }
}
