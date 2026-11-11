// =============================================================================
//  PLATFORM — Middleware bảo mật HTTP
// -----------------------------------------------------------------------------
//  CORS theo danh sách trắng + các HTTP security header. Không dùng `helmet`
//  để giữ số phụ thuộc ở mức tối thiểu; các header dưới đây là tập đủ dùng cho
//  một API JSON đứng sau reverse proxy (Caddy) và Cloudflare.
// =============================================================================
const cors = require('cors');
const { config } = require('../../shared/config');
const log = require('../../shared/logger').child('security');

/**
 * Origin có trùng với chính máy chủ đang phục vụ request không?
 *
 * Vì sao cần hàm này: trình duyệt gửi header `Origin` cho MỌI request POST,
 * kể cả request cùng nguồn. Nếu chỉ so với danh sách trắng, ứng dụng sẽ hỏng
 * khi truy cập bằng một tên khác với tên đã khai báo — ví dụ mở bằng IP của
 * VPS trong lúc chờ DNS trỏ xong, hay mở bằng `127.0.0.1` thay vì `localhost`.
 * Request cùng nguồn vốn không phải là "cross-origin", nên cho phép là đúng
 * và không nới lỏng bảo mật chút nào.
 */
function isSameOrigin(origin, req) {
  if (!origin || !req) return false;
  try {
    const o = new URL(origin);
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (!host) return false;
    return o.host.toLowerCase() === String(host).toLowerCase();
  } catch {
    return false;
  }
}

function buildCors() {
  const list = config.http.allowedOrigins;
  if (list.length === 0 && !config.isProd) {
    log.warn('ALLOWED_ORIGINS chưa đặt — CORS đang mở hoàn toàn (chỉ dùng cho môi trường phát triển).');
  }

  // Dạng "delegate" của cors() để truy cập được `req` khi quyết định.
  return cors((req, callback) => {
    const origin = req.headers.origin;
    const allow =
      !origin                        // curl, ứng dụng di động native, server-to-server
      || list.length === 0           // chưa cấu hình → chỉ xảy ra ngoài production
      || list.includes(origin)       // nằm trong danh sách trắng
      || isSameOrigin(origin, req);  // chính máy chủ này

    if (!allow) {
      log.warn(`Từ chối CORS cho origin: ${origin}`);
      return callback(new Error(`CORS: origin không được phép: ${origin}`));
    }

    return callback(null, {
      origin: true,
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining'],
      maxAge: 86400,
    });
  });
}

/** Header bảo mật. API trả JSON nên CSP đặt rất chặt. */
function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (config.isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

module.exports = { buildCors, securityHeaders };
