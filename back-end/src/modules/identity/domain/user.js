// =============================================================================
//  MODULE identity · DOMAIN — Thực thể User và các bất biến nghiệp vụ
// -----------------------------------------------------------------------------
//  Tầng domain thuần tuý: không biết Express, không biết PostgreSQL. Nhờ vậy
//  có thể kiểm thử quy tắc nghiệp vụ mà không cần dựng CSDL.
// =============================================================================
const { AppError } = require('../../../shared/errors');
const { isValidRole, ALL_ROLES } = require('./roles');
const { config } = require('../../../shared/config');

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/i;

/** Kiểm tra dữ liệu tạo tài khoản mới. */
function assertValidNewUser({ username, password, full_name, role }) {
  const errs = [];
  if (!username || !USERNAME_RE.test(String(username).trim())) {
    errs.push('username: 3–32 ký tự, chỉ gồm chữ, số và . _ -');
  }
  if (!password || String(password).length < config.auth.minPasswordLength) {
    errs.push(`password: tối thiểu ${config.auth.minPasswordLength} ký tự`);
  }
  if (!full_name || String(full_name).trim().length < 2) errs.push('full_name: tối thiểu 2 ký tự');
  if (!isValidRole(role)) errs.push(`role: phải thuộc {${ALL_ROLES.join('|')}}`);
  if (errs.length) throw AppError.validation('Dữ liệu tài khoản không hợp lệ', errs);
}

/** Kiểm tra mật khẩu mới khi đặt lại. */
function assertValidPassword(password) {
  if (!password || String(password).length < config.auth.minPasswordLength) {
    throw AppError.validation('Mật khẩu không hợp lệ', [
      `password: tối thiểu ${config.auth.minPasswordLength} ký tự`,
    ]);
  }
}

/** Bất biến: hệ thống luôn phải còn ít nhất một admin đang hoạt động. */
function assertNotLastAdmin({ activeAdminCount, targetIsActiveAdmin }, action = 'vô hiệu hoá') {
  if (targetIsActiveAdmin && activeAdminCount <= 1) {
    throw AppError.conflict(
      `Không thể ${action} quản trị viên cuối cùng — hệ thống phải luôn còn ít nhất một admin đang hoạt động.`
    );
  }
}

/** Loại bỏ trường nhạy cảm trước khi trả ra ngoài module. */
function toPublic(user) {
  if (!user) return null;
  const { password_hash, ...rest } = user;
  return rest;
}

/** Thông tin tối thiểu dùng làm payload JWT. */
function toTokenPayload(user) {
  return { id: user.id, username: user.username, role: user.role, full_name: user.full_name };
}

module.exports = {
  USERNAME_RE,
  assertValidNewUser,
  assertValidPassword,
  assertNotLastAdmin,
  toPublic,
  toTokenPayload,
};
