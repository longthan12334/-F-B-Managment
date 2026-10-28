// =============================================================================
//  Infrastructure.cs — DbContext + helper service kỹ thuật của module.
//
//  Gồm:
//   - CustomerOrderingDbContext      (EF Core, map 5 bảng, dispatch events sau save)
//   - MenuReadService                 (đọc bảng cũ qua Npgsql trực tiếp)
//   - IAntiReplayStore + Memory impl (chống replay POST request)
//   - SessionCleanupService           (background job expire phiên 3h)
// =============================================================================

using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Npgsql;
using RestoManager.SharedKernel;

namespace RestoManager.Modules.CustomerOrdering;

// ─── 1. DbContext của module ────────────────────────────────────────────────

/// <summary>
/// DbContext RIÊNG của module (Buổi 12 Modular Monolith).
/// SaveChangesAsync override: gom DomainEvents từ entities → dispatch qua IEventBus
/// SAU khi commit thành công.
/// </summary>
public sealed class CustomerOrderingDbContext : DbContext
{
    private readonly IEventBus _eventBus;
    private readonly ILogger<CustomerOrderingDbContext> _logger;

    public CustomerOrderingDbContext(
        DbContextOptions<CustomerOrderingDbContext> options,
        IEventBus eventBus,
        ILogger<CustomerOrderingDbContext> logger) : base(options)
    {
        _eventBus = eventBus;
        _logger = logger;
    }

    public DbSet<TableQrConfig> TableQrConfigs => Set<TableQrConfig>();
    public DbSet<GuestTableSession> GuestTableSessions => Set<GuestTableSession>();
    public DbSet<GuestDeviceSession> GuestDeviceSessions => Set<GuestDeviceSession>();
    public DbSet<GuestOrder> GuestOrders => Set<GuestOrder>();
    public DbSet<GuestOrderItem> GuestOrderItems => Set<GuestOrderItem>();
    // BE-2
    public DbSet<GuestOrderFeedback> GuestOrderFeedbacks => Set<GuestOrderFeedback>();
    public DbSet<StaffCall> StaffCalls => Set<StaffCall>();

    private static IPAddress? ParseIp(string? v) =>
        string.IsNullOrWhiteSpace(v) ? null : (IPAddress.TryParse(v, out var ip) ? ip : null);

