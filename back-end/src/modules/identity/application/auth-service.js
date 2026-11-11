// =============================================================================
//  MODULE identity · APPLICATION — Use-case xác thực
// -----------------------------------------------------------------------------
//  Luồng: đăng nhập → phát cặp token → làm mới (xoay vòng) → đăng xuất.
//  Service không biết Express: nhận dữ liệu thuần, trả dữ liệu thuần, ném
//  AppError. Nhờ vậy có thể gọi từ HTTP, từ CLI hoặc từ test.
// =============================================================================
const users = require('../infrastructure/user-repository');
const tokens = require('../infrastructure/refresh-token-repository');
const tokenService = require('./token-service');
const { assertValidPassword, toPublic, toTokenPayload } = require('../domain/user');
const { AppError } = require('../../../shared/errors');
const EVENTS = require('../../../platform/events/event-names');
const bus = require('../../../platform/events/event-bus');

/** Phát hành cặp token và lưu hash refresh token. */
async function issueTokens(user, meta = {}) {
  const accessToken = tokenService.signAccessToken(toTokenPayload(user));
  const refreshToken = tokenService.signRefreshToken({
    id: user.id, role: user.role, username: user.username,
  });

  const expires_at = new Date(Date.now() + tokenService.refreshTtlSeconds() * 1000);
  try {
    await tokens.store({
      user_id: user.id, token: refreshToken, expires_at,
      user_agent: meta.userAgent || null, ip: meta.ip || null,
    });
  } catch (err) {
    // Fail-closed: không ghi được phiên thì không phát token (nếu không sẽ có
    // token hợp lệ mà hệ thống không thể thu hồi).
    throw AppError.internal('Không tạo được phiên đăng nhập, vui lòng thử lại', err);
  }

  return {
    token: accessToken,
    refresh_token: refreshToken,
    expires_in: tokenService.accessTtlSeconds(),
    refresh_expires_in: tokenService.refreshTtlSeconds(),
    token_type: 'Bearer',
  };
}

async function login({ username, password }, meta = {}) {
  if (!username || !password) {
    throw AppError.validation('Vui lòng nhập tên đăng nhập và mật khẩu');
  }

  const user = await users.findByUsername(String(username).trim());
  const verified = user ? await users.verifyPassword(user, password) : false;

  // Thông điệp giống nhau cho "sai tài khoản" và "sai mật khẩu" — không để lộ
  // tài khoản nào có tồn tại (user enumeration).
  if (!user || !verified || !user.is_active) {
    throw AppError.unauthorized('Tên đăng nhập hoặc mật khẩu không đúng', 'INVALID_CREDENTIALS');
  }

  const issued = await issueTokens(user, meta);
  users.touchLastLogin(user.id).catch(() => {});

  bus.publish(EVENTS.USER_LOGGED_IN, {
    user_id: user.id, user_name: user.full_name, role: user.role, ip: meta.ip,
  }, { actor: user.full_name, correlationId: meta.requestId });

  return { ...issued, user: toPublic(user) };
}

/** Làm mới phiên; xoay vòng refresh token (token cũ bị thu hồi ngay). */
async function refresh({ refresh_token }, meta = {}) {
  if (!refresh_token) throw AppError.validation('Thiếu refresh_token');

  let decoded;
  try {
    decoded = tokenService.verifyRefreshToken(refresh_token);
  } catch {
    throw AppError.unauthorized('Refresh token không hợp lệ hoặc đã hết hạn', 'REFRESH_INVALID');
  }

  const stored = await tokens.findActive(refresh_token);
  if (!stored) {
    // Token đúng chữ ký nhưng đã bị thu hồi → nhiều khả năng bị tái sử dụng
    // (token replay). Thu hồi toàn bộ phiên của tài khoản cho an toàn.
    await tokens.revokeAllForUser(decoded.id).catch(() => {});
    throw AppError.unauthorized('Phiên đăng nhập đã bị thu hồi, vui lòng đăng nhập lại', 'REFRESH_INVALID');
  }

  const user = await users.findById(decoded.id);
  if (!user || !user.is_active) {
    await tokens.revokeAllForUser(decoded.id).catch(() => {});
    throw AppError.unauthorized('Tài khoản không còn hoạt động', 'REFRESH_INVALID');
  }

  const issued = await issueTokens(user, meta);
  await tokens.revoke(refresh_token, issued.refresh_token);

  return { ...issued, user: toPublic(user) };
}

async function logout({ refresh_token, all }, actor = null) {
  if (all && actor) await tokens.revokeAllForUser(actor.id).catch(() => {});
  else if (refresh_token) await tokens.revoke(refresh_token).catch(() => {});

  if (actor) {
    bus.publish(EVENTS.USER_LOGGED_OUT, {
      user_id: actor.id, user_name: actor.full_name, all: Boolean(all),
    }, { actor: actor.full_name });
  }
  return { all: Boolean(all) };
}

async function me(userId) {
  const user = await users.findById(userId);
  if (!user) throw AppError.notFound('Tài khoản không tồn tại');
  return toPublic(user);
}

async function changeOwnPassword(userId, { current_password, new_password }) {
  assertValidPassword(new_password);
  const user = await users.findById(userId);
  if (!user) throw AppError.notFound('Tài khoản không tồn tại');

  const okCurrent = await users.verifyPassword(user, current_password || '');
  if (!okCurrent) throw AppError.unauthorized('Mật khẩu hiện tại không đúng', 'WRONG_PASSWORD');

  await users.setPassword(userId, new_password);
  // Đổi mật khẩu = đăng xuất mọi thiết bị khác
  await tokens.revokeAllForUser(userId);

  bus.publish(EVENTS.USER_PASSWORD_RESET, {
    user_id: userId, user_name: user.full_name, self: true,
  }, { actor: user.full_name });

  return { id: userId };
}

async function listMySessions(userId) {
  return tokens.listActiveSessions(userId);
}

module.exports = { login, refresh, logout, me, changeOwnPassword, listMySessions, issueTokens };
