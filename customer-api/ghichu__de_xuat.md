#


**Chủ đề:** Áp dụng **Modular Monolith** (Buổi 12 — yêu cầu bắt buộc của môn) + đổi Jenkins sang GitHub Actions

---

## 1. Vì sao refactor sang Modular Monolith

Trưởng nhóm commit code gốc theo pattern **MVC flat** (`back-end/src/{controllers,services,models,routes}/`). Pattern này không khớp yêu cầu môn học Buổi 12 — kiến trúc **bắt buộc là Modular Monolith**.

 refactor code BE-1  (customer-api .NET) theo đúng Modular Monolith:
- 1 deployable, nhiều module tách bounded context.
- Mỗi module có Domain/Application/Infrastructure/Presentation riêng.
- SharedKernel chứa primitive, event bus, middleware chung.
- Giao tiếp giữa module qua `IEventBus` (in-memory, swap sang Redis/RabbitMQ dễ).

**(customer-api) hiện đã theo chuẩn.** Phần Node.js (code dã commit) chưa khớp. đề xuất bên dưới cách tổ chức lại 
---

## 2. Đề xuất tổ chức lại Node.js backend

### 2.1 Hiện trạng 

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

### 2.3 Pattern module registration

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

## 3. Quyết định đã làm


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

- VPS vẫn thuê 
- Deploy VPS vẫn qua `docker compose -f docker-compose.yml -f docker-compose.staging.yml up -d`.
- CHỈ ĐỔI: build chạy trên runner của GitHub (không tốn tài nguyên VPS), deploy KHÔNG tự động — chỉ chạy khi click manual trong tab Actions.
- Lý do (thầy đã nói): auto deploy có thể làm sập VPS khi build fail. Giữ manual = chủ động chọn thời điểm.

---

