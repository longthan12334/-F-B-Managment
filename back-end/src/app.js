// =============================================================================
//  Khởi dựng ứng dụng Express
// -----------------------------------------------------------------------------
//  Tệp này cố tình KHÔNG biết gì về nghiệp vụ: không import controller, không
//  khai báo route của nhà hàng. Nó chỉ:
//    1. Gắn middleware hạ tầng (bảo mật, CORS, log, giới hạn tần suất).
//    2. Nhờ Module Registry tự khám phá và gắn route của từng module.
//    3. Cung cấp các endpoint vận hành (/api/health, /api/architecture).
//
//  Hệ quả: thêm một module mới = tạo một thư mục trong src/modules/. Không
//  phải sửa app.js. Đây là tiêu chí "có thể thêm/bớt module độc lập" của
//  Modular Monolith.
// =============================================================================
const express = require('express');
const swaggerUi = require('swagger-ui-express');

const { config } = require('./shared/config');
const { ok } = require('./shared/http');
const log = require('./shared/logger').child('app');

const registry = require('./platform/http/module-registry');
const { buildCors, securityHeaders } = require('./platform/http/security');
const { requestContext } = require('./platform/http/request-context');
const { apiLimiter } = require('./platform/http/rate-limit');
const { notFoundHandler, globalErrorHandler } = require('./platform/http/error-handler');
const db = require('./platform/database/pool');
const storage = require('./platform/storage');
const realtime = require('./platform/realtime/realtime');
const eventBus = require('./platform/events/event-bus');
const openapi = require('./openapi');

/**
 * Tạo ứng dụng Express đã nạp đầy đủ module.
 * @returns {Promise<import('express').Express>}
 */
async function createApp() {
  const app = express();

  // ─── Hạ tầng HTTP ─────────────────────────────────────────────────────────
  app.disable('x-powered-by');
  // Chạy sau Caddy + Cloudflare → tin header X-Forwarded-* để lấy đúng IP và
  // scheme. Việc chống giả mạo IP cho route công khai xử lý riêng trong
  // platform/http/rate-limit.js.
  app.set('trust proxy', config.http.trustProxy);

  app.use(securityHeaders);
  app.use(buildCors());
  app.use(express.json({ limit: config.http.bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: config.http.bodyLimit }));
  app.use(requestContext);

  // ─── Endpoint vận hành (đặt TRƯỚC rate limit để giám sát không bị chặn) ──
  app.get('/api/health', async (_req, res) => {
    const [database, objectStorage, modules] = await Promise.all([
      db.healthCheck().catch((e) => ({ ok: false, error: e.message })),
      storage.healthCheck().catch((e) => ({ ok: false, error: e.message })),
      registry.health(),
    ]);

    const healthy = database.ok && objectStorage.ok &&
      Object.values(modules).every((m) => m.ok !== false);

    return res.status(healthy ? 200 : 503).json({
      success: healthy,
      data: {
        status: healthy ? 'ok' : 'degraded',
        service: config.appName,
        version: config.appVersion,
        environment: config.env,
        architecture: 'modular-monolith',
        timestamp: new Date().toISOString(),
        uptime_seconds: Math.round(process.uptime()),
        checks: { database, storage: objectStorage, realtime: realtime.stats(), modules },
      },
      message: '',
    });
  });

  /** Sẵn sàng nhận traffic chưa (dùng cho healthcheck của Docker/Cloudflare). */
  app.get('/api/health/ready', async (_req, res) => {
    try {
      await db.healthCheck();
      return res.status(200).json({ success: true, data: { ready: true }, message: '' });
    } catch (err) {
      return res.status(503).json({ success: false, message: 'Chưa sẵn sàng', error: { code: 'NOT_READY' } });
    }
  });

  /** Tiến trình còn sống không (liveness probe). */
  app.get('/api/health/live', (_req, res) =>
    res.status(200).json({ success: true, data: { alive: true }, message: '' })
  );

  /**
   * Bản đồ kiến trúc tự sinh từ manifest của các module.
   * Dùng để đối chiếu tài liệu với mã nguồn thực tế: tài liệu nói module nào
   * phụ thuộc module nào, endpoint này nói sự thật.
   */
  app.get('/api/architecture', (_req, res) =>
    ok(res, {
      style: 'Modular Monolith',
      ...registry.describe(),
      eventSubscriptions: eventBus.describe(),
      recentEvents: config.isProd ? undefined : eventBus.recentEvents(20),
    })
  );

  // ─── Tài liệu API ────────────────────────────────────────────────────────
  const spec = openapi.build(registry);
  app.get('/api/openapi.json', (_req, res) => res.json(spec));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec, {
    customSiteTitle: `${config.appName} API`,
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
  }));

  // ─── Giới hạn tần suất chung ─────────────────────────────────────────────
  // Route công khai (/api/public) có giới hạn chặt hơn, khai báo trong chính
  // module guest-access để lượt gọi của khách không ăn vào hạn mức nhân viên.
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/public') || req.path.startsWith('/auth')) return next();
    return apiLimiter(req, res, next);
  });

  // ─── Route của các module (tự khám phá) ─────────────────────────────────
  registry.mountRoutes(app);

  // ─── Xử lý lỗi ───────────────────────────────────────────────────────────
  app.use(notFoundHandler);
  app.use(globalErrorHandler);

  log.info(`Express đã sẵn sàng với ${registry.modules.size} module`);
  return app;
}

module.exports = { createApp };
