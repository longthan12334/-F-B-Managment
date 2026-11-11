# RestoManager — Hệ thống Quản lý Nhà hàng & Đặt món tại bàn

**Kiến trúc Modular Monolith · Docker Compose · Lưu trữ MinIO/S3/R2 · Triển khai VPS với Cloudflare**

[![Modules](https://img.shields.io/badge/module-8-orange)]()
[![Tests](https://img.shields.io/badge/ki%E1%BB%83m%20th%E1%BB%AD-109%20%C4%91%E1%BA%A1t-brightgreen)]()
[![Node](https://img.shields.io/badge/node-20-green)]()
[![PostgreSQL](https://img.shields.io/badge/postgresql-16-blue)]()

---

## Tài liệu

| Tệp | Nội dung |
|---|---|
| 📘 **[BAO_CAO_DU_AN.md](BAO_CAO_DU_AN.md)** | **Báo cáo dự án đầy đủ** — yêu cầu chức năng/phi chức năng, sơ đồ phân rã chức năng, thiết kế hệ thống, ERD và từ điển dữ liệu |
| 🚀 **[DEPLOYMENT.md](DEPLOYMENT.md)** | Hướng dẫn triển khai VPS + tên miền + Cloudflare, từng bước |
| 🖼️ `docs/diagrams/` | 25 sơ đồ dạng PNG (ERD, phân rã chức năng, kiến trúc, tuần tự) |
| 📷 `docs/screenshots/` | Ảnh chụp màn hình thực tế |
| 📖 `/api/docs` | Swagger UI (khi hệ thống đang chạy) |
| 🧭 `/api/architecture` | Bản đồ module & phụ thuộc, **sinh từ mã nguồn** |

---

## Chạy thử trong 2 phút

```bash
cp .env.example .env
docker compose up -d --build
```

| Dịch vụ | Địa chỉ |
|---|---|
| Ứng dụng web | http://localhost:8080 |
| Tài liệu API | http://localhost:3000/api/docs |
| Bản đồ kiến trúc | http://localhost:3000/api/architecture |
| MinIO Console | http://localhost:9001 |

**Tài khoản mẫu** (mật khẩu `123`): `admin` · `cashier` · `waiter`

> ⚠️ Đổi mật khẩu và đặt `SEED_ON_BOOT=false` trước khi dùng thật.

### Thử luồng khách quét mã QR

1. Đăng nhập `admin` → **Bàn** → nút **QR** của một bàn → in hoặc chụp màn hình
2. Mở link `/order/<qr_slug>` trên điện thoại (hoặc chế độ responsive của trình duyệt)
3. Gọi vài món → mở tab khác đăng nhập `cashier` → **Khách gọi**
4. Bấm **Xác nhận** → màn hình khách tự cập nhật, không cần tải lại

---

## Kiến trúc

### Tám module nghiệp vụ

```
identity → dining → catalog → ordering → billing → analytics → auditing → guest-access
```

| Module | Vai trò | Bảng sở hữu |
|---|---|---|
| `identity` | Tài khoản, xác thực JWT, phân quyền | `users`, `refresh_tokens` |
| `catalog` | Thực đơn, giá, ảnh món | `menu_categories`, `menu_items` |
| `dining` | Khu vực, bàn, mã QR, trạng thái bàn | `dining_zones`, `tables`, `dining_table_state` |
| `ordering` | Đơn hàng, dòng món, duyệt món khách | `orders`, `order_items` |
| `billing` | Tính tiền, hoá đơn | `invoices`, `invoice_items` |
| `guest-access` | Phiên khách QR, lịch sử gọi món | `guest_sessions`, `guest_order_requests` |
| `analytics` | Báo cáo doanh thu (CQRS read model) | `analytics_revenue_hourly`, `analytics_item_sales` |
| `auditing` | Nhật ký hoạt động | `activity_logs` |

### Ba cơ chế giữ ranh giới module

1. **Contract công khai** — module khác chỉ được `require('modules/X/contract')`
2. **Event Bus** — tách rời hoàn toàn; `auditing` nghe `'*'` bằng **một dòng**
3. **Kiểm tra tự động** — `npm run check:boundaries` với 5 quy tắc, chạy trong CI/deploy

```bash
$ cd back-end && npm run check:boundaries

Quyền sở hữu bảng CSDL:
  identity       → users, refresh_tokens
  catalog        → menu_categories, menu_items
  dining         → dining_zones, tables, dining_table_state
  ordering       → orders, order_items
  billing        → invoices, invoice_items
  guest-access   → guest_sessions, guest_order_requests
  analytics      → analytics_revenue_hourly, analytics_item_sales
  auditing       → activity_logs

✓ Không phát hiện vi phạm ranh giới module.
```

### Mỗi module tự chứa

```
modules/ordering/
├── index.js          ← manifest: dependsOn, owns, router, sự kiện
├── contract.js       ← bề mặt công khai duy nhất
├── domain/           ← quy tắc nghiệp vụ thuần tuý (kiểm thử không cần CSDL)
├── application/      ← use-case, điều phối giao dịch
├── infrastructure/   ← SQL (nơi DUY NHẤT chạm CSDL)
├── interface/        ← REST
└── migrations/       ← lược đồ bảng module này sở hữu
```

---

## Tính năng

### 👤 Khách hàng — quét QR tự gọi món

- Quét mã QR trên bàn, **không cần cài app, không cần đăng ký**
- Phiên riêng có thời hạn, tải lại trang không mất giỏ hàng
- Xem thực đơn, tìm kiếm, lọc theo danh mục
- **"Đơn của tôi"** — lịch sử từng lần gửi, trạng thái từng món, lý do bị từ chối
- Nhân viên duyệt → màn hình tự cập nhật, không cần F5

### 🧑‍🍳 Nhân viên phục vụ

- Sơ đồ bàn theo khu vực, trạng thái thời gian thực
- Mở đơn, thêm/sửa/xoá món
- **Duyệt hoặc từ chối món khách gọi qua QR** (cả lượt hoặc từng món)

### 💵 Thu ngân

- Thanh toán, VAT, giảm giá, tiền thừa, 9 phương thức thanh toán
- **Bị chặn thanh toán khi đơn còn món khách gọi chưa duyệt**
- Chuyển bàn, dọn bàn, thống kê ca

### ⚙️ Quản trị viên

- Quản lý nhân viên, thực đơn (có ảnh), bàn và mã QR
- Dashboard doanh thu, món bán chạy, biểu đồ theo giờ
- Nhật ký hoạt động tự động, tra cứu theo đối tượng

---

## Công nghệ

| Lớp | Công nghệ |
|---|---|
| Backend | Node.js 20 · Express 4 · Socket.IO 4 |
| CSDL | PostgreSQL 16 |
| Lưu trữ | MinIO / AWS S3 / Cloudflare R2 *(đổi bằng biến môi trường)* |
| Frontend | React 18 · Vite 5 · Tailwind 3 · lucide-react |
| Mobile | Expo · React Native |
| Triển khai | Docker Compose · Caddy *(HTTPS tự động)* · Cloudflare |

---

## Lệnh hữu ích

```bash
# ─── Phát triển ───────────────────────────────────────────
docker compose up -d --build
docker compose logs -f backend

cd back-end
npm run dev                  # tự động tải lại
npm test                     # 24 kiểm thử đơn vị (94 ms)
npm run check:boundaries     # kiểm tra ranh giới module
npm run arch:graph           # sinh sơ đồ kiến trúc từ mã nguồn
npm run verify               # ranh giới + kiểm thử đơn vị
node tests/e2e-smoke.js      # 75 kiểm thử đầu-cuối
node tests/realtime-smoke.js # 10 kiểm thử WebSocket

# ─── Production ───────────────────────────────────────────
./deploy/deploy.sh           # triển khai có tự kiểm chứng + đường lùi
```

---

## Chuyển kho ảnh sang Cloudflare R2

Không cần sửa một dòng mã nghiệp vụ nào — chỉ đổi biến môi trường:

```env
STORAGE_DRIVER=r2
S3_ENDPOINT=<account_id>.r2.cloudflarestorage.com
S3_PORT=443
S3_USE_SSL=true
S3_REGION=auto
S3_ACCESS_KEY=<R2 Access Key>
S3_SECRET_KEY=<R2 Secret Key>
S3_PUBLIC_URL=https://cdn.nhahang.cua-ban.vn
```

Chi tiết (kèm lệnh `rclone` chuyển dữ liệu cũ): [DEPLOYMENT.md mục 8](DEPLOYMENT.md#8-chuyển-kho-ảnh-sang-cloudflare-r2)

---

## Kiểm thử

| Loại | Số ca | Thời gian | Lệnh |
|---|:---:|---|---|
| Đơn vị — tầng domain | 24 | 94 ms | `npm test` |
| Ranh giới kiến trúc | 5 quy tắc / 78 tệp | < 1 s | `npm run check:boundaries` |
| Đầu-cuối API | 75 | ~8 s | `node tests/e2e-smoke.js` |
| Thời gian thực | 10 | ~5 s | `node tests/realtime-smoke.js` |

---

## Giấy phép

Phát hành cho mục đích học tập và sử dụng nội bộ.
