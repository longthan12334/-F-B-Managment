# Học, chạy và test BE-1 slim — hiểu đúng luồng

**Thời gian ước lượng:** 3-4 giờ cho người lần đầu

Tài liệu này hướng dẫn bạn chạy BE-1 từ đầu, test end-to-end bằng curl, đọc code để hiểu luồng, và kiểm tra hiểu đúng bằng 5 câu hỏi + 3 kịch bản phá hoại.

---

## PHẦN A — CHUẨN BỊ (15 phút)

### A.1 Cài đặt máy

| Phần mềm | Version | Mục đích |
|---|---|---|
| Docker Desktop (Win/Mac) hoặc Docker Engine + Compose plugin (Linux) | 24+ | Chạy stack 5 container |
| Git | 2.x | Clone repo |
| curl + jq | — | Test API |
| psql client (tùy chọn) | 16+ | Nếu không muốn exec vào container |

Verify:
```bash
docker --version          # cần 24+
docker compose version    # cần 2.20+
jq --version              # cần để parse JSON đẹp
```

Nếu thiếu `jq`:
- Linux: `sudo apt install jq`
- Mac: `brew install jq`

### A.2 Clone và chuyển branch

```bash
git clone https://github.com/longthan12334/-F-B-Managment.git fb-mgmt
cd fb-mgmt
git checkout feature/BE-1-slim    # hoặc branch nào bạn đã push BE-1
cp .env.example .env
```

---

## PHẦN B — CHẠY STACK LÊN (10 phút)

### B.1 Lệnh duy nhất

```bash
docker compose up -d --build
```

Lần đầu build mất 5-7 phút (tải base images .NET SDK + aspnet runtime + Node). Sau build cache nên nhanh.

### B.2 Theo dõi

```bash
docker compose logs -f customer-api
```

Chờ đến khi thấy:
```
Now listening on: http://[::]:5000
Application started. Press Ctrl+C to shut down.
```

→ **customer-api OK.** Bấm `Ctrl+C` để thoát logs (container vẫn chạy).

### B.3 Health check nhanh

```bash
curl -sS http://localhost:5000/public-api/health | jq
```

Phải thấy:
```json
{ "status": "ok", "ts": "2026-10-27T..." }
```

### B.4 Apply migration 006

```bash
docker exec -i restomanager-postgres psql -U postgres -d restaurant_db \
    < back-end/migrations/006_qr_ordering.sql
```

Verify 5 bảng mới:
```bash
docker exec -it restomanager-postgres psql -U postgres -d restaurant_db -c "\dt"
```

Phải thấy: `table_qr_configs`, `guest_table_sessions`, `guest_device_sessions`, `guest_orders`, `guest_order_items`.

---

## PHẦN C — TEST END-TO-END 6 BƯỚC (30 phút)

Flow khách: scan QR → xem menu → gọi món → xem đơn.

### C.1 Lấy QR secret của bàn T1-01 (giả lập)

```bash
docker exec -it restomanager-postgres psql -U postgres -d restaurant_db -c \
  "SELECT table_code, qr_secret FROM table_qr_configs WHERE table_code='T1-01';"
```

Copy giá trị `qr_secret` ra biến shell:
```bash
TABLE_CODE="T1-01"
QR_SECRET="<DÁN secret vừa copy>"
```

### C.2 Tự sinh QR token bằng HMAC-SHA256

```bash
QR_TOKEN=$(echo -n "$TABLE_CODE" | openssl dgst -sha256 -hmac "$QR_SECRET" -binary | xxd -p -c 256)
echo "QR Token: $QR_TOKEN"
```

→ Phải ra chuỗi hex 64 ký tự. Đây là token FE-1 sẽ nhúng vào URL QR trong thực tế.

### C.3 Khách scan QR → init session

```bash
RESPONSE=$(curl -sS -X POST http://localhost:5000/public-api/session/init \
  -H "Content-Type: application/json" \
  -d "{ \"tableCode\": \"$TABLE_CODE\", \"qrToken\": \"$QR_TOKEN\" }")

echo "$RESPONSE" | jq
SESSION_TOKEN=$(echo "$RESPONSE" | jq -r '.sessionToken')
echo "Session token: $SESSION_TOKEN"
```

