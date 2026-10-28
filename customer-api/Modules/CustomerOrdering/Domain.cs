// =============================================================================
//  Domain.cs — Mọi thứ Domain của module CustomerOrdering gộp 1 file.
//
//  Gồm: 5 Entity + 2 Enum + 2 ValueObject + 4 Exception + 1 Event.
//  Lí do gộp: scope nhỏ (5 entity), dễ nhìn tổng thể hơn 10 file nhỏ.
//
//  Thứ tự: Enum → ValueObject → Exception → Event → Entity.
// =============================================================================

using System.Security.Cryptography;
using System.Text;
using RestoManager.SharedKernel;

namespace RestoManager.Modules.CustomerOrdering;

// ─── 1. Enums + mapping ─────────────────────────────────────────────────────

public enum GuestTableSessionStatus { Active = 0, Completed = 1, Expired = 2 }

public enum GuestOrderStatus
{
    PendingConfirmation = 0,
    Confirmed = 1,
    Preparing = 2,
    Served = 3,
    Cancelled = 4,
}

// BE-2
public enum StaffCallStatus { Pending = 0, Acknowledged = 1, Done = 2 }

public static class EnumMappings
{
    public static string ToDbString(this GuestTableSessionStatus s) => s switch
    {
        GuestTableSessionStatus.Active    => "active",
        GuestTableSessionStatus.Completed => "completed",
        GuestTableSessionStatus.Expired   => "expired",
        _ => throw new ArgumentOutOfRangeException(nameof(s), s, null),
    };

    public static GuestTableSessionStatus ToTableSessionStatus(this string v) => v switch
    {
        "active" => GuestTableSessionStatus.Active,
        "completed" => GuestTableSessionStatus.Completed,
        "expired" => GuestTableSessionStatus.Expired,
        _ => throw new ArgumentException($"session status '{v}' không hợp lệ.", nameof(v)),
    };

    public static string ToDbString(this GuestOrderStatus s) => s switch
    {
        GuestOrderStatus.PendingConfirmation => "pending_confirmation",
        GuestOrderStatus.Confirmed           => "confirmed",
        GuestOrderStatus.Preparing           => "preparing",
        GuestOrderStatus.Served              => "served",
        GuestOrderStatus.Cancelled           => "cancelled",
        _ => throw new ArgumentOutOfRangeException(nameof(s), s, null),
    };

    public static GuestOrderStatus ToOrderStatus(this string v) => v switch
    {
        "pending_confirmation" => GuestOrderStatus.PendingConfirmation,
        "confirmed" => GuestOrderStatus.Confirmed,
        "preparing" => GuestOrderStatus.Preparing,
        "served"    => GuestOrderStatus.Served,
        "cancelled" => GuestOrderStatus.Cancelled,
        _ => throw new ArgumentException($"order status '{v}' không hợp lệ.", nameof(v)),
    };

    /// <summary>Transition rules tập trung 1 chỗ (OCP — Buổi 2-3).</summary>
    public static bool CanTransitionTo(this GuestOrderStatus from, GuestOrderStatus to)
        => (from, to) switch
        {
            (GuestOrderStatus.PendingConfirmation, GuestOrderStatus.Confirmed)  => true,
            (GuestOrderStatus.PendingConfirmation, GuestOrderStatus.Cancelled)  => true,
            (GuestOrderStatus.Confirmed,           GuestOrderStatus.Preparing)  => true,
            (GuestOrderStatus.Confirmed,           GuestOrderStatus.Cancelled)  => true,
            (GuestOrderStatus.Preparing,           GuestOrderStatus.Served)     => true,
            (GuestOrderStatus.Preparing,           GuestOrderStatus.Cancelled)  => true,
            _ => false,
        };
    // BE-2: StaffCallStatus mapping
    public static string ToDbString(this StaffCallStatus s) => s switch
    {
        StaffCallStatus.Pending      => "pending",
        StaffCallStatus.Acknowledged => "acknowledged",
        StaffCallStatus.Done         => "done",
        _ => throw new ArgumentOutOfRangeException(nameof(s), s, null),
    };

