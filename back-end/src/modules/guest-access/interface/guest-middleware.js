// =============================================================================
//  MODULE guest-access · INTERFACE — Middleware xác thực phiên khách
// -----------------------------------------------------------------------------
//  Khách gửi token qua header `X-Guest-Token`. Không dùng cookie để tránh
//  CSRF và để trang khách hoạt động được cả khi trình duyệt chặn cookie bên
//  thứ ba (trường hợp rất phổ biến khi quét QR trong ứng dụng chat).
// =============================================================================
const sessionService = require('../application/guest-session-service');
const { AppError } = require('../../../shared/errors');
const { asyncHandler } = require('../../../shared/http');

const HEADER = 'x-guest-token';

/** Bắt buộc có phiên khách hợp lệ. Gắn `req.guestSession`. */
const requireGuestSession = asyncHandler(async (req, _res, next) => {
  const token = req.headers[HEADER] || (req.query.guest_token ? String(req.query.guest_token) : null);
  if (!token) {
    throw AppError.unauthorized('Thiếu phiên khách, vui lòng quét lại mã QR', 'GUEST_TOKEN_MISSING');
  }
  req.guestSession = await sessionService.authenticate(token);
  req.guestToken = token;
  return next();
});

/** Có phiên thì gắn, không có vẫn cho qua (dùng cho trang xem thực đơn). */
const optionalGuestSession = asyncHandler(async (req, _res, next) => {
  const token = req.headers[HEADER];
  if (token) {
    try {
      req.guestSession = await sessionService.authenticate(token);
      req.guestToken = token;
    } catch { /* bỏ qua: khách chưa có phiên */ }
  }
  return next();
});

module.exports = { requireGuestSession, optionalGuestSession, GUEST_TOKEN_HEADER: HEADER };