→ Response có `sessionToken` (64 ký tự hex), `tableSessionId`, `expiresAt` (3 giờ sau), `table`, `categories`, `items`.

**Hiểu:** server đã verify HMAC, tạo `guest_table_sessions` + `guest_device_sessions` mới, trả snapshot menu.

### C.4 Xem menu công khai (không cần session)

```bash
curl -sS http://localhost:5000/public-api/menu | jq '.items | length'
```

→ Số lượng item active trong `menu_items`. Endpoint này không auth, có rate limit 30/phút/IP.

### C.5 Gọi món

```bash
# Lấy menu_item_id đầu tiên
MENU_ITEM_ID=$(curl -sS http://localhost:5000/public-api/menu | jq -r '.items[0].id')
echo "Item ID: $MENU_ITEM_ID"

# Tạo đơn
ORDER_RESPONSE=$(curl -sS -X POST http://localhost:5000/public-api/orders \
  -H "Content-Type: application/json" \
  -H "X-Session-Token: $SESSION_TOKEN" \
  -H "X-Request-Id: $(uuidgen)" \
  -H "X-Timestamp: $(date +%s)" \
  -d "{ \"notes\": \"ít cay\", \"items\": [{ \"menuItemId\": \"$MENU_ITEM_ID\", \"quantity\": 2 }] }")

echo "$ORDER_RESPONSE" | jq
ORDER_ID=$(echo "$ORDER_RESPONSE" | jq -r '.id')
echo "Order ID: $ORDER_ID"
```

→ Response có `code` (GST-...), `status`=`pending_confirmation`, `totalAmount`, `items`.

**Hiểu:** server validate session còn usable, validate items (giá, active), tạo `guest_orders` + `guest_order_items`, phát `GuestOrderCreatedEvent` qua `IEventBus`.

### C.6 Xem danh sách đơn trong phiên

```bash
curl -sS http://localhost:5000/public-api/orders \
  -H "X-Session-Token: $SESSION_TOKEN" | jq
```

→ List đơn vừa tạo. Khách tra lại được.

---

## PHẦN D — VERIFY TRONG DB (10 phút)

Mở psql riêng và check:

```bash
docker exec -it restomanager-postgres psql -U postgres -d restaurant_db
```

Trong psql:

```sql
-- 1. Session được tạo đúng?
SELECT id, table_code, status, started_at, expires_at
  FROM guest_table_sessions ORDER BY created_at DESC LIMIT 3;

-- 2. Device session có session_token khớp?
SELECT id, session_token, table_session_id, last_active_at
  FROM guest_device_sessions ORDER BY created_at DESC LIMIT 3;

-- 3. Đơn có đúng status và total?
SELECT code, status, total_amount, notes, created_at
  FROM guest_orders ORDER BY created_at DESC LIMIT 3;

-- 4. Items có đúng giá snapshot?
SELECT item_name, quantity, price, total_price
  FROM guest_order_items ORDER BY created_at DESC LIMIT 5;

-- 5. QR config đã seed cho mọi bàn?
SELECT COUNT(*) FROM table_qr_configs;
-- → bằng số bàn trong `tables`

-- Thoát psql
\q
```

---

## PHẦN E — HIỂU LUỒNG QUA ĐỌC CODE (60 phút)

### E.1 Thứ tự đọc 7 file (quan trọng → ít)

| # | File | Thời gian | Hiểu được gì |
|---|---|---|---|
| 1 | `Modules/CustomerOrdering/Domain.cs` | 20 phút | Entity + logic nghiệp vụ + SOLID |
| 2 | `Modules/CustomerOrdering/Services.cs` | 15 phút | Use case orchestrate thế nào |
| 3 | `Modules/CustomerOrdering/Api.cs` | 10 phút | Controller nhận request, filter check session |
| 4 | `Modules/CustomerOrdering/Infrastructure.cs` | 5 phút | EF Core map + background job |
| 5 | `Modules/CustomerOrdering/CustomerOrderingModule.cs` | 3 phút | DI + rate limit policy |
| 6 | `SharedKernel.cs` | 5 phút | Event bus, middleware chung |
| 7 | `Program.cs` | 2 phút | Composition root chạy modules |