    public static StaffCallStatus ToStaffCallStatus(this string v) => v switch
    {
        "pending"      => StaffCallStatus.Pending,
        "acknowledged" => StaffCallStatus.Acknowledged,
        "done"         => StaffCallStatus.Done,
        _ => throw new ArgumentException($"staff call status '{v}' không hợp lệ.", nameof(v)),
    };
}

// ─── 2. Value Objects ───────────────────────────────────────────────────────

public readonly record struct SessionToken
{
    public const int ByteLength = 32;
    public const int HexLength  = ByteLength * 2;

    public string Value { get; }
    private SessionToken(string value) => Value = value;

    public static SessionToken Generate()
    {
        Span<byte> bytes = stackalloc byte[ByteLength];
        RandomNumberGenerator.Fill(bytes);
        return new SessionToken(Convert.ToHexString(bytes).ToLowerInvariant());
    }

    public static bool TryParse(string? value, out SessionToken token)
    {
        token = default;
        if (string.IsNullOrEmpty(value) || value.Length != HexLength) return false;
        foreach (var c in value)
        {
            var isHex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
            if (!isHex) return false;
        }
        token = new SessionToken(value.ToLowerInvariant());
        return true;
    }

    public override string ToString() => Value;
}

public readonly record struct QrToken
{
    public string Value { get; }
    private QrToken(string value) => Value = value;

    public static QrToken Compute(string tableCode, string qrSecret)
    {
        if (string.IsNullOrWhiteSpace(tableCode))
            throw new ArgumentException("tableCode rỗng.", nameof(tableCode));
        if (string.IsNullOrWhiteSpace(qrSecret))
            throw new ArgumentException("qrSecret rỗng.", nameof(qrSecret));

        var key  = Encoding.UTF8.GetBytes(qrSecret);
        var data = Encoding.UTF8.GetBytes(tableCode);
        using var hmac = new HMACSHA256(key);
        return new QrToken(Convert.ToHexString(hmac.ComputeHash(data)).ToLowerInvariant());
    }

    /// <summary>FixedTimeEquals chống timing attack.</summary>
    public static bool Verify(string tableCode, string qrSecret, string suppliedToken)
    {
        if (string.IsNullOrWhiteSpace(suppliedToken)) return false;
        try
        {
            var expected      = Compute(tableCode, qrSecret);
            var expectedBytes = Convert.FromHexString(expected.Value);
            var suppliedBytes = Convert.FromHexString(suppliedToken.ToLowerInvariant());
            if (expectedBytes.Length != suppliedBytes.Length) return false;
            return CryptographicOperations.FixedTimeEquals(expectedBytes, suppliedBytes);
        }
        catch (FormatException) { return false; }
    }

    public override string ToString() => Value;
}

// ─── 3. Exceptions ──────────────────────────────────────────────────────────

public sealed class InvalidQrTokenException : DomainException
{
    public override string Code => "invalid_qr_token";
    public InvalidQrTokenException(string tableCode)
        : base($"QR token cho bàn '{tableCode}' không hợp lệ.") { }
}

public sealed class SessionExpiredException : DomainException
{
    public override string Code => "session_expired";
    public SessionExpiredException()
        : base("Phiên gọi món đã hết hạn. Vui lòng quét lại mã QR.") { }
}

public sealed class InvalidOrderStateException : DomainException
{
    public override string Code => "invalid_order_state";
    public InvalidOrderStateException(string message) : base(message) { }
}

public sealed class NotFoundException : DomainException
{
    public override string Code => "not_found";
    public string EntityName { get; }
    public object? Key { get; }
    public NotFoundException(string entityName, object? key)
        : base($"Không tìm thấy {entityName}" + (key is null ? "." : $" '{key}'."))
    {
        EntityName = entityName;
        Key = key;
    }
}

