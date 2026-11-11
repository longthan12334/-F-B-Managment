# Đặc tả API — RestoManager v3

Tài liệu API được **sinh tự động** và luôn khớp với mã nguồn đang chạy.
Ba nguồn tham khảo, theo thứ tự ưu tiên:

| Nguồn | Địa chỉ | Nội dung |
|---|---|---|
| **Swagger UI** | `/api/docs` | Tra cứu và **gọi thử** trực tiếp từ trình duyệt |
| **OpenAPI 3.0** | `/api/openapi.json` | Đặc tả máy đọc được (sinh Postman collection, client SDK…) |
| **Bản đồ kiến trúc** | `/api/architecture` | Module nào sở hữu đường dẫn nào, phụ thuộc ra sao |

Bảng tổng hợp 46 endpoint kèm quyền hạn: xem
**[Phần G — Đặc tả API](../BAO_CAO_DU_AN.md#phần-g--đặc-tả-api)** trong báo cáo dự án.

---

## Thay đổi so với phiên bản 2

| Phiên bản 2 | Phiên bản 3 | Lý do |
|---|---|---|
| `POST /api/orders/:id/checkout` | **`POST /api/invoices`** | Hoá đơn thuộc module `billing` — endpoint đặt theo quyền sở hữu dữ liệu. *Endpoint cũ vẫn hoạt động, có header `Deprecation: true`.* |
| `POST /api/tables/:id/clear` | **`POST /api/orders/clear-table/:tableId`** | Dọn bàn ghi vào bảng `orders` của module `ordering` |
| `GET /api/public/menu/:tableCode` | **`GET /api/public/menu`** *(cần `X-Guest-Token`)* | Thực đơn gắn với phiên khách, không gắn với mã bàn trên URL |
| `POST /api/public/order/:tableCode` | **`POST /api/public/orders`** *(cần `X-Guest-Token`)* | Khách phải mở phiên trước khi gọi món |
| *(không có)* | **`GET /api/public/orders`** | ⭐ Lịch sử đặt món của khách |
| *(không có)* | **`POST /api/public/session/:qrKey`** | ⭐ Mở phiên khách |
| *(không có)* | **`POST /api/orders/guest-requests/:id/review`** | ⭐ Duyệt/từ chối món khách gọi |
| *(không có)* | **`GET /api/guest-requests/pending`** | ⭐ Hàng đợi yêu cầu chờ duyệt |
| *(không có)* | `GET /api/architecture` | Bản đồ module sinh từ mã nguồn |
| *(không có)* | `POST /api/tables/:id/rotate-qr` | Cấp lại mã QR cho bàn |

## Hai loại xác thực

| Loại | Header | Dành cho |
|---|---|---|
| `bearerAuth` | `Authorization: Bearer <access token>` | Nhân viên (admin / thu ngân / phục vụ) |
| `guestToken` | `X-Guest-Token: <guest token>` | Khách quét mã QR tại bàn |

## Envelope phản hồi

```jsonc
// Thành công
{ "success": true, "data": …, "message": "", "meta": { "total": 14, "page": 1 } }

// Thất bại
{ "success": false, "message": "Dữ liệu không hợp lệ",
  "error": { "code": "VALIDATION_ERROR", "details": [...], "request_id": "..." } }
```

**Mọi số tiền là số nguyên đồng VND.**