### E.2 Với `Domain.cs` (20 phút)

Mở file, scroll xuống theo thứ tự. Mỗi concept tự hỏi:

**Section 1: Enums (dòng ~15-85)**
- `GuestOrderStatus` có 5 giá trị. Tại sao `Preparing`, `Served` nằm sau `Confirmed`?
- `EnumMappings.CanTransitionTo` — thử nêu 3 transition KHÔNG hợp lệ.
  (Gợi ý: Served → Preparing? Served → Confirmed? Cancelled → Confirmed?)

**Section 2: Value Objects (dòng ~85-150)**
- `SessionToken` dùng `RandomNumberGenerator.Fill` thay vì `Random.Shared.NextBytes`. Tại sao?
  (Gợi ý: cryptographic strength)
- `QrToken.Verify` dùng `CryptographicOperations.FixedTimeEquals` thay vì `==`. Tại sao?
  (Gợi ý: timing attack — tấn công đoán ký tự nào đã khớp qua thời gian so sánh)

**Section 3: Exceptions (dòng ~150-200)**
- Mỗi exception có property `Code`. `ExceptionHandlingMiddleware` ở SharedKernel map `Code` → HTTP status. Thử liệt kê 5 cặp (Code, HTTP).
  (Đáp án trong SharedKernel.cs section ExceptionHandlingMiddleware.)

**Section 4: Event (dòng ~200-220)**
- `GuestOrderCreatedEvent` là `record` immutable. Tại sao immutable quan trọng cho event?
  (Gợi ý: nếu handler sửa event, handler khác bị ảnh hưởng → bug khó debug)

**Section 5: Entities (dòng ~220-460)**
- Mở `GuestOrder.Create()`. Nó validate 3 tham số rồi gọi private constructor. **Tại sao không `public GuestOrder(Guid tableSessionId, ...)`?**
  (Gợi ý: ép mọi code tạo order đi qua Factory → validation tập trung)
- `GuestOrder._items` là `private readonly List<GuestOrderItem>`. `Items` property là `IReadOnlyCollection`. **Tại sao không expose List?**
  (Gợi ý: nếu expose List, controller có thể `order.Items.Add(...)` bỏ qua logic `AddItem()` → sai total_amount)
- `AddItem()` ném `InvalidOrderStateException` khi `Status != PendingConfirmation`. **Lợi ích?**
  (Gợi ý: không thể add món khi đơn đã confirmed → cashier không bị shock số tiền tăng)

### E.3 Với `Services.cs` (15 phút)

- `SessionService.InitAsync` làm 5 bước (verify QR → load table → tìm/tạo session → register device → load menu). Thử xoá bước 1 (verify QR), request vẫn OK — **tại sao vậy nguy hiểm?**
  (Gợi ý: kẻ xấu bịa `qrToken` bất kỳ, server vẫn tạo session → spam phiên)
- `OrderService.CreateAsync` dùng `_menuRead.GetItemsByIdsAsync` để load snapshot. **Tại sao không trust `price` từ request body?**
  (Gợi ý: client gian lận gửi `price: 0.01` → server lấy giá thật từ DB)

### E.4 Với `Api.cs` (10 phút)

- `RequireGuestSessionAttribute.OnAuthorizationAsync` làm 3 bước:
  1. Check header exist
  2. Parse token format
  3. Call `SessionService.ValidateAsync` → attach `GuestSessionContext`
- Status trả: 401 (thiếu/sai token), 410 (session hết hạn). **Tại sao 410 Gone thay vì 401?**
  (Gợi ý: 401 nghĩa "credential sai, thử lại" — 410 nghĩa "resource gone, không retry nữa, phải tạo mới")

- `AntiReplayMiddleware` chỉ apply cho POST `/public-api/*`. **Tại sao không apply GET?**
  (Gợi ý: GET idempotent, replay cũng không gây tác hại; POST tạo order, replay = tạo đơn trùng)

### E.5 Với `SharedKernel.cs` (5 phút)

- `IEventBus.PublishAsync` dùng `IServiceProvider.GetServices<IEventHandler<T>>()`. **Tại sao không `GetService` (số ít)?**
  (Gợi ý: cho phép nhiều module cùng subscribe 1 event)
