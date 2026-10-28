# Ghi chú gửi trưởng nhóm — BE-2

**Người gửi:** Thành viên BE-2 (nhiệm vụ Nghiệp vụ & Realtime)
**Nhánh Git:** `feature/BE-2-business-realtime` (tách biệt với nhánh BE-1 đã merge)
**Ngày:** 2026-10-28

---

## 1. Tóm tắt những gì em làm

Nhận bài giao từ anh/chị:
- Viết 6 điểm cuối công khai (BE-2 ngoài 4 cái của BE-1)
- Ghép order của khách vào mô hình đơn hàng staff
- Luồng nhân viên xác nhận

Hiện trạng: anh/chị BE-1 đã merge xong phần nền tảng + bảo mật vào `main`. Em pull về, đọc code BE-1, nối tiếp theo đúng tinh thần slim (Modular Monolith, gộp file).

**KHÔNG đụng** code BE-1 — chỉ append nội dung mới vào các file có sẵn trong module `CustomerOrdering`, giữ nguyên 7 file `.cs` của bạn kia.

---

## 2. 5 endpoint khách mới (customer-api)

| # | Method · Path | Mục đích | Rate limit |
|---|---|---|---|
| 1 | `GET  /public-api/orders/by-code/{code}` | Tra đơn qua mã (chia sẻ cho bạn) | `menu-read` 30/phút/IP, **không auth** |
| 2 | `GET  /public-api/orders/{id}/receipt` | Hóa đơn chi tiết (subtotal + VAT 8% + total) | `order-status` 20/phút |
| 3 | `POST /public-api/orders/{id}/cancel` | Khách tự hủy khi còn pending | `create-order` 3/phút |
| 4 | `POST /public-api/orders/{id}/feedback` | Rating 1-5 + comment | `create-order` 3/phút |
| 5 | `POST /public-api/call-staff` | Gọi nhân viên (nước, hotline, thanh toán) | **`call-staff` 2/phút** (mới, chặt chống spam) |

Em thiết kế thiếu 1 endpoint so với số "6" trong đề bài. Lý do: realtime để FE-1 polling endpoint `GET /orders/{id}` đã có của BE-1 (3-5 giây 1 lần). Nếu anh/chị muốn SSE riêng, em làm thêm sau.

## 3. 6 endpoint staff mới (Node.js)

Staff đã auth JWT qua Node.js — hợp lý để confirm/reject ở Node.js (không phải cross-service).

| # | Method · Path | Mục đích |
|---|---|---|
| 1 | `GET  /api/guest-orders/pending` | Dashboard list đơn chờ |
| 2 | `POST /api/guest-orders/:id/confirm` | Xác nhận + snapshot sang bảng `orders` cũ |
| 3 | `POST /api/guest-orders/:id/reject` | Từ chối (hết nguyên liệu) |
| 4 | `GET  /api/staff-calls/pending` | List yêu cầu "gọi nhân viên" |
| 5 | `POST /api/staff-calls/:id/acknowledge` | Tiếp nhận |
| 6 | `POST /api/staff-calls/:id/done` | Hoàn tất |

Em dùng `db.transaction()` + `SELECT FOR UPDATE` cho endpoint confirm — chống race condition khi 2 staff cùng click.

## 4. Snapshot pattern — ghép đơn khách vào bảng cũ

Khi staff confirm:

```
guest_orders (của BE-1)                 orders (bảng cũ của anh/chị)
  status='pending_confirmation'   →      INSERT với source='guest_qr'
                                         guest_order_id=<id gốc>
                                         code=<GST-...> (giữ nguyên)
  status='confirmed'              ←      (sau khi commit)
```

Migration 008 (`back-end/migrations/008_orders_source_tracking.sql`):
```sql
ALTER TABLE orders ADD COLUMN source TEXT
    NOT NULL DEFAULT 'staff'
    CHECK (source IN ('staff','guest_qr'));
ALTER TABLE orders ADD COLUMN guest_order_id UUID
    REFERENCES guest_orders(id) ON DELETE SET NULL;
```

**Lợi ích:**
- Cashier/invoice flow cũ KHÔNG đổi — vẫn đọc `orders`, vẫn checkout, vẫn ra invoice.
- Báo cáo doanh thu phân nguồn: `SELECT source, SUM(total_amount) FROM orders GROUP BY source`.
- Trace ngược từ `orders` về `guest_orders` qua `guest_order_id`.

**Trade-off:** dup data (1 row ở 2 bảng). Chấp nhận được vì scope nhỏ.

---

## 5. Những quyết định em đã mặc định — chỉ cần anh/chị xác nhận

Nếu anh/chị không ổn, báo em sửa. Nếu OK thì bỏ qua.

- **Snapshot code = giữ `GST-...`** khi copy sang `orders` (không sinh `ORD-` mới). Dễ trace.
- **Rate limit `call-staff` = 2/phút/session** — chặt hơn các policy khác chống spam.
- **Khách không hủy được khi đã confirmed** — phải gọi nhân viên. Logic transition BE-1 đã chặn sẵn.
- **Feedback chỉ cho khi `served`** (strict). Muốn relax cho `completed` thì sửa 1 dòng.
- **Realtime = polling** (`GET /orders/{id}` mỗi 3-5s). Không SSE để tránh phức tạp.
- **StaffCall gộp vào module `CustomerOrdering`** (cùng bounded context). Không tạo module riêng.

