// =============================================================================
//  Services.cs — Application services của module.
//
//  Gồm: SessionService, MenuService, OrderService. Mỗi service orchestrate
//  use case cụ thể, logic nghiệp vụ nằm ở Entity (Domain.cs).
// =============================================================================

using Microsoft.EntityFrameworkCore;
using RestoManager.SharedKernel;

namespace RestoManager.Modules.CustomerOrdering;

// ─── 1. SessionService ──────────────────────────────────────────────────────

/// <summary>Khởi tạo phiên khi khách scan QR + validate token.</summary>
public sealed class SessionService
{
    private readonly CustomerOrderingDbContext _db;
    private readonly MenuReadService _menuRead;
    private readonly IDateTimeProvider _clock;

    public SessionService(CustomerOrderingDbContext db, MenuReadService menuRead, IDateTimeProvider clock)
    {
        _db = db; _menuRead = menuRead; _clock = clock;
    }

    public async Task<SessionInitResponse> InitAsync(
        InitSessionRequest request, string? ipAddress, string? userAgent, CancellationToken ct)
    {
        var now = _clock.UtcNow;

        // 1. Verify QR token (HMAC)
        var qrConfig = await _db.TableQrConfigs
            .FirstOrDefaultAsync(x => x.TableCode == request.TableCode, ct)
            ?? throw new NotFoundException("Bàn", request.TableCode);

        if (!qrConfig.VerifyToken(request.QrToken))
            throw new InvalidQrTokenException(request.TableCode);

        // 2. Load thông tin bàn từ bảng cũ
        var table = await _menuRead.GetTableByCodeAsync(request.TableCode, ct)
            ?? throw new NotFoundException("Bàn", request.TableCode);

        // 3. Tìm hoặc tạo phiên bàn
        var tableSession = await _db.GuestTableSessions
            .FirstOrDefaultAsync(x =>
                x.TableId == table.Id &&
                x.Status == GuestTableSessionStatus.Active, ct);

        if (tableSession is null || !tableSession.IsUsable(now))
        {
            tableSession = GuestTableSession.Start(table.Id, table.Code, now);
            _db.GuestTableSessions.Add(tableSession);
            await _db.SaveChangesAsync(ct);
        }

        // 4. Đăng ký thiết bị mới
        var device = GuestDeviceSession.Register(
            tableSession.Id, request.DeviceFingerprint, ipAddress, userAgent, now);
        _db.GuestDeviceSessions.Add(device);

        // 5. Load menu snapshot
        var categories = (await _menuRead.GetActiveCategoriesAsync(ct))
            .Select(c => new MenuCategoryDto(c.Id, c.Code, c.Name, c.SortOrder)).ToList();
        var items = (await _menuRead.GetActiveItemsAsync(ct))
            .Select(i => new MenuItemDto(i.Id, i.Name, i.Description, i.Price, i.CategoryId, i.Emoji, i.ImageUrl))
            .ToList();

        await _db.SaveChangesAsync(ct);

        return new SessionInitResponse(
            device.SessionToken, tableSession.Id, tableSession.ExpiresAt,
            new TableInfoDto(table.Id, table.Code, table.Zone, table.Capacity),
            categories, items);
    }

    public async Task<(GuestDeviceSession Device, GuestTableSession TableSession)?> ValidateAsync(
        string sessionToken, CancellationToken ct = default)
    {
        var device = await _db.GuestDeviceSessions
            .FirstOrDefaultAsync(x => x.SessionToken == sessionToken, ct);
        if (device is null) return null;

        var tableSession = await _db.GuestTableSessions
            .FirstOrDefaultAsync(x => x.Id == device.TableSessionId, ct);
        if (tableSession is null) return null;

        var now = _clock.UtcNow;
        if (!tableSession.IsUsable(now)) throw new SessionExpiredException();

        device.Touch(now);
        return (device, tableSession);
    }

    public async Task<SessionExtendResponse> ExtendAsync(
        Guid tableSessionId, CancellationToken ct = default)
    {
        var now = _clock.UtcNow;
        var tableSession = await _db.GuestTableSessions
            .FirstOrDefaultAsync(x => x.Id == tableSessionId, ct)
            ?? throw new NotFoundException("Phiên bàn", tableSessionId);

        tableSession.Extend(now, TimeSpan.FromHours(1));
        await _db.SaveChangesAsync(ct);

        return new SessionExtendResponse(tableSession.Id, tableSession.TableCode, tableSession.ExpiresAt, tableSession.Status.ToString());
    }
}

// ─── 2. MenuService ─────────────────────────────────────────────────────────

public sealed class MenuService
{
    private readonly MenuReadService _menuRead;
    public MenuService(MenuReadService menuRead) => _menuRead = menuRead;

