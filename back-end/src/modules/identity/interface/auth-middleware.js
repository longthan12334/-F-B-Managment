// =============================================================================
//  MODULE identity · INTERFACE — Middleware xác thực & phân quyền
// -----------------------------------------------------------------------------
//  Đây là phần identity "cho mượn" các module khác qua contract. Module
//  ordering/billing/… KHÔNG tự giải mã JWT mà dùng middleware này, nên nếu mai
//  sau đổi sang OAuth2 hay mTLS thì chỉ sửa trong identity.
// =============================================================================
const tokenService = require('../application/token-service');
const { AppError } = require('../../../shared/errors');
const { can } = require('../domain/roles');

/** Bắt buộc đăng nhập. Gắn `req.user` = payload JWT. */
function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return next(AppError.unauthorized('Thiếu token xác thực', 'MISSING_TOKEN'));
  try {
    req.user = tokenService.verifyAccessToken(token);
    return next();
  } catch (err) {
    return next(err); // error-handler ánh xạ sang INVALID_TOKEN / TOKEN_EXPIRED
  }
}

/** Yêu cầu một trong các vai trò liệt kê. */
function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(AppError.unauthorized('Chưa xác thực'));
    if (!roles.includes(req.user.role)) {
      return next(AppError.forbidden(`Thao tác này yêu cầu vai trò: ${roles.join(', ')}`));
    }
    return next();
  };
}

/**
 * Yêu cầu quyền theo HÀNH ĐỘNG nghiệp vụ thay vì theo vai trò.
 * Nên ưu tiên cách này: khi thêm vai trò mới (vd. 'kitchen') chỉ cần sửa ma
 * trận quyền trong domain/roles.js, không phải sửa từng route.
 */
function requirePermission(action) {
  return (req, _res, next) => {
    if (!req.user) return next(AppError.unauthorized('Chưa xác thực'));
    if (!can(req.user.role, action)) {
      return next(AppError.forbidden(`Vai trò '${req.user.role}' không có quyền '${action}'`));
    }
    return next();
  };
}

/** Xác thực tuỳ chọn: có token thì giải mã, không có vẫn cho qua. */
function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (token) {
    try { req.user = tokenService.verifyAccessToken(token); } catch { /* bỏ qua */ }
  }
  return next();
}

module.exports = { requireAuth, requireRole, requirePermission, optionalAuth };