    protected override void OnModelCreating(ModelBuilder mb)
    {
        base.OnModelCreating(mb);

        mb.Entity<TableQrConfig>(b =>
        {
            b.ToTable("table_qr_configs");
            b.HasKey(x => x.Id); b.Property(x => x.Id).HasColumnName("id");
            b.Property(x => x.TableId).HasColumnName("table_id").IsRequired();
            b.Property(x => x.TableCode).HasColumnName("table_code").IsRequired();
            b.Property(x => x.QrSecret).HasColumnName("qr_secret").IsRequired();
            b.Property(x => x.IsActive).HasColumnName("is_active").IsRequired();
            b.Property(x => x.CreatedAt).HasColumnName("created_at").IsRequired();
            b.Property(x => x.UpdatedAt).HasColumnName("updated_at").IsRequired();
            b.Ignore(x => x.DomainEvents);
            b.HasIndex(x => x.TableId).IsUnique();
            b.HasIndex(x => x.TableCode);
        });

        mb.Entity<GuestTableSession>(b =>
        {
            b.ToTable("guest_table_sessions");
            b.HasKey(x => x.Id); b.Property(x => x.Id).HasColumnName("id");
            b.Property(x => x.TableId).HasColumnName("table_id").IsRequired();
            b.Property(x => x.TableCode).HasColumnName("table_code").IsRequired();
            b.Property(x => x.Status).HasColumnName("status")
                .HasConversion(v => v.ToDbString(), v => v.ToTableSessionStatus()).IsRequired();
            b.Property(x => x.StartedAt).HasColumnName("started_at").IsRequired();
            b.Property(x => x.CompletedAt).HasColumnName("completed_at");
            b.Property(x => x.ExpiresAt).HasColumnName("expires_at").IsRequired();
            b.Property(x => x.CreatedAt).HasColumnName("created_at").IsRequired();
            b.Ignore(x => x.DomainEvents);
            b.HasIndex(x => x.TableId);
            b.HasIndex(x => x.Status);
            b.HasIndex(x => x.ExpiresAt);
        });

        mb.Entity<GuestDeviceSession>(b =>
        {
            b.ToTable("guest_device_sessions");
            b.HasKey(x => x.Id); b.Property(x => x.Id).HasColumnName("id");
            b.Property(x => x.TableSessionId).HasColumnName("table_session_id").IsRequired();
            b.Property(x => x.SessionToken).HasColumnName("session_token").IsRequired();
            b.Property(x => x.DeviceFingerprint).HasColumnName("device_fingerprint");
            b.Property(x => x.IpAddress).HasColumnName("ip_address")
                .HasConversion(v => ParseIp(v), v => v == null ? null : v.ToString());
            b.Property(x => x.UserAgent).HasColumnName("user_agent");
            b.Property(x => x.LastActiveAt).HasColumnName("last_active_at").IsRequired();
            b.Property(x => x.CreatedAt).HasColumnName("created_at").IsRequired();
            b.Ignore(x => x.DomainEvents);
            b.HasIndex(x => x.SessionToken).IsUnique();
            b.HasIndex(x => x.TableSessionId);
            b.HasOne<GuestTableSession>().WithMany().HasForeignKey(x => x.TableSessionId);
        });

        mb.Entity<GuestOrder>(b =>
        {
            b.ToTable("guest_orders");
            b.HasKey(x => x.Id); b.Property(x => x.Id).HasColumnName("id");
            b.Property(x => x.Code).HasColumnName("code").IsRequired();
            b.Property(x => x.TableSessionId).HasColumnName("table_session_id").IsRequired();
            b.Property(x => x.DeviceSessionId).HasColumnName("device_session_id").IsRequired();
            b.HasOne<GuestTableSession>().WithMany().HasForeignKey(x => x.TableSessionId);
            b.HasOne<GuestDeviceSession>().WithMany().HasForeignKey(x => x.DeviceSessionId);
            b.Property(x => x.TableCode).HasColumnName("table_code").IsRequired();
            b.Property(x => x.Status).HasColumnName("status")
                .HasConversion(v => v.ToDbString(), v => v.ToOrderStatus()).IsRequired();
            b.Property(x => x.TotalAmount).HasColumnName("total_amount")
                .HasColumnType("numeric(12,2)").IsRequired();
            b.Property(x => x.Notes).HasColumnName("notes");
            b.Property(x => x.ConfirmedBy).HasColumnName("confirmed_by");
            b.Property(x => x.ConfirmedAt).HasColumnName("confirmed_at");
            b.Property(x => x.CreatedAt).HasColumnName("created_at").IsRequired();
            b.Property(x => x.UpdatedAt).HasColumnName("updated_at").IsRequired();
            b.Ignore(x => x.DomainEvents);
            b.HasIndex(x => x.Code).IsUnique();
            b.HasIndex(x => x.TableSessionId);
            b.HasIndex(x => x.Status);

            b.Metadata.FindNavigation(nameof(GuestOrder.Items))!
                .SetPropertyAccessMode(PropertyAccessMode.Field);
            b.HasMany(x => x.Items).WithOne()
                .HasForeignKey(i => i.GuestOrderId).OnDelete(DeleteBehavior.Cascade);
        });

        mb.Entity<GuestOrderItem>(b =>
        {
            b.ToTable("guest_order_items");
            b.HasKey(x => x.Id); b.Property(x => x.Id).HasColumnName("id");
            b.Property(x => x.GuestOrderId).HasColumnName("guest_order_id").IsRequired();
            b.Property(x => x.MenuItemId).HasColumnName("menu_item_id").IsRequired();
            b.Property(x => x.ItemName).HasColumnName("item_name").IsRequired();
            b.Property(x => x.Quantity).HasColumnName("quantity").IsRequired();
            b.Property(x => x.Price).HasColumnName("price")
                .HasColumnType("numeric(12,2)").IsRequired();
            b.Property(x => x.TotalPrice).HasColumnName("total_price")
                .HasColumnType("numeric(12,2)").IsRequired();
            b.Property(x => x.Notes).HasColumnName("notes");
            b.Property(x => x.CreatedAt).HasColumnName("created_at").IsRequired();
            b.Ignore(x => x.DomainEvents);
            b.HasIndex(x => x.GuestOrderId);
        });
        // BE-2
        mb.Entity<GuestOrderFeedback>(b =>
        {
            b.ToTable("guest_order_feedback");
            b.HasKey(x => x.Id); b.Property(x => x.Id).HasColumnName("id");
            b.Property(x => x.GuestOrderId).HasColumnName("guest_order_id").IsRequired();
            b.Property(x => x.Rating).HasColumnName("rating").IsRequired();
            b.Property(x => x.Comment).HasColumnName("comment");
            b.Property(x => x.CreatedAt).HasColumnName("created_at").IsRequired();
            b.Ignore(x => x.DomainEvents);
            b.HasIndex(x => x.GuestOrderId).IsUnique();
        });

        mb.Entity<StaffCall>(b =>
        {
            b.ToTable("staff_calls");
            b.HasKey(x => x.Id); b.Property(x => x.Id).HasColumnName("id");
            b.Property(x => x.TableSessionId).HasColumnName("table_session_id").IsRequired();
            b.Property(x => x.TableCode).HasColumnName("table_code").IsRequired();
            b.Property(x => x.Reason).HasColumnName("reason").IsRequired();
            b.Property(x => x.Status).HasColumnName("status")
                .HasConversion(v => v.ToDbString(), v => v.ToStaffCallStatus()).IsRequired();
            b.Property(x => x.AcknowledgedBy).HasColumnName("acknowledged_by");
            b.Property(x => x.AcknowledgedAt).HasColumnName("acknowledged_at");
            b.Property(x => x.CreatedAt).HasColumnName("created_at").IsRequired();
            b.Ignore(x => x.DomainEvents);
            b.HasIndex(x => x.TableSessionId);
            b.HasIndex(x => x.Status);
        });
    }