    public async Task<MenuDto> GetAsync(CancellationToken ct = default)
    {
        var categories = (await _menuRead.GetActiveCategoriesAsync(ct))
            .Select(c => new MenuCategoryDto(c.Id, c.Code, c.Name, c.SortOrder)).ToList();
        var items = (await _menuRead.GetActiveItemsAsync(ct))
            .Select(i => new MenuItemDto(i.Id, i.Name, i.Description, i.Price, i.CategoryId, i.Emoji, i.ImageUrl))
            .ToList();
        return new MenuDto(categories, items);
    }
}

// ─── 3. OrderService ───────────────────────────────────────────────────────

public sealed class OrderService
{
    /// <summary>VAT 8% — khớp invoices cũ (dùng cho GetReceiptAsync BE-2).</summary>
    private const decimal VatRate = 8.0m;

    private readonly CustomerOrderingDbContext _db;
    private readonly MenuReadService _menuRead;
    private readonly IDateTimeProvider _clock;

    public OrderService(CustomerOrderingDbContext db, MenuReadService menuRead, IDateTimeProvider clock)
    {
        _db = db; _menuRead = menuRead; _clock = clock;
    }

    public async Task<GuestOrderDto> CreateAsync(
        Guid tableSessionId, Guid deviceSessionId, string tableCode,
        CreateOrderRequest request, CancellationToken ct = default)
    {
        var now = _clock.UtcNow;

        var tableSession = await _db.GuestTableSessions
            .FirstOrDefaultAsync(x => x.Id == tableSessionId, ct)
            ?? throw new NotFoundException("Phiên bàn", tableSessionId);
        tableSession.EnsureUsable(now);
        tableSession.ExtendIfNeeded(now); // Auto-extend: nếu còn dưới 60p thì tự gia hạn thêm 60p

        var itemIds = request.Items.Select(i => i.MenuItemId).Distinct().ToList();
        var snapshots = await _menuRead.GetItemsByIdsAsync(itemIds, ct);
        var snapshotMap = snapshots.ToDictionary(s => s.Id);

        foreach (var itemId in itemIds)
        {
            if (!snapshotMap.ContainsKey(itemId))
                throw new NotFoundException("Món", itemId);
        }

        var order = GuestOrder.Create(tableSessionId, deviceSessionId, tableCode, request.Notes, now);
        foreach (var line in request.Items)
        {
            var snap = snapshotMap[line.MenuItemId];
            order.AddItem(snap.Id, snap.Name, line.Quantity, snap.Price, line.Notes, now);
        }
        order.Finalize(now);  // raise GuestOrderCreatedEvent
        _db.GuestOrders.Add(order);

        await _db.SaveChangesAsync(ct);  // commit + dispatch
        return ToDto(order);
    }

    public async Task<GuestOrderDto> GetStatusAsync(Guid orderId, Guid tableSessionId, CancellationToken ct = default)
    {
        var order = await _db.GuestOrders.Include(x => x.Items)
            .FirstOrDefaultAsync(x => x.Id == orderId, ct)
            ?? throw new NotFoundException("Đơn hàng", orderId);

        if (order.TableSessionId != tableSessionId)
            throw new NotFoundException("Đơn hàng", orderId);
        return ToDto(order);
    }

    public async Task<IReadOnlyList<GuestOrderDto>> ListForSessionAsync(
        Guid tableSessionId, CancellationToken ct = default)
    {
        var orders = await _db.GuestOrders.Include(x => x.Items)
            .Where(x => x.TableSessionId == tableSessionId)
            .OrderByDescending(x => x.CreatedAt).ToListAsync(ct);
        return orders.Select(ToDto).ToList();
    }

    // ─── BE-2: tra mã, status polling, hoá đơn, hủy, feedback ─────────────

    /// <summary>Tra đơn qua mã, không auth. Response gọn — không items/notes (chống leak).</summary>
    public async Task<OrderMinimalDto> GetByCodeMinimalAsync(string code, CancellationToken ct = default)
    {
        var order = await _db.GuestOrders.AsNoTracking()
            .FirstOrDefaultAsync(x => x.Code == code, ct)
            ?? throw new NotFoundException("Đơn hàng", code);
        return new OrderMinimalDto(order.Code, order.TableCode,
            order.Status.ToDbString(), order.TotalAmount, order.CreatedAt);
    }

    /// <summary>
    /// Lightweight polling: chỉ trả status + updatedAt. FE-1 poll mỗi 3-5s dùng cái này
    /// thay vì GetStatusAsync để tiết kiệm bandwidth (không bao gồm items).
    /// </summary>
    public async Task<OrderStatusDto> GetStatusMinimalAsync(Guid orderId, Guid tableSessionId, CancellationToken ct = default)
    {
        var order = await _db.GuestOrders.AsNoTracking()
            .Where(x => x.Id == orderId)
            .Select(x => new { x.Id, x.Code, x.Status, x.UpdatedAt, x.ConfirmedAt, x.TableSessionId })
            .FirstOrDefaultAsync(ct)
            ?? throw new NotFoundException("Đơn hàng", orderId);

        if (order.TableSessionId != tableSessionId)
            throw new NotFoundException("Đơn hàng", orderId);

        return new OrderStatusDto(order.Id, order.Code,
            order.Status.ToDbString(), order.UpdatedAt, order.ConfirmedAt);
    }