- `InMemoryEventBus` catch `Exception` khi handler fail nhưng không rethrow. **Lý do?**
  (Gợi ý: không rollback transaction đã commit; không fail module khác chỉ vì 1 handler lỗi)

---

## PHẦN F — KIỂM TRA HIỂU ĐÚNG BẰNG 3 KỊCH BẢN PHÁ HOẠI (30 phút)

Mỗi kịch bản, chạy và quan sát response. Phải khớp "Kết quả mong đợi".

### Kịch bản 1: Giả mạo QR token

```bash
# Dùng token BẬY
curl -sS -X POST http://localhost:5000/public-api/session/init \
  -H "Content-Type: application/json" \
  -d '{ "tableCode": "T1-01", "qrToken": "0000000000000000000000000000000000000000000000000000000000000000" }' | jq
```

**Kết quả mong đợi:** HTTP 403, body `{ "code": "invalid_qr_token", "message": "..." }`

**Hiểu:** `QrToken.Verify` thấy HMAC không khớp → ném `InvalidQrTokenException` → `ExceptionHandlingMiddleware` map code `invalid_qr_token` → 403 Forbidden.

### Kịch bản 2: Dùng session token sai

```bash
# POST đơn với session token bịa
curl -sS -X POST http://localhost:5000/public-api/orders \
  -H "Content-Type: application/json" \
  -H "X-Session-Token: 1111111111111111111111111111111111111111111111111111111111111111" \
  -H "X-Request-Id: $(uuidgen)" \
  -H "X-Timestamp: $(date +%s)" \
  -d '{ "items": [{ "menuItemId": "00000000-0000-0000-0000-000000000000", "quantity": 1 }] }' | jq
```

**Kết quả mong đợi:** HTTP 401, body `{ "code": "invalid_session_token", "message": "Session token không tồn tại." }`

**Hiểu:** `RequireGuestSessionAttribute` gọi `SessionService.ValidateAsync` → không tìm thấy device → trả 401.

### Kịch bản 3: Replay attack

Chạy lệnh C.5 lần đầu — OK. Chạy lệnh ĐÚNG đó lần 2 (giữ nguyên `X-Request-Id`):

```bash
REQUEST_ID=$(uuidgen)
TIMESTAMP=$(date +%s)

# Lần 1
curl -sS -X POST http://localhost:5000/public-api/orders \
  -H "X-Session-Token: $SESSION_TOKEN" \
  -H "X-Request-Id: $REQUEST_ID" \
  -H "X-Timestamp: $TIMESTAMP" \
  -H "Content-Type: application/json" \
  -d "{ \"items\": [{ \"menuItemId\": \"$MENU_ITEM_ID\", \"quantity\": 1 }] }" | jq -r '.code'

# Lần 2 — DÙNG LẠI REQUEST_ID
curl -sS -X POST http://localhost:5000/public-api/orders \
  -H "X-Session-Token: $SESSION_TOKEN" \
  -H "X-Request-Id: $REQUEST_ID" \
  -H "X-Timestamp: $TIMESTAMP" \
  -H "Content-Type: application/json" \
  -d "{ \"items\": [{ \"menuItemId\": \"$MENU_ITEM_ID\", \"quantity\": 1 }] }" | jq
```

**Kết quả mong đợi:** Lần 1 có mã GST-... Lần 2 trả HTTP 400 `{ "code": "replay_detected" }`.

**Hiểu:** `AntiReplayMiddleware` lưu `X-Request-Id` vào `IMemoryCache` 5 phút. Lần 2 thấy đã dùng → chặn.

---

## PHẦN G — 5 CÂU HỎI KIỂM TRA (10 phút)

Tự trả lời (có đáp án dưới):

1. **Khi khách scan QR, 5 bảng nào có row mới sau lần đầu init session?**
2. **`CustomerOrderingDbContext.SaveChangesAsync` khác `DbContext.SaveChangesAsync` ở chỗ nào?**
3. **Nếu khách gọi món lúc 10:00, session hết hạn lúc nào?**
4. **FE-1 muốn biết đơn đã confirmed, dùng cách nào (hiện tại không có SSE)?**
5. **Trong Modular Monolith, module Billing muốn biết khi khách tạo đơn — đăng ký kiểu gì? KHÔNG sửa code CustomerOrdering nhé.**