    public override async Task<int> SaveChangesAsync(CancellationToken cancellationToken = default)
    {
        var entities = ChangeTracker.Entries<Entity>()
            .Where(e => e.Entity.DomainEvents.Count > 0)
            .Select(e => e.Entity)
            .ToList();

        var events = entities.SelectMany(e => e.DomainEvents).ToList();
        entities.ForEach(e => e.ClearDomainEvents());

        var affected = await base.SaveChangesAsync(cancellationToken);

        foreach (var evt in events)
        {
            try { await _eventBus.PublishAsync((dynamic)evt, cancellationToken); }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to publish event {EventType}", evt.GetType().Name);
            }
        }
        return affected;
    }
}

// ─── 2. Đọc bảng menu CŨ qua Npgsql ────────────────────────────────────────

/// <summary>Snapshot bàn.</summary>
public sealed record TableSnapshot(Guid Id, string Code, string Zone, int Capacity, bool IsActive);

/// <summary>
/// Đọc menu + table từ bảng cũ (Node.js staff backend ghi). Dùng Npgsql trực tiếp
/// vì bảng cũ không thuộc module này — không scaffold entity.
/// </summary>
public sealed class MenuReadService
{
    private readonly CustomerOrderingDbContext _db;
    public MenuReadService(CustomerOrderingDbContext db) => _db = db;

    public async Task<IReadOnlyList<(Guid Id, string Code, string Name, int SortOrder)>>
        GetActiveCategoriesAsync(CancellationToken ct = default)
    {
        var conn = await OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT id, code, name, sort_order FROM menu_categories ORDER BY sort_order, name";
        var result = new List<(Guid, string, string, int)>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
            result.Add((r.GetGuid(0), r.GetString(1), r.GetString(2), r.GetInt32(3)));
        return result;
    }

    public async Task<IReadOnlyList<MenuItemSnapshot>> GetActiveItemsAsync(CancellationToken ct = default)
    {
        var conn = await OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            SELECT id, name, description, price, category_id, emoji, image_url
              FROM menu_items WHERE is_active = TRUE ORDER BY name";
        return await ReadItemsAsync(cmd, ct);
    }