// ─── 4. Domain Events ───────────────────────────────────────────────────────

/// <summary>
/// Phát khi GuestOrder.Finalize() — Module khác (Billing, Notification tương lai)
/// implement IEventHandler&lt;GuestOrderCreatedEvent&gt; để subscribe.
/// </summary>
public sealed record GuestOrderCreatedEvent(
    Guid GuestOrderId,
    string OrderCode,
    Guid TableSessionId,
    string TableCode,
    decimal TotalAmount,
    DateTimeOffset OccurredAt
) : IDomainEvent;

// ─── 5. Entities (5 aggregate) ──────────────────────────────────────────────

/// <summary>Cấu hình QR cho một bàn.</summary>
public sealed class TableQrConfig : Entity
{
    public Guid TableId { get; private set; }
    public string TableCode { get; private set; } = string.Empty;
    public string QrSecret { get; private set; } = string.Empty;
    public bool IsActive { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }

    private TableQrConfig() { }
    private TableQrConfig(Guid id, Guid tableId, string tableCode, string qrSecret, DateTimeOffset now)
        : base(id)
    {
        TableId = tableId; TableCode = tableCode; QrSecret = qrSecret;
        IsActive = true; CreatedAt = now; UpdatedAt = now;
    }

    public static TableQrConfig Create(Guid tableId, string tableCode, DateTimeOffset now)
    {
        if (tableId == Guid.Empty) throw new ArgumentException("tableId rỗng.", nameof(tableId));
        if (string.IsNullOrWhiteSpace(tableCode))
            throw new ArgumentException("tableCode rỗng.", nameof(tableCode));
        return new TableQrConfig(Guid.NewGuid(), tableId, tableCode, GenerateSecret(), now);
    }

    public void RegenerateSecret(DateTimeOffset now) { QrSecret = GenerateSecret(); UpdatedAt = now; }

    public bool VerifyToken(string suppliedToken)
        => IsActive && QrToken.Verify(TableCode, QrSecret, suppliedToken);

    private static string GenerateSecret()
    {
        Span<byte> buf = stackalloc byte[32];
        RandomNumberGenerator.Fill(buf);
        return Convert.ToHexString(buf).ToLowerInvariant();
    }
}

/// <summary>Phiên bàn — một "lượt khách". Expire sau 3h.</summary>
public sealed class GuestTableSession : Entity
{
    public static readonly TimeSpan DefaultLifetime = TimeSpan.FromHours(3);

    public Guid TableId { get; private set; }
    public string TableCode { get; private set; } = string.Empty;
    public GuestTableSessionStatus Status { get; private set; }
    public DateTimeOffset StartedAt { get; private set; }
    public DateTimeOffset? CompletedAt { get; private set; }
    public DateTimeOffset ExpiresAt { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }

    private GuestTableSession() { }
    private GuestTableSession(Guid id, Guid tableId, string tableCode,
        DateTimeOffset startedAt, DateTimeOffset expiresAt) : base(id)
    {
        TableId = tableId; TableCode = tableCode; Status = GuestTableSessionStatus.Active;
        StartedAt = startedAt; ExpiresAt = expiresAt; CreatedAt = startedAt;
    }

    public static GuestTableSession Start(Guid tableId, string tableCode, DateTimeOffset now)
    {
        if (tableId == Guid.Empty) throw new ArgumentException("tableId rỗng.", nameof(tableId));
        if (string.IsNullOrWhiteSpace(tableCode))
            throw new ArgumentException("tableCode rỗng.", nameof(tableCode));
        return new GuestTableSession(Guid.NewGuid(), tableId, tableCode, now, now + DefaultLifetime);
    }

    public void Complete(DateTimeOffset now)
    {
        if (Status != GuestTableSessionStatus.Active) throw new SessionExpiredException();
        Status = GuestTableSessionStatus.Completed; CompletedAt = now;
    }

    public void Expire(DateTimeOffset now)
    {
        if (Status != GuestTableSessionStatus.Active) return;
        Status = GuestTableSessionStatus.Expired; CompletedAt = now;
    }

