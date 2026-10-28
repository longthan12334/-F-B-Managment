# RestoManager — customer-api (BE-1)

**Nhiệm vụ:** Nền tảng .NET cho hệ thống gọi món QR — lược đồ dữ liệu, vòng đời phiên, lớp bảo vệ trang công khai.

**Kiến trúc (bắt buộc Buổi 12):** Modular Monolith — 1 deployable, chia bounded context thành module, giao tiếp qua in-process event bus. Clean Architecture kết hợp DDD tinh gọn.

**Stack:** .NET 10 · EF Core 10 · PostgreSQL 16 · Serilog · Swagger/OpenAPI · Docker Compose · GitHub Actions CI/CD.

---

## 📋 TỔNG HỢP KẾT QUẢ ĐẠT ĐƯỢC CỦA BE-1 THEO YÊU CẦU ĐỀ BÀI

BE-1 phụ trách toàn bộ **Nền tảng & Bảo mật của hệ thống gọi món qua QR công khai**. Dưới đây là các hạng mục đã hoàn thành 100%:

### 1. Kiến trúc Modular Monolith chuẩn Buổi 12 & Clean Architecture
- **Chia Bounded Context:** Tách biệt rõ ràng tầng hạ tầng dùng chung `SharedKernel` và nghiệp vụ đặt món `Modules/CustomerOrdering/`.
- **Đóng gói chuẩn mực:** Mỗi module có đầy đủ 4 tầng logic nhưng được gộp tinh gọn thành 7 file `.cs` chính (Domain, Application Services, Infrastructure DbContext, Presentation Controllers & DTOs).
- **Giao tiếp lỏng (Loose Coupling):** Triển khai `IEventBus` / `InMemoryEventBus`. Khi khách chốt đơn (`GuestOrder.Finalize`), hệ thống tự động dispatch sự kiện `GuestOrderCreatedEvent` qua `IEventHandler<T>`, cho phép các module khác (bếp, thu ngân, thông báo) lắng nghe mà không gây phụ thuộc chéo.

### 2. Thiết kế lược đồ dữ liệu mới (5 Bảng dữ liệu) & Migration 006
Tạo mới file migration `back-end/migrations/006_qr_ordering.sql` bổ sung 5 bảng dữ liệu chuyên biệt:
1. `table_qr_configs`: Cấu hình QR riêng cho từng bàn, lưu mã bí mật `qr_secret` dùng để ký HMAC.
2. `guest_table_sessions`: Quản lý vòng đời phiên ngồi của bàn (`Active`, `Completed`, `Expired`), mặc định thời lượng 3 giờ.
3. `guest_device_sessions`: Quản lý thiết bị của từng khách quét mã (lưu `session_token`, IP, Fingerprint), hỗ trợ nhiều người ngồi cùng một bàn cùng xem menu và đặt món.
4. `guest_orders`: Lưu trữ đơn đặt món của khách qua QR với mã đơn, tổng tiền, ghi chú và trạng thái xác nhận.
5. `guest_order_items`: Lưu chi tiết món đặt với **Snapshot Pattern** (chụp cứng tên món và giá tại thời điểm gọi, không bị ảnh hưởng khi menu thay đổi giá trong tương lai).

