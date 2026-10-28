# Hướng dẫn áp BE-2 slim (áp vào BE-1 slim có sẵn)

## 1. Áp dụng

```bash
unzip BE2-slim.zip -d BE2-slim/
cd BE2-slim/

# QUAN TRỌNG: áp SAU BE-1 slim. Nếu chưa có BE-1, apply BE-1 trước.

# customer-api — thay thế cả folder (code BE-2 đã append vào 5 file có sẵn)
rm -rf /path/to/fb-mgmt/customer-api/
cp -r customer-api/ /path/to/fb-mgmt/

# back-end — 4 file BE-2 mới + app.js sửa + 2 migration mới
cp back-end/migrations/*.sql       /path/to/fb-mgmt/back-end/migrations/
cp back-end/src/controllers/*.js   /path/to/fb-mgmt/back-end/src/controllers/
cp back-end/src/routes/*.js        /path/to/fb-mgmt/back-end/src/routes/
cp back-end/app.js                 /path/to/fb-mgmt/back-end/
cp back-end/Dockerfile             /path/to/fb-mgmt/back-end/
cp back-end/.dockerignore          /path/to/fb-mgmt/back-end/

# Phần dùng chung (giữ nguyên từ BE-1 slim)
cp front-end.nginx.conf            /path/to/fb-mgmt/front-end/nginx.conf
cp docker-compose.yml              /path/to/fb-mgmt/
cp docker-compose.override.yml     /path/to/fb-mgmt/
cp docker-compose.staging.yml      /path/to/fb-mgmt/
cp .env.example                    /path/to/fb-mgmt/

mkdir -p /path/to/fb-mgmt/.github/workflows
cp .github/workflows/ci.yml        /path/to/fb-mgmt/.github/workflows/
```

## 2. Commit

```bash
cd /path/to/fb-mgmt
git checkout -b feature/BE-2-slim

git add customer-api/ \
        back-end/migrations/007_guest_order_feedback_and_staff_calls.sql \
        back-end/migrations/008_orders_source_tracking.sql \
        back-end/src/controllers/guestOrderController.js \
        back-end/src/controllers/staffCallController.js \
        back-end/src/routes/guestOrderRoutes.js \
        back-end/src/routes/staffCallRoutes.js \
        back-end/app.js

git commit -m "feat(BE-2): 5 endpoint khách + 6 endpoint staff + snapshot sang orders cũ"
git push -u origin feature/BE-2-slim
```

## 3. Chạy thử

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f customer-api
```

Khi `Now listening on: http://[::]:5000` → OK.

Migration 007 + 008 tự chạy khi Node.js backend khởi động (loader đọc mọi file `.sql`).

Verify 3 bảng mới:
```bash
docker exec -it restomanager-postgres psql -U postgres -d restaurant_db -c \
  "\dt guest_order_feedback staff_calls" && \
docker exec -it restomanager-postgres psql -U postgres -d restaurant_db -c \
  "SELECT source, COUNT(*) FROM orders GROUP BY source;"
```

## 4. Những gì mới so với BE-1 slim

### customer-api/ — vẫn 7 file .cs
BE-2 features **append vào 5 file có sẵn**, KHÔNG tạo file mới trong module:

| File .cs | Thêm gì cho BE-2 |
|---|---|
| `Domain.cs` | +1 enum (StaffCallStatus) + 2 entity (GuestOrderFeedback, StaffCall) + mapping |
| `Infrastructure.cs` | +2 DbSet + 2 entity config trong OnModelCreating |
| `Services.cs` | +4 method cho OrderService (GetByCode, GetReceipt, Cancel, Feedback) + StaffCallService class |
| `Api.cs` | +5 DTO + 4 action OrderController + StaffCallController class |
| `CustomerOrderingModule.cs` | +StaffCallService DI + rate limit "call-staff" policy |

### back-end/ — 4 file mới + 1 sửa + 2 migration

- `migrations/007_guest_order_feedback_and_staff_calls.sql`
- `migrations/008_orders_source_tracking.sql`
- `src/controllers/guestOrderController.js` — list pending, confirm (snapshot sang orders cũ), reject
- `src/controllers/staffCallController.js` — list, acknowledge, done
- `src/routes/guestOrderRoutes.js`, `src/routes/staffCallRoutes.js`
- `app.js` — register 2 route mới

## 5. 10 endpoint khách (BE-1 + BE-2)

Public khách:
1. `POST /public-api/session/init` (BE-1)
2. `GET  /public-api/menu` (BE-1)
3. `POST /public-api/orders` (BE-1)
4. `GET  /public-api/orders` (BE-1)
5. `GET  /public-api/orders/{id}` (BE-1)
6. `GET  /public-api/orders/by-code/{code}` (BE-2 — không auth)

Cần session (BE-2):
7. `GET  /public-api/orders/{id}/receipt`
8. `POST /public-api/orders/{id}/cancel`
9. `POST /public-api/orders/{id}/feedback`
10. `POST /public-api/call-staff`

Staff Node.js (BE-2):
- `GET  /api/guest-orders/pending`
- `POST /api/guest-orders/{id}/confirm`
- `POST /api/guest-orders/{id}/reject`
- `GET  /api/staff-calls/pending`
- `POST /api/staff-calls/{id}/acknowledge`
- `POST /api/staff-calls/{id}/done`

## 6. Test end-to-end 7 bước

1. Khách scan QR → `POST /session/init` → có `sessionToken`
2. Khách gọi đơn → `POST /orders` → status='pending_confirmation'
3. Staff login → `GET /api/guest-orders/pending` → thấy đơn mới
4. Staff `POST /api/guest-orders/{id}/confirm` → đơn chuyển 'confirmed' + xuất hiện trong bảng `orders` với source='guest_qr'
5. Khách polling `GET /orders/{id}` → thấy status='confirmed'
6. (Giả lập served) `UPDATE guest_orders SET status='served' WHERE id='...';`
7. Khách feedback: `POST /orders/{id}/feedback` {rating:5, comment:"ngon"}

## 7. Checklist

- [ ] `docker compose up -d --build` không lỗi
- [ ] 3 bảng mới hiện ra (`guest_order_feedback`, `staff_calls`, `orders.source`)
- [ ] 10 endpoint khách + 6 endpoint staff hoạt động
- [ ] Rate limit `call-staff` chặn request thứ 3 trong 1 phút → 429
- [ ] Cashier flow cũ vẫn checkout đơn QR qua giao diện invoices (`source='guest_qr'`)

## 8. Nguyên tắc giữ

- **Modular Monolith** không đổi — vẫn SharedKernel + Modules/CustomerOrdering + IModule + IEventBus.
- **7 file .cs** không đổi (chỉ dòng thêm vào, không tạo file mới trong module).
- **Logic nghiệp vụ BE-1** giữ nguyên 100% — chỉ thêm BE-2.
