using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.OpenApi.Models;
using RestoManager.Modules.CustomerOrdering;
using RestoManager.SharedKernel;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

// ─── 1. Logging ─────────────────────────────────────────────────────────────
builder.Host.UseSerilog((ctx, cfg) =>
{
    cfg.ReadFrom.Configuration(ctx.Configuration)
       .Enrich.FromLogContext()
       .WriteTo.Console();
});

// ─── 2. SharedKernel + Modules (Buổi 12 Modular Monolith) ──────────────────
builder.Services.AddSharedKernel();

// Thêm module mới? Tạo class implement IModule rồi thêm 1 dòng vào mảng dưới.
IModule[] modules =
[
    new CustomerOrderingModule(),
    // new BillingModule(),       // tương lai
    // new NotificationModule(),  // tương lai
];
foreach (var m in modules)
    m.Register(builder.Services, builder.Configuration);

// ─── 3. Infra chung ────────────────────────────────────────────────────────
builder.Services.Configure<ForwardedHeadersOptions>(opt =>
{
    opt.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    opt.KnownNetworks.Clear();
    opt.KnownProxies.Clear();
});

var corsOrigins = builder.Configuration
    .GetSection("Security:AllowedOrigins")
    .Get<string[]>() ?? Array.Empty<string>();

builder.Services.AddCors(options =>
{
    options.AddPolicy("CustomerApp", policy =>
    {
        if (corsOrigins.Length == 0)
        {
            policy.AllowAnyOrigin().AllowAnyHeader().WithMethods("GET", "POST");
        }
        else
        {
            policy.WithOrigins(corsOrigins).AllowAnyHeader()
                .WithMethods("GET", "POST")
                .SetPreflightMaxAge(TimeSpan.FromHours(1));
        }
    });
});

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new OpenApiInfo
    {
        Title = "RestoManager Customer API",
        Version = "v1",
        Description = "Modular Monolith · Module CustomerOrdering · Khách gọi món qua QR.",
    });
    c.AddSecurityDefinition("SessionToken", new OpenApiSecurityScheme
    {
        Name = RequireGuestSessionAttribute.HeaderName,
        Type = SecuritySchemeType.ApiKey,
        In = ParameterLocation.Header,
        Description = "Session token từ POST /public-api/session/init",
    });

    // Tự điền X-Request-Id + X-Timestamp cho POST /public-api/* trên Swagger UI
    c.OperationFilter<AntiReplaySwaggerFilter>();
});

var app = builder.Build();

// ─── 4. Pipeline ───────────────────────────────────────────────────────────
app.UseMiddleware<ExceptionHandlingMiddleware>();
app.UseMiddleware<SecurityHeadersMiddleware>();
app.UseForwardedHeaders();
app.UseSerilogRequestLogging();
app.UseCors("CustomerApp");
app.UseRateLimiter();
app.UseMiddleware<AntiReplayMiddleware>();  // module CustomerOrdering

if (app.Environment.IsDevelopment() || app.Environment.EnvironmentName == "Staging")
{
    app.UseSwagger();
    app.UseSwaggerUI(c => c.SwaggerEndpoint("/swagger/v1/swagger.json", "Customer API v1"));
}

foreach (var m in modules) m.MapEndpoints(app);

app.MapControllers();
app.MapGet("/public-api/health", () => Results.Ok(new { status = "ok", ts = DateTimeOffset.UtcNow }));

app.Run();