### 3. Quản lý vòng đời phiên gọi món (Session Lifecycle)
- **Tự động dọn dẹp (Background Worker):** Xây dựng `SessionCleanupService` triển khai `IHostedService`, chạy nền định kỳ mỗi 1 phút để quét DB và tự động đánh dấu `Expired` cho các phiên quá hạn 3 tiếng.
- **Tự động gia hạn thông minh (Feature #5 - Auto-Extend):**
  - Khi khách thao tác đặt món (`OrderService.CreateAsync`), nếu thời gian còn lại của phiên bàn dưới 60 phút, hệ thống tự động kéo dài thêm 60 phút (tối đa 12 giờ).
  - Cung cấp endpoint chủ động `POST /public-api/session/extend` cho phép khách/nhân viên gia hạn thêm thời gian ngồi ăn tại bàn.

### 4. Bốn lớp bảo vệ trang công khai (Public API Security Layers)
Hệ thống gọi món QR mở ra Internet công khai nên được trang bị 4 lớp bảo mật nghiêm ngặt:
1. **Lớp 1 - Xác thực mã QR bằng HMAC-SHA256 (`QrToken`):**
   - Chống việc khách sửa số bàn trên URL để gọi món phá bàn khác.
   - So sánh chuỗi an toàn chống **Timing Attack** bằng `CryptographicOperations.FixedTimeEquals`.
2. **Lớp 2 - Chống tấn công phát lại (Anti-Replay Attack Middleware):**
   - Bắt buộc header `X-Request-Id` (UUID duy nhất) và `X-Timestamp` (Unix timestamp) trên tất cả các request ghi dữ liệu (POST).
   - Kiểm soát độ lệch đồng hồ (Clock drift) trong khoảng `±30 giây`.
   - Lưu trữ và chặn trùng lặp `X-Request-Id` trong vòng 5 phút (In-Memory Cache chống Replay).
3. **Lớp 3 - Rate Limiting đa tầng (Chống Spam / DoS):**
   - Reverse Proxy Nginx giới hạn tốc độ request.
   - Tầng .NET tích hợp `Microsoft.AspNetCore.RateLimiting` chia partition theo IP với quota chặt chẽ:
     + Khởi tạo phiên: 5 requests/phút.
     + Đặt món: 10 requests/phút.
     + Đọc menu: 60 requests/phút.
4. **Lớp 4 - Xác thực phiên thiết bị (`RequireGuestSessionAttribute`):**
   - Chỉ cho phép xem/gọi món khi gửi kèm `X-Session-Token` hợp lệ sinh ra từ phiên bàn đang hoạt động.
5. **Lớp 5 - Security Headers & CORS:**
   - Bảo vệ trình duyệt bằng các header: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, cấu hình CORS chặt chẽ.

### 5. Nâng cấp bộ lọc tài liệu Swagger (Feature #3 - Swagger Filter)
- Tích hợp `AntiReplaySwaggerFilter` kế thừa `IOperationFilter` vào Swagger UI.
- Giao diện Swagger tự động hiển thị ô nhập và giá trị mặc định cho `X-Request-Id` (UUID) và `X-Timestamp` (Unix timestamp hiện tại) cho các request POST công khai.
- Tự động gắn Security Requirement `SessionToken` cho các endpoint yêu cầu xác thực phiên khách (`RequireGuestSession`), giúp lập trình viên và giảng viên test trực tiếp API trên trình duyệt chỉ bằng 1 cú click "Try it out".

### 6. Đã kiểm thử tự động toàn diện
- Có sẵn kịch bản kiểm thử PowerShell `test-security.ps1` kiểm tra tự động cả 4 lớp bảo vệ:
  - ✅ **Test 1:** Thử QR Token giả mạo -> Trả về `403 Forbidden` (`invalid_qr_token`).
  - ✅ **Test 2:** Thử gửi lại request POST cùng `X-Request-Id` -> Trả về `400 BadRequest` (`replay_detected`).
  - ✅ **Test 3:** Thử gửi timestamp lệch quá 30s -> Trả về `400 BadRequest` (`timestamp_out_of_range`).
  - ✅ **Test 4:** Thử đặt món khi không gửi token -> Trả về `401 Unauthorized` (`missing_session_token`).
- Kiểm thử luồng thực tế (End-to-End): Khởi tạo phiên -> Gia hạn phiên (+60 phút) -> Đọc Menu -> Đặt món thành công -> Tất cả hoạt động 100% trơn tru.

---

## 1. Chạy nhanh

```bash
git clone https://github.com/longthan12334/-F-B-Managment.git fb-mgmt
cd fb-mgmt
git checkout feature/BE-1-modular-monolith
cp .env.example .env
docker compose up -d --build
docker compose logs -f customer-api
```

### Kiểm tra

| URL | Nội dung |
|---|---|
| http://localhost:8080 | Staff web |
| http://localhost:5000/swagger | Swagger customer-api |
| http://localhost:5000/public-api/health | Health check |
| http://localhost:5000/public-api/menu | Menu công khai |

Apply migration:
```bash
docker exec -i restomanager-postgres psql -U postgres -d restaurant_db \
    < back-end/migrations/006_qr_ordering.sql
```

---

## 2. Cấu trúc project (gọn và vẫn đủ)

**Chỉ 7 file .cs source** — ngắn gọn, dễ review, vẫn thể hiện Modular Monolith:

```
customer-api/
├── Program.cs                       (~90 dòng — composition root)
├── SharedKernel.cs                  (~200 dòng — primitives, abstractions,
│                                     IEventBus, 2 middleware chung)
├── Modules/
│   └── CustomerOrdering/
│       ├── CustomerOrderingModule.cs  (~90 dòng — IModule register DI + rate limit)
│       ├── Domain.cs                  (~400 dòng — 5 entities + enums + VO + exceptions + event)
│       ├── Infrastructure.cs          (~280 dòng — DbContext + MenuRead + AntiReplay + Cleanup)
│       ├── Services.cs                (~160 dòng — 3 application services)
│       └── Api.cs                     (~280 dòng — DTOs + Security + 3 controllers)
│
├── appsettings*.json  (4 môi trường)
├── Properties/launchSettings.json
├── Dockerfile · .dockerignore · .gitignore
├── RestoManager.CustomerApi.csproj
├── README.md · NHATKY.md · HUONG_DAN.md · GHI_CHU_TRUONG_NHOM.md
```

**So với bản trước (50 file):** giảm còn **~15 file** tổng (7 .cs + csproj + 4 appsettings + Dockerfile + .gitignore + .dockerignore + docs). Mỗi file làm 1 nhiệm vụ, scope rõ ràng, không nhảy giữa 10 folder nhỏ.

---

## 3. Nguyên tắc kiến trúc giữ nguyên

**Buổi 12 Modular Monolith (bắt buộc):**
- **Module** = 1 bounded context. Hiện có `CustomerOrdering`, thêm Billing/Notification sau = 1 class implement `IModule`.
- **SharedKernel** = code chung mọi module (Entity base, IEventBus, DomainException, middleware chung).
- **IEventBus** in-memory — module A phát event → module B subscribe. Swap sang Redis sau = chỉ đổi `InMemoryEventBus`.
- **DbContext riêng** cho mỗi module.

**SOLID (Buổi 2-3):**
- Private setter + factory ở Entity (SRP).
- `IDateTimeProvider` + `IEventBus` abstractions (DIP).
- `CanTransitionTo` 1 chỗ (OCP).
- `DomainException` base (LSP).

**Clean Architecture (tinh thần, không strict):**
- Trong file `Domain.cs`: entities + value objects không depend EF Core.
- `Infrastructure.cs` depend `Domain.cs` + EF Core.
- `Services.cs` depend `Domain.cs` + `Infrastructure.cs` (DbContext).
- `Api.cs` depend tất cả.

---

## 4. Thêm module mới (ví dụ)

Dự án lớn, team muốn thêm module Billing:

```csharp
// Modules/Billing/BillingModule.cs
public sealed class BillingModule : IModule
{
    public string Name => "Billing";
    public void Register(IServiceCollection services, IConfiguration config)
    {
        services.AddDbContext<BillingDbContext>(...);
        services.AddScoped<InvoiceService>();
    }
}
```

Trong `Program.cs` chỉ cần thêm 1 dòng:
```csharp
IModule[] modules = [ new CustomerOrderingModule(), new BillingModule() ];
```

Billing muốn nghe khi khách order:
```csharp
services.AddScoped<IEventHandler<GuestOrderCreatedEvent>, BillingReceiverHandler>();
```

**Không sửa code CustomerOrdering.** Đó là lợi ích Modular Monolith.

---

## 5. Thử API bằng curl

### 5.1 Lấy QR secret
```bash
docker exec -it restomanager-postgres psql -U postgres -d restaurant_db -c \
  "SELECT table_code, qr_secret FROM table_qr_configs WHERE table_code='T1-01';"
```

### 5.2 Sinh QR token (HMAC-SHA256)
```bash
TABLE_CODE="T1-01"
QR_SECRET="<dán secret>"
QR_TOKEN=$(echo -n "$TABLE_CODE" | openssl dgst -sha256 -hmac "$QR_SECRET" -binary | xxd -p -c 256)
```

### 5.3 Init session
```bash
curl -sS -X POST http://localhost:5000/public-api/session/init \
  -H "Content-Type: application/json" \
  -d "{ \"tableCode\": \"$TABLE_CODE\", \"qrToken\": \"$QR_TOKEN\" }" | jq
```

Response có `sessionToken` → `$SESSION_TOKEN`.

### 5.4 Menu
```bash
curl -sS http://localhost:5000/public-api/menu | jq
```

### 5.5 Tạo đơn
```bash
MENU_ITEM_ID=$(curl -sS http://localhost:5000/public-api/menu | jq -r '.items[0].id')

curl -sS -X POST http://localhost:5000/public-api/orders \
  -H "Content-Type: application/json" \
  -H "X-Session-Token: $SESSION_TOKEN" \
  -H "X-Request-Id: $(uuidgen)" \
  -H "X-Timestamp: $(date +%s)" \
  -d "{ \"items\": [{ \"menuItemId\": \"$MENU_ITEM_ID\", \"quantity\": 2 }] }" | jq
```

### 5.6 Xem đơn
```bash
curl -sS http://localhost:5000/public-api/orders -H "X-Session-Token: $SESSION_TOKEN" | jq
```

---

## 6. CI/CD GitHub Actions

File `.github/workflows/ci.yml` chạy khi push lên `main`/`develop`/`feature/*`:

| Job | Nội dung |
|---|---|
| `nodejs-build` | npm ci + lint + test |
| `dotnet-build` | dotnet restore + build Release |
| `docker-build` | build 3 image để verify Dockerfile |
| `deploy-staging` (manual) | SSH vào VPS deploy — KHÔNG auto |

VPS vẫn thuê. Deploy không auto để tránh build fail làm sập VPS (lời khuyên thầy).

Secrets GitHub cần set: `STAGING_HOST`, `STAGING_USER`, `STAGING_SSH_KEY`.

---

## 7. Áp dụng 12 buổi học

| Buổi | Minh chứng |
|---|---|
| 2-3 | SOLID (private setter, factory, OCP transition, DIP via IDateTimeProvider) |
| 4 | Clean Architecture (tinh thần — Domain pure, Infrastructure depend Domain) |
| 5 | USER appuser trong Dockerfile |
| 6 | Dockerfile 2 stage SDK → aspnet runtime |
| 7 | docker-compose 5 services + healthcheck |
| 8 | nginx.conf upstream customer_api + /public-api/ + limit_req_zone |
| 9 | Đọc image_url menu từ MinIO (bảng cũ) |
| 10 | GitHub Actions `.github/workflows/ci.yml` |
| 11 | 4 appsettings + 3 docker-compose + .env.example |
| **12** | **SharedKernel/ + Modules/CustomerOrdering/ + IModule + IEventBus** |

---

## 8. Troubleshooting

| Lỗi | Fix |
|---|---|
| `error NU1301` restore | Mạng chặn api.nuget.org — build trong Docker |
| customer-api không start | Postgres chưa healthy, đợi `database system is ready` |
| 401 missing_session_token | Call `/session/init` trước |
| 410 session_expired | Scan lại QR |
| 400 timestamp_out_of_range | Sync NTP ở máy client |
| 400 replay_detected | Mỗi POST tạo UUID mới cho X-Request-Id |
| 429 | Chờ 1 phút |