    public bool IsUsable(DateTimeOffset now)
        => Status == GuestTableSessionStatus.Active && now < ExpiresAt;

    public void EnsureUsable(DateTimeOffset now)
    {
        if (!IsUsable(now)) throw new SessionExpiredException();
    }

    /// <summary>
    /// Nếu phiên còn hoạt động mà thời gian còn lại < 60 phút → tự động gia hạn thêm 60 phút (tối đa 12h).
    /// Tự động gọi khi khách tạo đơn mới (auto-extend).
    /// </summary>
    public void ExtendIfNeeded(DateTimeOffset now)
    {
        if (Status != GuestTableSessionStatus.Active) return;

        var remaining = ExpiresAt - now;
        if (remaining < TimeSpan.FromMinutes(60))
        {
            var target = now + TimeSpan.FromMinutes(60);
            var maxExpires = StartedAt + TimeSpan.FromHours(12);
            ExpiresAt = target > maxExpires ? maxExpires : target;
        }
    }

    /// <summary>
    /// Gia hạn chủ động (API extend): cộng thêm extraTime (mặc định 60 phút, tối đa 12h kể từ lúc bắt đầu).
    /// </summary>
    public void Extend(DateTimeOffset now, TimeSpan? extraTime = null)
    {
        EnsureUsable(now);
        var addition = extraTime ?? TimeSpan.FromHours(1);
        var target = (now > ExpiresAt ? now : ExpiresAt) + addition;
        var maxExpires = StartedAt + TimeSpan.FromHours(12);
        ExpiresAt = target > maxExpires ? maxExpires : target;
    }
}

/// <summary>Phiên thiết bị — gắn vào một GuestTableSession.</summary>
public sealed class GuestDeviceSession : Entity
{
    public Guid TableSessionId { get; private set; }
    public string SessionToken { get; private set; } = string.Empty;
    public string? DeviceFingerprint { get; private set; }
    public string? IpAddress { get; private set; }
    public string? UserAgent { get; private set; }
    public DateTimeOffset LastActiveAt { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }

    private GuestDeviceSession() { }
    private GuestDeviceSession(Guid id, Guid tableSessionId, string sessionToken,
        string? deviceFingerprint, string? ipAddress, string? userAgent,
        DateTimeOffset now) : base(id)
    {
        TableSessionId = tableSessionId; SessionToken = sessionToken;
        DeviceFingerprint = deviceFingerprint; IpAddress = ipAddress;
        UserAgent = userAgent; LastActiveAt = now; CreatedAt = now;
    }

    public static GuestDeviceSession Register(Guid tableSessionId,
        string? deviceFingerprint, string? ipAddress, string? userAgent, DateTimeOffset now)
    {
        if (tableSessionId == Guid.Empty)
            throw new ArgumentException("tableSessionId rỗng.", nameof(tableSessionId));

        return new GuestDeviceSession(
            Guid.NewGuid(), tableSessionId,
            CustomerOrdering.SessionToken.Generate().Value,
            Truncate(deviceFingerprint, 128),
            Truncate(ipAddress, 45),
            Truncate(userAgent, 512),
            now);
    }

    public void Touch(DateTimeOffset now) => LastActiveAt = now;

    private static string? Truncate(string? value, int maxLength)
        => value is null || value.Length <= maxLength ? value : value.Substring(0, maxLength);
}

/// <summary>Chi tiết món — snapshot name + price tại thời điểm đặt.</summary>
public sealed class GuestOrderItem : Entity
{
    public Guid GuestOrderId { get; private set; }
    public Guid MenuItemId { get; private set; }
    public string ItemName { get; private set; } = string.Empty;
    public int Quantity { get; private set; }
    public decimal Price { get; private set; }
    public decimal TotalPrice { get; private set; }
    public string? Notes { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }

    private GuestOrderItem() { }
    private GuestOrderItem(Guid id, Guid guestOrderId, Guid menuItemId,
        string itemName, int quantity, decimal price, string? notes,
        DateTimeOffset now) : base(id)
    {
        GuestOrderId = guestOrderId; MenuItemId = menuItemId; ItemName = itemName;
        Quantity = quantity; Price = price; TotalPrice = price * quantity;
        Notes = notes; CreatedAt = now;
    }

    internal static GuestOrderItem Create(Guid guestOrderId, Guid menuItemId,
        string itemName, int quantity, decimal price, string? notes, DateTimeOffset now)
    {
        if (menuItemId == Guid.Empty) throw new ArgumentException("menuItemId rỗng.", nameof(menuItemId));
        if (string.IsNullOrWhiteSpace(itemName))
            throw new ArgumentException("itemName rỗng.", nameof(itemName));
        if (quantity <= 0 || quantity > 99)
            throw new ArgumentOutOfRangeException(nameof(quantity), "Quantity [1, 99].");
        if (price < 0) throw new ArgumentOutOfRangeException(nameof(price), "Price không âm.");

        return new GuestOrderItem(Guid.NewGuid(), guestOrderId, menuItemId,
            itemName, quantity, price,
            notes is { Length: > 500 } ? notes.Substring(0, 500) : notes,
            now);
    }
}

/// <summary>Aggregate root GuestOrder. Finalize() phát GuestOrderCreatedEvent.</summary>
public sealed class GuestOrder : Entity
{
    public string Code { get; private set; } = string.Empty;
    public Guid TableSessionId { get; private set; }
    public Guid DeviceSessionId { get; private set; }
    public string TableCode { get; private set; } = string.Empty;
    public GuestOrderStatus Status { get; private set; }
    public decimal TotalAmount { get; private set; }
    public string? Notes { get; private set; }
    public Guid? ConfirmedBy { get; private set; }
    public DateTimeOffset? ConfirmedAt { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }

    private readonly List<GuestOrderItem> _items = new();
    public IReadOnlyCollection<GuestOrderItem> Items => _items.AsReadOnly();

    private GuestOrder() { }
    private GuestOrder(Guid id, string code, Guid tableSessionId, Guid deviceSessionId,
        string tableCode, string? notes, DateTimeOffset now) : base(id)
    {
        Code = code; TableSessionId = tableSessionId; DeviceSessionId = deviceSessionId;
        TableCode = tableCode; Status = GuestOrderStatus.PendingConfirmation;
        TotalAmount = 0;
        Notes = notes is { Length: > 500 } ? notes.Substring(0, 500) : notes;
        CreatedAt = now; UpdatedAt = now;
    }

    public static GuestOrder Create(Guid tableSessionId, Guid deviceSessionId,
        string tableCode, string? notes, DateTimeOffset now)
    {
        if (tableSessionId == Guid.Empty)
            throw new ArgumentException("tableSessionId rỗng.", nameof(tableSessionId));
        if (deviceSessionId == Guid.Empty)
            throw new ArgumentException("deviceSessionId rỗng.", nameof(deviceSessionId));
        if (string.IsNullOrWhiteSpace(tableCode))
            throw new ArgumentException("tableCode rỗng.", nameof(tableCode));

        return new GuestOrder(Guid.NewGuid(), GenerateCode(now),
            tableSessionId, deviceSessionId, tableCode, notes, now);
    }

    public GuestOrderItem AddItem(Guid menuItemId, string itemName, int quantity,
        decimal price, string? notes, DateTimeOffset now)
    {
        if (Status != GuestOrderStatus.PendingConfirmation)
            throw new InvalidOrderStateException("Chỉ thêm món khi đơn chưa xác nhận.");

        var item = GuestOrderItem.Create(Id, menuItemId, itemName, quantity, price, notes, now);
        _items.Add(item);
        TotalAmount = _items.Sum(i => i.TotalPrice);
        UpdatedAt = now;
        return item;
    }