    public async Task<OrderReceiptDto> GetReceiptAsync(Guid orderId, Guid tableSessionId, CancellationToken ct = default)
    {
        var order = await _db.GuestOrders.Include(x => x.Items)
            .FirstOrDefaultAsync(x => x.Id == orderId, ct)
            ?? throw new NotFoundException("Đơn hàng", orderId);
        if (order.TableSessionId != tableSessionId)
            throw new NotFoundException("Đơn hàng", orderId);

        var subtotal = order.TotalAmount;
        var vat = decimal.Round(subtotal * VatRate / 100m, 2);
        return new OrderReceiptDto(
            order.Code, order.TableCode, order.Status.ToDbString(),
            order.Items.Select(i => new GuestOrderItemDto(
                i.Id, i.MenuItemId, i.ItemName, i.Quantity, i.Price, i.TotalPrice, i.Notes)).ToList(),
            subtotal, VatRate, vat, subtotal + vat,
            order.CreatedAt, order.ConfirmedAt);
    }

    public async Task<GuestOrderDto> CancelAsync(
        Guid orderId, Guid tableSessionId, string? reason, CancellationToken ct = default)
    {
        var order = await _db.GuestOrders.Include(x => x.Items)
            .FirstOrDefaultAsync(x => x.Id == orderId, ct)
            ?? throw new NotFoundException("Đơn hàng", orderId);
        if (order.TableSessionId != tableSessionId)
            throw new NotFoundException("Đơn hàng", orderId);

        if (order.Status != GuestOrderStatus.PendingConfirmation)
            throw new InvalidOrderStateException(
                "Đơn đã được xác nhận. Vui lòng gọi nhân viên nếu muốn hủy.");

        order.TransitionTo(GuestOrderStatus.Cancelled, _clock.UtcNow);
        _ = reason; // reserved: nếu sau thêm cột cancellation_reason, dùng tại đây
        await _db.SaveChangesAsync(ct);
        return ToDto(order);
    }

    public async Task<GuestOrderFeedback> SubmitFeedbackAsync(
        Guid orderId, Guid tableSessionId, OrderFeedbackRequest request, CancellationToken ct = default)
    {
        var order = await _db.GuestOrders
            .FirstOrDefaultAsync(x => x.Id == orderId, ct)
            ?? throw new NotFoundException("Đơn hàng", orderId);
        if (order.TableSessionId != tableSessionId)
            throw new NotFoundException("Đơn hàng", orderId);

        if (order.Status != GuestOrderStatus.Served)
            throw new InvalidOrderStateException(
                "Chỉ có thể đánh giá sau khi đã được phục vụ xong.");

        var exists = await _db.GuestOrderFeedbacks
            .AnyAsync(x => x.GuestOrderId == orderId, ct);
        if (exists)
            throw new InvalidOrderStateException("Đơn này đã được đánh giá rồi.");

        var fb = GuestOrderFeedback.Create(orderId, request.Rating, request.Comment, _clock.UtcNow);
        _db.GuestOrderFeedbacks.Add(fb);
        await _db.SaveChangesAsync(ct);
        return fb;
    }

    internal static GuestOrderDto ToDto(GuestOrder o)
        => new(o.Id, o.Code, o.TableCode, o.Status.ToDbString(),
            o.TotalAmount, o.Notes, o.CreatedAt, o.ConfirmedAt,
            o.Items.Select(i => new GuestOrderItemDto(
                i.Id, i.MenuItemId, i.ItemName, i.Quantity, i.Price, i.TotalPrice, i.Notes)).ToList());
}

// ─── 4. BE-2: StaffCallService ──────────────────────────────────────────────

public sealed class StaffCallService
{
    private readonly CustomerOrderingDbContext _db;
    private readonly IDateTimeProvider _clock;

    public StaffCallService(CustomerOrderingDbContext db, IDateTimeProvider clock)
    {
        _db = db; _clock = clock;
    }

    public async Task<StaffCallDto> CreateAsync(
        Guid tableSessionId, string tableCode, CreateStaffCallRequest request, CancellationToken ct = default)
    {
        var now = _clock.UtcNow;

        var session = await _db.GuestTableSessions
            .FirstOrDefaultAsync(x => x.Id == tableSessionId, ct)
            ?? throw new NotFoundException("Phiên bàn", tableSessionId);
        session.EnsureUsable(now);

        var call = StaffCall.Create(tableSessionId, tableCode, request.Reason, now);
        _db.StaffCalls.Add(call);
        await _db.SaveChangesAsync(ct);

        return new StaffCallDto(call.Id, call.TableCode, call.Reason,
            call.Status.ToDbString(), call.CreatedAt);
    }
}
