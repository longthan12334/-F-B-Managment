// =============================================================================
//  PLATFORM — Giới hạn tần suất (Rate limiting)
// -----------------------------------------------------------------------------
//  Ba mức khác nhau theo mức độ nhạy cảm:
//    authLimiter   — /auth/login, /auth/refresh: chống dò mật khẩu.
//    apiLimiter    — API nội bộ cho nhân viên đã đăng nhập.
//    publicLimiter — API công khai cho khách quét QR: chống đặt đơn ảo.
//
//  Lưu ý khi chạy sau Cloudflare + Caddy: header X-Forwarded-For có thể bị
//  khách tự chèn. Với route công khai, ta lấy phần tử CUỐI của X-Forwarded-For
//  (do reverse proxy tin cậy gắn thêm) thay vì req.ip — nếu không, khách chỉ
//  cần gửi header giả là né được giới hạn.
//  Cloudflare còn gửi CF-Connecting-IP — nếu có thì ưu tiên dùng header này.
// =============================================================================
const rateLimit = require('express-rate-limit');
const { AppError } = require('../../shared/errors');
const { config } = require('../../shared/config');

const handler = (_req, _res, next) => next(AppError.rateLimited());

/** IP thật của client, an toàn trước header giả mạo. */
function trustedClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const parts = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length) return parts[parts.length - 1];
  return req.socket?.remoteAddress || req.ip;
}

const authLimiter = rateLimit({
  windowMs: config.rateLimit.authWindowMs,
  max: config.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  // Khoá theo IP + username để một tài khoản bị dò không khoá cả IP văn phòng
  keyGenerator: (req) => `${trustedClientIp(req)}|${(req.body?.username || '')}`.toLowerCase(),
  skipSuccessfulRequests: true,
  handler,
});

const apiLimiter = rateLimit({
  windowMs: config.rateLimit.apiWindowMs,
  max: config.rateLimit.apiMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

const publicLimiter = rateLimit({
  windowMs: config.rateLimit.publicWindowMs,
  max: config.rateLimit.publicMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: trustedClientIp,
  handler,
});

module.exports = { authLimiter, apiLimiter, publicLimiter, trustedClientIp };