---

## 6. Những điểm cần anh/chị quyết

1. **Có SSE hay chỉ polling?** Em làm polling trước. Nếu anh/chị muốn SSE em làm thêm (~1-2 ngày).
2. **Format mã đơn khi snapshot** — giữ `GST-` hay sinh `ORD-` mới? Em giữ `GST-`.
3. **Policy cancellation sau khi staff đã confirm** — có cho khách hủy qua call-staff không, hay bắt buộc gọi trực tiếp? Em không cho qua API, FE-1 phải nói "gọi nhân viên".
4. **Realtime push cho FE-1 khi đơn chuyển `served`** — polling đủ hay cần Socket.IO/SSE? Em làm polling.

---

## 7. File em tạo/sửa (chi tiết review)

### Code

| Phần | File | Loại | Ghi chú |
|---|---|---|---|
| customer-api | `Modules/CustomerOrdering/Domain.cs` | Sửa | +1 enum + 2 entity (append cuối file, không đụng BE-1) |
| customer-api | `Modules/CustomerOrdering/Infrastructure.cs` | Sửa | +2 DbSet + 2 entity config |
| customer-api | `Modules/CustomerOrdering/Services.cs` | Sửa | +4 method OrderService + class StaffCallService |
| customer-api | `Modules/CustomerOrdering/Api.cs` | Sửa | +5 DTO + 4 action + class StaffCallController |
| customer-api | `Modules/CustomerOrdering/CustomerOrderingModule.cs` | Sửa | +StaffCallService DI + rate limit "call-staff" |
| back-end | `migrations/007_...sql` | Mới | guest_order_feedback + staff_calls |
| back-end | `migrations/008_...sql` | Mới | orders.source + guest_order_id |
| back-end | `src/controllers/guestOrderController.js` | Mới | list/confirm/reject |
| back-end | `src/controllers/staffCallController.js` | Mới | list/acknowledge/done |
| back-end | `src/routes/guestOrderRoutes.js` | Mới | 3 route với requireAuth + requireRole |
| back-end | `src/routes/staffCallRoutes.js` | Mới | 3 route |
| back-end | `app.js` | Sửa | Register 2 route mới |

### Docs

| File | Loại | Nội dung |
|---|---|---|
| `customer-api/NHATKY_BE2.md` | Mới | Nhật ký của em (BE-2) |
| `customer-api/GHI_CHU_TRUONG_NHOM_BE2.md` | Mới | File này |

**KHÔNG sửa:**
- `customer-api/README.md`, `NHATKY.md`, `HUONG_DAN.md`, `GHI_CHU_TRUONG_NHOM.md` của bạn BE-1 — em giữ nguyên để team có lịch sử rõ ai làm phần nào.
- Phần code BE-1 trong 5 file `.cs` — em chỉ append cuối hoặc trong các vị trí có comment `// BE-2`.

---

## 8. Vị trí file cần đọc để review nhanh (15 phút)

| Thứ tự | File | Review cái gì |
|---|---|---|
| 1 | `customer-api/NHATKY_BE2.md` | Em đã làm những bước gì, quyết định thế nào |
| 2 | `back-end/migrations/007_...sql`, `008_...sql` | Schema 2 bảng mới + ALTER orders |
| 3 | `back-end/src/controllers/guestOrderController.js` | Logic confirm (snapshot + transaction) |
| 4 | `customer-api/Modules/CustomerOrdering/Services.cs` dòng cuối | 4 method mới của OrderService + class StaffCallService |
| 5 | `customer-api/Modules/CustomerOrdering/Api.cs` dòng cuối | 4 action BE-2 + class StaffCallController |

---

## 9. Checklist khi merge PR

- [ ] 3 migration (006 + 007 + 008) chạy OK trên staging
- [ ] `docker compose up -d --build` không lỗi
- [ ] 10 endpoint khách (6 BE-1 + 5 BE-2 — Wait, đếm lại: 4 BE-1 + 5 BE-2 = 9, +1 health = 10) hoạt động
- [ ] 6 endpoint staff Node.js hoạt động
- [ ] `SELECT source FROM orders WHERE source='guest_qr' LIMIT 5` sau khi staff confirm → có row
- [ ] Cashier flow cũ checkout được đơn QR qua giao diện invoices
- [ ] Rate limit `call-staff` chặn request thứ 3 trong 1 phút

---

## 10. Timeline

Em làm **1.5 ngày** (28/10 sáng - chiều + sáng 29/10 cho test):

- 28/10 sáng: pull code BE-1, đọc, phân tích, thiết kế 6+6 endpoint
- 28/10 chiều: viết code (2 migration + 4 Node.js file + 5 file .NET append)
- 28/10 tối: test end-to-end, verify snapshot pattern
- 29/10 sáng: push PR + review GHI_CHU này

Chờ anh/chị review PR. Em để sẵn Zalo/Discord trả lời nhanh.
