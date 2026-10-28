# Ghi chú & đề xuất gửi trưởng nhóm

**Người gửi:** Thành viên BE-1
**Ngày:** 2026-10-27
**Chủ đề:** Áp dụng **Modular Monolith** (Buổi 12 — yêu cầu bắt buộc của môn) + đổi Jenkins sang GitHub Actions

---

## 1. Vì sao refactor sang Modular Monolith

Trưởng nhóm commit code gốc theo pattern **MVC flat** (`back-end/src/{controllers,services,models,routes}/`). Pattern này không khớp yêu cầu môn học Buổi 12 — kiến trúc **bắt buộc là Modular Monolith**.

Em đã refactor code BE-1 của em (customer-api .NET) theo đúng Modular Monolith:
- 1 deployable, nhiều module tách bounded context.
- Mỗi module có Domain/Application/Infrastructure/Presentation riêng.
- SharedKernel chứa primitive, event bus, middleware chung.
- Giao tiếp giữa module qua `IEventBus` (in-memory, swap sang Redis/RabbitMQ dễ).

**Phần của em (customer-api) hiện đã theo chuẩn.** Phần Node.js (code anh/chị commit) chưa khớp. Em đề xuất bên dưới cách tổ chức lại — tối thiểu để pass yêu cầu môn học.

---

## 2. Đề xuất tổ chức lại Node.js backend

### 2.1 Hiện trạng (code anh/chị commit)

```
back-end/src/
├── controllers/          ← 10 controller flat (auth, menu, order, invoice, …)
├── services/             (ít)
├── models/               ← 7 model
├── routes/               ← 10 route
├── middleware/
├── realtime/
└── database/
```

Flat không có bounded context — không khớp Modular Monolith.

### 2.2 Đề xuất (minh hoạ)

Giữ nguyên 100% code logic, **chỉ di chuyển file theo module**:

```
back-end/src/
├── shared/                       ← CHUNG mọi module (giống SharedKernel .NET)
│   ├── middleware/               (auth.js, errorHandler.js, rateLimiter.js)
│   ├── utils/                    (response.js)
│   ├── database/                 (db.js)
│   ├── storage/                  (minio.js)
│   ├── realtime/                 (io.js)
│   └── eventBus.js               ← mới: EventEmitter in-process
│
├── modules/
│   ├── identity/                 ← Users + auth
│   │   ├── controllers/authController.js, userController.js
│   │   ├── models/User.js, RefreshToken.js
│   │   └── routes/authRoutes.js, userRoutes.js
│   │
│   ├── menu/                     ← Menu + categories
│   │   ├── controllers/menuController.js, fileController.js
│   │   ├── models/MenuItem.js
│   │   └── routes/menuRoutes.js, fileRoutes.js
│   │
│   ├── tables/                   ← Table management
│   │   ├── controllers/tableController.js
│   │   ├── models/Table.js
│   │   └── routes/tableRoutes.js
│   │
│   ├── ordering/                 ← Staff orders (đồng cấp với customer-api CustomerOrdering)
│   │   ├── controllers/orderController.js
│   │   ├── models/Order.js
│   │   └── routes/orderRoutes.js
│   │
│   ├── billing/                  ← Invoices + payment
│   │   ├── controllers/invoiceController.js
│   │   ├── models/Invoice.js
│   │   └── routes/invoiceRoutes.js
│   │
│   └── reporting/                ← Stats + logs
│       ├── controllers/statController.js, logController.js
│       ├── models/Log.js
│       └── routes/statRoutes.js, logRoutes.js
│
└── app.js                        ← chỉ require các module.register(app)
```

### 2.3 Pattern module registration (giống `IModule` của em)

Mỗi module có `index.js` export hàm `register(app)`:

```javascript
// back-end/src/modules/menu/index.js
const menuRoutes = require('./routes/menuRoutes');
const fileRoutes = require('./routes/fileRoutes');

module.exports = {
  name: 'Menu',
  register(app) {
    app.use('/api/menu', menuRoutes);
    app.use('/api/files', fileRoutes);
  },
};
```

```javascript
// back-end/app.js (new)
const modules = [
  require('./src/modules/identity'),
  require('./src/modules/menu'),
  require('./src/modules/tables'),
  require('./src/modules/ordering'),
  require('./src/modules/billing'),
  require('./src/modules/reporting'),
];
modules.forEach(m => m.register(app));
```

### 2.4 Event bus Node.js (tương đương IEventBus của em)

```javascript
// back-end/src/shared/eventBus.js
const EventEmitter = require('events');
class EventBus extends EventEmitter {}
module.exports = new EventBus();
```

Dùng:
```javascript
// ordering module khi tạo order
eventBus.emit('order.created', { orderId, tableCode, total });

// billing module lắng nghe
eventBus.on('order.created', async (data) => {
  // update dashboard stats, cache invoice draft, ...
});
```