    public async Task<IReadOnlyList<MenuItemSnapshot>> GetItemsByIdsAsync(
        IReadOnlyCollection<Guid> itemIds, CancellationToken ct = default)
    {
        if (itemIds is null || itemIds.Count == 0) return Array.Empty<MenuItemSnapshot>();
        var conn = await OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            SELECT id, name, description, price, category_id, emoji, image_url
              FROM menu_items WHERE id = ANY(@ids) AND is_active = TRUE";
        cmd.Parameters.Add(new NpgsqlParameter("@ids", itemIds.ToArray()));
        return await ReadItemsAsync(cmd, ct);
    }

    public async Task<TableSnapshot?> GetTableByCodeAsync(string tableCode, CancellationToken ct = default)
    {
        var conn = await OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT id, code, zone, capacity, is_active FROM tables WHERE code = @c LIMIT 1";
        cmd.Parameters.Add(new NpgsqlParameter("@c", tableCode));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        return new TableSnapshot(r.GetGuid(0), r.GetString(1), r.GetString(2),
            r.GetInt32(3), r.GetBoolean(4));
    }

    private async Task<NpgsqlConnection> OpenAsync(CancellationToken ct)
    {
        var conn = (NpgsqlConnection)_db.Database.GetDbConnection();
        if (conn.State != System.Data.ConnectionState.Open) await conn.OpenAsync(ct);
        return conn;
    }

    private static async Task<IReadOnlyList<MenuItemSnapshot>> ReadItemsAsync(
        NpgsqlCommand cmd, CancellationToken ct)
    {
        var result = new List<MenuItemSnapshot>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
        {
            result.Add(new MenuItemSnapshot(
                r.GetGuid(0), r.GetString(1),
                r.IsDBNull(2) ? null : r.GetString(2),
                r.GetDecimal(3),
                r.IsDBNull(4) ? null : (Guid?)r.GetGuid(4),
                r.IsDBNull(5) ? null : r.GetString(5),
                r.IsDBNull(6) ? null : r.GetString(6)));
        }
        return result;
    }
}

public sealed record MenuItemSnapshot(
    Guid Id, string Name, string? Description, decimal Price,
    Guid? CategoryId, string? Emoji, string? ImageUrl);

// ─── 3. Anti-replay store ───────────────────────────────────────────────────

public interface IAntiReplayStore
{
    bool TryRegister(string requestId, TimeSpan ttl);
}

public sealed class MemoryAntiReplayStore : IAntiReplayStore
{
    private readonly IMemoryCache _cache;
    public MemoryAntiReplayStore(IMemoryCache cache) => _cache = cache;

    public bool TryRegister(string requestId, TimeSpan ttl)
    {
        var key = $"replay:{requestId}";
        if (_cache.TryGetValue(key, out _)) return false;
        _cache.Set(key, true, ttl);
        return true;
    }
}

// ─── 4. Background: expire session quá 3h ──────────────────────────────────

public sealed class SessionCleanupService : BackgroundService
{
    private const int BatchSize = 100;
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(60);

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<SessionCleanupService> _logger;

    public SessionCleanupService(IServiceScopeFactory scopeFactory,
        ILogger<SessionCleanupService> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("[CustomerOrdering] SessionCleanup started. Interval = {Interval}", Interval);
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await ExpireOnceAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { _logger.LogError(ex, "SessionCleanup tick failed."); }

            try { await Task.Delay(Interval, stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task ExpireOnceAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db    = scope.ServiceProvider.GetRequiredService<CustomerOrderingDbContext>();
        var clock = scope.ServiceProvider.GetRequiredService<IDateTimeProvider>();
        var now = clock.UtcNow;

        var expired = await db.GuestTableSessions
            .Where(x => x.Status == GuestTableSessionStatus.Active && x.ExpiresAt < now)
            .OrderBy(x => x.ExpiresAt).Take(BatchSize).ToListAsync(ct);

        if (expired.Count == 0) return;
        foreach (var s in expired) s.Expire(now);
        await db.SaveChangesAsync(ct);
        _logger.LogInformation("Expired {Count} guest table sessions.", expired.Count);
    }
}