<details>
<summary>Đáp án</summary>

1. `guest_table_sessions` (1 row), `guest_device_sessions` (1 row). `table_qr_configs` KHÔNG mới (seed sẵn). `guest_orders` + `guest_order_items` chỉ có khi POST /orders.

2. Override gom `DomainEvents` từ entities đang tracked → dispatch qua `IEventBus` SAU khi commit DB thành công. Nếu commit fail → không dispatch (nhất quán).

3. 13:00 (DefaultLifetime = 3 giờ, trong `GuestTableSession.cs`).

4. Polling `GET /public-api/orders/{id}` mỗi 3-5 giây. Rate limit `order-status` 20/phút phù hợp (20 req/phút = polling 3s).

5. Trong BillingModule.Register:
   ```csharp
   services.AddScoped<IEventHandler<GuestOrderCreatedEvent>, BillingReceiverHandler>();
   ```
   Khi `GuestOrder.Finalize()` chạy → `IEventBus` tự tìm và gọi handler Billing. CustomerOrdering code nguyên vẹn.
</details>

---

## PHẦN H — DEBUG KHI GẶP LỖI

| Lỗi | Nguyên nhân thường gặp | Fix |
|---|---|---|
| `docker compose up` lỗi `port already in use` | 5000/3000/5432/8080 đã có app khác | `docker compose down` các stack khác, hoặc đổi `*_PORT_HOST` trong `.env` |
| customer-api log: `error NU1301` | Mạng chặn api.nuget.org | Build trong Docker tốt hơn (Dockerfile tự restore) |
| customer-api log: `Postgres chưa sẵn sàng` | Postgres chưa healthy | Đợi 10-20s, hoặc `docker compose restart customer-api` |
| curl `/session/init` → 404 | Chưa apply migration 006 (bảng `table_qr_configs` chưa có) | Chạy mục B.4 |
| curl `/session/init` → 403 invalid_qr_token | Secret bạn copy sai hoặc có khoảng trắng | Copy lại chính xác, không space 2 đầu |
| curl POST → 400 timestamp_out_of_range | Clock máy bạn sai lệch so với server | `date -u` so với `docker exec -it restomanager-customer-api date -u` |
| curl POST → 400 replay_detected | X-Request-Id đã dùng gần đây | Mỗi POST tạo UUID mới `$(uuidgen)` |
| 429 Too Many Requests | Vượt rate limit (session-init 5/phút, create-order 3/phút, ...) | Chờ 1 phút |

---

## PHẦN I — ĐÃ XONG — LÀM GÌ TIẾP?

Khi bạn chạy được 6 bước + phá hoại 3 kịch bản + trả lời được 5 câu hỏi:

1. **Giải thích luồng cho bạn khác** — hiểu nhất là khi dạy lại. Mở `Domain.cs::GuestOrder.AddItem()` và giải thích cho đồng đội.
2. **Thử phá hoại thêm** — Clock máy bạn chỉnh lệch 1 phút, send POST, xem có bị 400 không. Chỉnh về, send lại, OK không.
3. **Đọc tiếp HUONG_DAN.md** — có hướng dẫn setup xUnit viết 4 test case cho Domain layer.
4. **Chuẩn bị demo giảng viên** — follow kịch bản demo 5 phút trong `GHI_CHU_TRUONG_NHOM.md`.

---

## Phụ lục: cheatsheet lệnh

```bash
# Khởi động stack
docker compose up -d --build

# Dừng (giữ data)
docker compose stop

# Dừng + xóa (mất data)
docker compose down -v

# Log realtime
docker compose logs -f customer-api
docker compose logs -f backend

# Vào shell container
docker exec -it restomanager-customer-api sh
docker exec -it restomanager-postgres psql -U postgres -d restaurant_db

# Chạy psql query từ ngoài
docker exec -i restomanager-postgres psql -U postgres -d restaurant_db -c "SELECT ..."

# Chạy file SQL
docker exec -i restomanager-postgres psql -U postgres -d restaurant_db < path/to/file.sql
```