### 2.5 Công sức

Em ước lượng ~2-3 giờ cho 1 người: chỉ **di chuyển file** theo folder module + sửa đường dẫn `require()`. KHÔNG đụng logic. Risk thấp.

---

## 3. Quyết định đã làm

Những gì em đã sửa thẳng vào code customer-api BE-1 (bản mới):

### 3.1 Kiến trúc

- Xoá structure flat (`Models/`, `Services/`, `Controllers/`, `Dtos/`, `Security/`, `Data/`).
- Tạo `SharedKernel/` + `Modules/CustomerOrdering/{Domain,Application,Infrastructure,Presentation}`.
- Tạo `IModule` interface + `CustomerOrderingModule.cs` register central.
- Tạo `IEventBus` + `InMemoryEventBus` dispatch qua `IEventHandler<T>`.
- `GuestOrder.Finalize()` phát `GuestOrderCreatedEvent` → DbContext tự dispatch sau save.

### 3.2 CI/CD

- **Xoá `Jenkinsfile`** ở root repo.
- **Tạo `.github/workflows/ci.yml`** với 4 job: nodejs-build / dotnet-build / docker-build / deploy-staging (manual).

### 3.3 VPS

- VPS vẫn thuê (như anh/chị nói, cho đồ án giống thật).
- Deploy VPS vẫn qua `docker compose -f docker-compose.yml -f docker-compose.staging.yml up -d`.
- CHỈ ĐỔI: build chạy trên runner của GitHub (không tốn tài nguyên VPS), deploy KHÔNG tự động — chỉ chạy khi click manual trong tab Actions.
- Lý do (thầy đã nói): auto deploy có thể làm sập VPS khi build fail. Giữ manual = chủ động chọn thời điểm.

---

## 4. Những điểm cần anh/chị quyết

1. **Modularize Node.js:** anh/chị có đồng ý em làm giúp luôn (~3h)? Hay giao cho ai khác, hoặc anh/chị tự làm?
2. **Chuẩn tên module:** em đặt `Modules/CustomerOrdering/` cho .NET. Tương đương Node.js em đề xuất `modules/ordering/` (chuyên đơn staff), `modules/customer-ordering/` nếu muốn đồng bộ hoàn toàn. Anh/chị chọn?
3. **GitHub Secrets cho CI:** cần set `STAGING_HOST`, `STAGING_USER`, `STAGING_SSH_KEY` trong GitHub Settings. Em không có quyền này. Anh/chị set giúp.
4. **Branch model:** em đề xuất Git Flow 3 nhánh (`main` = production, `staging` = tích hợp, `develop` = tích hợp sớm). Hiện repo chỉ có `main`. Anh/chị tạo thêm `develop` và `staging` hộ.
5. **Khi tách module Node.js có cần đổi URL API không?** Em đề xuất GIỮ URL cũ (vd `/api/menu`) để FE cũ không break. Chỉ đổi tổ chức code bên trong.

---

## 5. Rủi ro & giảm thiểu

| Rủi ro | Giảm thiểu |
|---|---|
| Refactor Node.js có thể break app staff | Chỉ di chuyển file, không đổi logic. Test smoke 10 phút trước khi push `main` |
| Giảng viên hỏi "modular monolith là gì" | README customer-api/ mục 2-3-4 đã viết sẵn giải thích + ví dụ thêm module |
| CI/CD fail làm trễ demo | GitHub Actions free tier 2000 phút/tháng — thừa cho scope dự án |
| Deploy VPS fail | KHÔNG auto deploy (lời thầy). Em chọn manual, có thể test staging trước khi production |

---

## 6. Timeline đề xuất

| Ngày | Việc | Người |
|---|---|---|
| 1 | Em áp dụng BE-1 code mới vào feature branch | Em |
| 2 | Anh/chị review PR BE-1 — chốt đồng ý Modular Monolith | Trưởng nhóm |
| 3 | Modularize Node.js backend (nếu đồng ý em làm) | Em / người được giao |
| 4-5 | BE-2 làm tiếp (6 endpoint khách + staff xác nhận) | Bạn BE-2 |
| 6-7 | FE-1 làm customer web | Bạn FE-1 |
| 8 | Test integration end-to-end + chuẩn bị demo | Cả team |

---

## 7. Nếu anh/chị không đồng ý Modular Monolith

Em vẫn có thể giữ code BE-1 ở version cũ (1 project chia folder flat theo chức năng). Nhưng vậy sẽ không đáp ứng Buổi 12 — em lo lúc demo thầy hỏi "Modular Monolith thể hiện ở đâu" sẽ không trả lời rõ. Em đề xuất đi theo bản mới.

Em để sẵn 2 bản zip trong local của em, nếu anh/chị muốn em có thể gửi lại bản cũ.
