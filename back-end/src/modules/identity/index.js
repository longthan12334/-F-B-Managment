// =============================================================================
//  MODULE: identity — Danh tính, xác thực và phân quyền
// -----------------------------------------------------------------------------
//  Phạm vi nghiệp vụ: tài khoản nhân viên, đăng nhập/đăng xuất, vòng đời token,
//  ma trận quyền theo vai trò.
//  Đây là module NỀN: không phụ thuộc module nào, mọi module khác phụ thuộc nó.
// =============================================================================
const contract = require('./contract');
const authRoutes = require('./interface/auth-routes');
const userRoutes = require('./interface/user-routes');
const users = require('./infrastructure/user-repository');
const tokens = require('./infrastructure/refresh-token-repository');
const { config } = require('../../shared/config');
const EVENTS = require('../../platform/events/event-names');
const log = require('../../shared/logger').child('identity');

module.exports = {
  name: 'identity',
  description: 'Tài khoản nhân viên, xác thực JWT (access + refresh), phân quyền theo vai trò.',

  dependsOn: [],
  owns: ['users', 'refresh_tokens'],

  routers: [
    { path: '/api/auth',  router: authRoutes },
    { path: '/api/users', router: userRoutes },
  ],

  publishes: [
    EVENTS.USER_LOGGED_IN, EVENTS.USER_LOGGED_OUT, EVENTS.USER_CREATED,
    EVENTS.USER_UPDATED, EVENTS.USER_DELETED, EVENTS.USER_PASSWORD_RESET,
  ],
  subscribes: [],

  contract,

  async register() {
    // Seed tài khoản mặc định khi CSDL còn trống (chỉ ngoài production)
    if (config.seed.enabled) {
      const count = await users.count();
      if (count === 0) {
        await users.seedDefaults(config.seed.defaultPassword);
        log.info(`Đã tạo 3 tài khoản mặc định (admin/cashier/waiter — mật khẩu: ${config.seed.defaultPassword})`);
      }
    }

    // Tác vụ nền: dọn refresh token hết hạn mỗi 12 giờ
    const timer = setInterval(() => {
      tokens.cleanupExpired()
        .then((n) => n && log.info(`Đã dọn ${n} refresh token hết hạn`))
        .catch((e) => log.warn(`Dọn refresh token lỗi: ${e.message}`));
    }, 12 * 60 * 60 * 1000);
    timer.unref();
  },

  async healthCheck() {
    return { ok: true, users: await users.count(), activeAdmins: await users.countActiveAdmins() };
  },
};
