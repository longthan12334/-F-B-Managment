# Hướng dẫn áp bộ BE-2 (nhiệm vụ Nghiệp vụ & Realtime)

**Đây là deliverable của người làm BE-2, nhánh Git `feature/BE-2-business-realtime`, tách biệt với BE-1.**

BE-1 đã merge vào `main` trước đó (nhánh `feature/BE-1-slim`). BE-2 base trên code BE-1.

---

## 1. Áp dụng vào repo local

```bash
cd /path/to/fb-mgmt

# 1.1. Phải pull main mới nhất (có BE-1 đã merge)
git checkout main
git pull origin main

# 1.2. Tạo nhánh riêng cho BE-2 (TÁCH BIỆT với BE-1)
git checkout -b feature/BE-2-business-realtime

# 1.3. Giải nén zip BE-2 và sao chép
unzip BE2-complete.zip -d BE2-apply/
cd BE2-apply/

# customer-api: thay cả folder (code BE-2 đã append vào 5 file có sẵn của BE-1)
rm -rf /path/to/fb-mgmt/customer-api/
cp -r customer-api/ /path/to/fb-mgmt/

# back-end: 2 migration mới + 1 controller + 1 route + app.js sửa
cp back-end/migrations/007_guest_order_feedback_and_staff_calls.sql \
   /path/to/fb-mgmt/back-end/migrations/
cp back-end/migrations/008_orders_source_tracking.sql \
   /path/to/fb-mgmt/back-end/migrations/
cp back-end/src/controllers/qrOrderingController.js \
   /path/to/fb-mgmt/back-end/src/controllers/
cp back-end/src/routes/qrOrderingRoutes.js \
   /path/to/fb-mgmt/back-end/src/routes/
cp back-end/app.js /path/to/fb-mgmt/back-end/
```

**Không ghi đè** các file khác (Dockerfile, docker-compose, nginx.conf, .env.example, workflows) — chúng từ BE-1, chỉ copy vào zip cho đủ bộ.

## 2. Verify + commit lên nhánh BE-2

```bash
cd /path/to/fb-mgmt

# Review changes
git status
git diff back-end/app.js   # register 2 route mới

# Stage files
git add customer-api/ \
        back-end/migrations/007_guest_order_feedback_and_staff_calls.sql \
        back-end/migrations/008_orders_source_tracking.sql \
        back-end/src/controllers/qrOrderingController.js \
        back-end/src/routes/qrOrderingRoutes.js \
        back-end/app.js

# Commit
git commit -m "feat(BE-2): 5 endpoint khách + 6 endpoint staff + snapshot ghép order"

# Push lên nhánh RIÊNG
git push -u origin feature/BE-2-business-realtime
```

## 3. Mở Pull Request

Vào GitHub repo `longthan12334/-F-B-Managment`:
1. Click "Compare & pull request" cho nhánh `feature/BE-2-business-realtime`
2. Base: `main` ← Compare: `feature/BE-2-business-realtime`
3. Title: `BE-2: Nghiệp vụ & Realtime (5 endpoint khách + 6 endpoint staff + snapshot ghép order)`
4. Description: link `customer-api/GHI_CHU_TRUONG_NHOM_BE2.md` để trưởng nhóm review nhanh
5. Request review từ trưởng nhóm

## 4. Chạy thử local (trước khi push PR)

```bash
cp .env.example .env  # đã có từ BE-1
docker compose up -d --build
docker compose logs -f customer-api
```

Khi `Now listening on: http://[::]:5000` → OK.

Migration 007 + 008 tự chạy khi Node.js backend khởi động.

Verify bảng mới:
```bash
docker exec -it restomanager-postgres psql -U postgres -d restaurant_db -c \
  "\dt guest_order_feedback staff_calls" && \
docker exec -it restomanager-postgres psql -U postgres -d restaurant_db -c \
  "SELECT source, COUNT(*) FROM orders GROUP BY source;"
```

## 5. Flow test end-to-end 7 bước

