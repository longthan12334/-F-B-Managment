# RestoManager — customer-api (BE-1)

**Nhiệm vụ:** Nền tảng .NET cho hệ thống gọi món QR — lược đồ dữ liệu, vòng đời phiên, lớp bảo vệ trang công khai.

**Kiến trúc (bắt buộc Buổi 12):** Modular Monolith — 1 deployable, chia bounded context thành module, giao tiếp qua event bus. Clean Architecture chỉ áp dụng **tinh thần** (gộp file để dễ nhìn).

**Stack:** .NET 10 · EF Core 10 · PostgreSQL · Serilog · GitHub Actions (CI/CD)

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