    public void Finalize(DateTimeOffset now)
    {
        if (_items.Count == 0)
            throw new InvalidOrderStateException("Đơn hàng phải có ít nhất 1 món.");
        TotalAmount = _items.Sum(i => i.TotalPrice);
        UpdatedAt = now;

        RaiseEvent(new GuestOrderCreatedEvent(
            Id, Code, TableSessionId, TableCode, TotalAmount, now));
    }

    public void Confirm(Guid userId, DateTimeOffset now)
    {
        TransitionTo(GuestOrderStatus.Confirmed, now);
        ConfirmedBy = userId;
        ConfirmedAt = now;
    }

    public void TransitionTo(GuestOrderStatus to, DateTimeOffset now)
    {
        if (!Status.CanTransitionTo(to))
            throw new InvalidOrderStateException($"Không thể chuyển từ '{Status}' sang '{to}'.");
        Status = to;
        UpdatedAt = now;
    }

    private static string GenerateCode(DateTimeOffset now)
    {
        var ts = now.UtcDateTime.ToString("yyMMddHHmmss");
        var rand = Guid.NewGuid().ToString("N").Substring(0, 4).ToLowerInvariant();
        return $"GST-{ts}-{rand}";
    }
}

// ─── 6. BE-2 Entities ──────────────────────────────────────────────────────

/// <summary>Đánh giá đơn: 1-1 với GuestOrder, chỉ cho khi status='served'.</summary>
public sealed class GuestOrderFeedback : Entity
{
    public Guid GuestOrderId { get; private set; }
    public short Rating { get; private set; }
    public string? Comment { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }

    private GuestOrderFeedback() { }
    private GuestOrderFeedback(Guid id, Guid guestOrderId, short rating,
        string? comment, DateTimeOffset now) : base(id)
    {
        GuestOrderId = guestOrderId; Rating = rating; Comment = comment; CreatedAt = now;
    }

    public static GuestOrderFeedback Create(Guid guestOrderId, int rating,
        string? comment, DateTimeOffset now)
    {
        if (guestOrderId == Guid.Empty)
            throw new ArgumentException("guestOrderId rỗng.", nameof(guestOrderId));
        if (rating < 1 || rating > 5)
            throw new ArgumentOutOfRangeException(nameof(rating), "Rating [1, 5].");

        return new GuestOrderFeedback(Guid.NewGuid(), guestOrderId, (short)rating,
            comment is { Length: > 500 } ? comment.Substring(0, 500) : comment, now);
    }
}

/// <summary>Yêu cầu "gọi nhân viên" — khách bấm nút ở FE-1.</summary>
public sealed class StaffCall : Entity
{
    public Guid TableSessionId { get; private set; }
    public string TableCode { get; private set; } = string.Empty;
    public string Reason { get; private set; } = string.Empty;
    public StaffCallStatus Status { get; private set; }
    public Guid? AcknowledgedBy { get; private set; }
    public DateTimeOffset? AcknowledgedAt { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }

    private StaffCall() { }
    private StaffCall(Guid id, Guid tableSessionId, string tableCode,
        string reason, DateTimeOffset now) : base(id)
    {
        TableSessionId = tableSessionId; TableCode = tableCode;
        Reason = reason; Status = StaffCallStatus.Pending; CreatedAt = now;
    }

    public static StaffCall Create(Guid tableSessionId, string tableCode,
        string reason, DateTimeOffset now)
    {
        if (tableSessionId == Guid.Empty)
            throw new ArgumentException("tableSessionId rỗng.", nameof(tableSessionId));
        if (string.IsNullOrWhiteSpace(tableCode))
            throw new ArgumentException("tableCode rỗng.", nameof(tableCode));
        if (string.IsNullOrWhiteSpace(reason))
            throw new ArgumentException("reason rỗng.", nameof(reason));

        var trimmed = reason.Length > 100 ? reason.Substring(0, 100) : reason;
        return new StaffCall(Guid.NewGuid(), tableSessionId, tableCode, trimmed, now);
    }
}
