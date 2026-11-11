// =============================================================================
//  Điểm vào tiến trình — RestoManager (Modular Monolith)
// -----------------------------------------------------------------------------
//  Thứ tự khởi động có chủ đích:
//    1. Kiểm tra cấu hình  → sai cấu hình thì DỪNG NGAY, không chạy nửa vời.
//    2. Chờ PostgreSQL     → container CSDL khởi động chậm hơn backend.
//    3. Chạy migration     → gom từ migrations/ của TẤT CẢ module.
//    4. Khởi tạo kho S3    → MinIO / S3 / R2 tuỳ STORAGE_DRIVER.
//    5. Nạp module         → đọc manifest, kiểm tra phụ thuộc, sắp xếp topo.
//    6. Khởi động module   → đăng ký lắng nghe sự kiện, seed, tác vụ nền.
//    7. Dựng Express       → gắn route của từng module.
//    8. Bật Socket.IO      → dùng chung cổng với HTTP.
//    9. Lắng nghe cổng.
//
//  Tắt máy êm (graceful shutdown): ngừng nhận kết nối mới → đóng WebSocket →
//  đóng pool CSDL. Cần thiết để `docker compose down` không cắt ngang giao
//  dịch đang chạy.
// =============================================================================
const http = require('http');

const { config, assertConfigValid } = require('./src/shared/config');
const log = require('./src/shared/logger').child('boot');
const db = require('./src/platform/database/pool');
const { runMigrations } = require('./src/platform/database/migrator');
const storage = require('./src/platform/storage');
const realtime = require('./src/platform/realtime/realtime');
const eventBus = require('./src/platform/events/event-bus');
const registry = require('./src/platform/http/module-registry');
const { createApp } = require('./src/app');

let httpServer = null;
let shuttingDown = false;

async function start() {
  const started = Date.now();

  // 1) Cấu hình
  assertConfigValid(log);
  log.info(`Khởi động ${config.appName} v${config.appVersion} — môi trường: ${config.env}`);

  // 2–3) CSDL
  await db.waitForDatabase();
  await runMigrations();

  // 4) Kho đối tượng
  await storage.init();
  log.info(`Kho đối tượng: ${storage.driverName} · bucket '${config.storage.bucket}'`);

  // 5–6) Module
  registry.discover();
  await registry.boot({ eventBus });

  // 7) HTTP
  const app = await createApp();
  httpServer = http.createServer(app);

  // 8) Realtime — xác thực do hai module cung cấp, platform không tự biết
  const identity = registry.contractOf('identity');
  const guestAccess = registry.contractOf('guest-access');
  realtime.init(httpServer, {
    verifyStaffToken: identity.verifyAccessToken,
    verifyGuestToken: guestAccess.verifyTokenForSocket,
  });

  // 9) Lắng nghe
  await new Promise((resolve) => httpServer.listen(config.port, '0.0.0.0', resolve));

  const arch = registry.describe();
  log.info('='.repeat(64));
  log.info(` ${config.appName} v${config.appVersion} — Modular Monolith`);
  log.info(` Module (${arch.count}): ${arch.loadOrder.join(' → ')}`);
  log.info(` HTTP      : http://localhost:${config.port}`);
  log.info(` Sức khoẻ  : http://localhost:${config.port}/api/health`);
  log.info(` Kiến trúc : http://localhost:${config.port}/api/architecture`);
  log.info(` Tài liệu  : http://localhost:${config.port}/api/docs`);
  log.info(` Socket.IO : ws://localhost:${config.port}/socket.io`);
  log.info(` Khởi động xong sau ${Date.now() - started}ms`);
  log.info('='.repeat(64));
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Nhận ${signal} — đang tắt êm...`);

  const force = setTimeout(() => {
    log.error('Quá thời gian chờ, buộc thoát.');
    process.exit(1);
  }, 15000);
  force.unref();

  try {
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    await realtime.close();
    await db.closePool();
    log.info('Đã tắt êm.');
    process.exit(0);
  } catch (err) {
    log.error(`Lỗi khi tắt: ${err.message}`);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.error('Promise bị từ chối mà không được xử lý', { reason: reason?.message || String(reason) });
});
process.on('uncaughtException', (err) => {
  log.error('Ngoại lệ không bắt được — đang tắt', { message: err.message, stack: err.stack });
  shutdown('uncaughtException');
});

start().catch((err) => {
  log.error(`Không khởi động được: ${err.message}`, { stack: err.stack });
  process.exit(1);
});