Theo kịch bản demo giảng viên:

1. Khách scan QR → `POST /session/init` → có `sessionToken`
2. Khách gọi đơn → `POST /orders` → status='pending_confirmation'
3. Staff login + `GET /api/guest-orders/pending` → thấy đơn mới
4. Staff `POST /api/guest-orders/{id}/confirm` → đơn chuyển 'confirmed' + xuất hiện trong `orders` với `source='guest_qr'`
5. Khách polling `GET /orders/{id}` → thấy status='confirmed'
6. (Giả lập) `UPDATE guest_orders SET status='served' WHERE id='...';`
7. Khách feedback: `POST /orders/{id}/feedback` {rating:5, comment:"ngon"}

Bonus: Khách bấm `POST /call-staff` → `GET /api/staff-calls/pending` thấy yêu cầu.

## 6. Danh sách file BE-2 đã làm

### customer-api (sửa — thay cả folder nhưng chỉ 5 file có nội dung mới)

| File | Loại |
|---|---|
| `Modules/CustomerOrdering/Domain.cs` | Sửa (+1 enum + 2 entity) |
| `Modules/CustomerOrdering/Infrastructure.cs` | Sửa (+2 DbSet + config) |
| `Modules/CustomerOrdering/Services.cs` | Sửa (+4 method + 1 service) |
| `Modules/CustomerOrdering/Api.cs` | Sửa (+5 DTO + 4 action + 1 controller) |
| `Modules/CustomerOrdering/CustomerOrderingModule.cs` | Sửa (+DI + rate limit) |
| `README.md` | Sửa nhẹ (thêm section 5 — list đủ 10+6 endpoint) |
| `NHATKY_BE2.md` | **MỚI** — nhật ký của người BE-2 |
| `GHI_CHU_TRUONG_NHOM_BE2.md` | **MỚI** — ghi chú gửi trưởng nhóm review |

### back-end (Node.js)

| File | Loại |
|---|---|
| `migrations/007_guest_order_feedback_and_staff_calls.sql` | Mới |
| `migrations/008_orders_source_tracking.sql` | Mới |
| `src/controllers/qrOrderingController.js` | Mới (gộp staff confirm/reject + staff-call ack/done trong 1 file — tinh thần slim) |
| `src/routes/qrOrderingRoutes.js` | Mới (export 2 router) |
| `app.js` | Sửa (register 2 route) |

### GIỮ NGUYÊN (không đụng, lịch sử của BE-1)

- `customer-api/NHATKY.md` — nhật ký của người BE-1
- `customer-api/GHI_CHU_TRUONG_NHOM.md` — gửi trưởng nhóm từ BE-1
- `customer-api/HUONG_DAN.md` — hướng dẫn của BE-1
- `customer-api/Program.cs` — không đổi
- `customer-api/SharedKernel.cs` — không đổi
- Tất cả file trong `front-end/`, `docker-compose*.yml`, `.github/workflows/`, `.env.example` — không đổi

## 7. Checklist sau khi áp

- [ ] `docker compose up -d --build` không lỗi
- [ ] 2 bảng mới + 2 cột mới trên `orders` xuất hiện
- [ ] 10 endpoint khách + 6 endpoint staff hoạt động
- [ ] Rate limit `call-staff` chặn request thứ 3 trong 1 phút → 429
- [ ] Cashier flow cũ vẫn checkout được đơn QR qua giao diện invoices
- [ ] PR mở với docs rõ ràng, chờ trưởng nhóm review

## 8. Lưu ý

- **Nhánh BE-2 tách biệt** với nhánh BE-1 — không ghi đè code BE-1.
- **Docs BE-1 không đổi** — giữ lịch sử ai làm phần nào.
- Nếu trưởng nhóm chưa merge BE-1 vào `main`, phải merge BE-1 trước rồi mới làm BE-2.
- Nếu BE-1 có cập nhật sau khi mình fork, cần `git rebase main` để tránh conflict.
