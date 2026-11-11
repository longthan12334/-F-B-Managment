// =============================================================================
//  MODULE identity · CONTRACT — API công khai cho các module khác
// -----------------------------------------------------------------------------
//  ĐÂY LÀ RANH GIỚI MODULE.
//  Module khác CHỈ được dùng những hàm liệt kê ở đây; tuyệt đối không
//  `require` vào domain/, application/ hay infrastructure/ của identity, và
//  không truy vấn trực tiếp bảng `users` / `refresh_tokens`.
//  Công cụ `npm run check:boundaries` kiểm tra tự động quy ước này.
//
//  Khi tách identity thành microservice, chỉ cần thay thân các hàm dưới đây
//  bằng lời gọi HTTP/gRPC — nơi gọi không phải sửa.
// =============================================================================
const users = require('./infrastructure/user-repository');
const tokenService = require('./application/token-service');
const middleware = require('./interface/auth-middleware');
const { ROLES, ALL_ROLES, can, actionsFor } = require('./domain/roles');
const { toPublic } = require('./domain/user');

module.exports = {
  // ── Hằng số & phân quyền ────────────────────────────────────────────────
  ROLES,
  ALL_ROLES,
  /** Vai trò `role` có quyền thực hiện `action` không? */
  can,
  /** Danh sách hành động một vai trò được phép. */
  actionsFor,

  // ── Middleware cho tầng HTTP của module khác ────────────────────────────
  requireAuth: middleware.requireAuth,
  requireRole: middleware.requireRole,
  requirePermission: middleware.requirePermission,
  optionalAuth: middleware.optionalAuth,

  // ── Xác minh token (platform/realtime dùng để xác thực WebSocket) ───────
  verifyAccessToken: tokenService.verifyAccessToken,

  // ── Truy vấn chỉ-đọc (read model) ───────────────────────────────────────
  /** Thông tin công khai của một nhân viên (không gồm password_hash). */
  async getUserById(id) {
    return toPublic(await users.findById(id));
  },
  /** Kiểm tra nhanh một tài khoản còn hiệu lực — dùng khi ghi nhận người thao tác. */
  async isActiveUser(id) {
    const u = await users.findById(id);
    return Boolean(u && u.is_active);
  },
  /** Danh sách nhân viên theo vai trò (dùng cho bộ lọc báo cáo). */
  async listByRole(role) {
    return users.findAll({ role, is_active: true });
  },
};
