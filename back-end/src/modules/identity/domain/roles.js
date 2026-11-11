// =============================================================================
//  MODULE identity · DOMAIN — Vai trò & ma trận quyền
// -----------------------------------------------------------------------------
//  Nguồn chân lý duy nhất về phân quyền của hệ thống. Tầng HTTP của các module
//  khác không tự liệt kê vai trò mà gọi `identity.contract.can(role, action)`
//  hoặc dùng middleware `requireRole(...)` do identity cung cấp.
// =============================================================================

const ROLES = Object.freeze({
  ADMIN: 'admin',
  CASHIER: 'cashier',
  WAITER: 'waiter',
});

const ALL_ROLES = Object.freeze(Object.values(ROLES));

/** Tác nhân đặc biệt: khách quét QR — KHÔNG phải vai trò nhân viên. */
const GUEST = 'guest';

/**
 * Ma trận quyền. Khoá là "hành động nghiệp vụ", giá trị là danh sách vai trò.
 * Đặt tập trung giúp trả lời ngay câu hỏi "ai được làm gì" khi viết tài liệu
 * và khi rà soát bảo mật.
 */
const PERMISSIONS = Object.freeze({
  // identity
  'user.read':             [ROLES.ADMIN],
  'user.write':            [ROLES.ADMIN],
  // catalog
  'menu.read':             [ROLES.ADMIN, ROLES.CASHIER, ROLES.WAITER],
  'menu.write':            [ROLES.ADMIN],
  // dining
  'table.read':            [ROLES.ADMIN, ROLES.CASHIER, ROLES.WAITER],
  'table.write':           [ROLES.ADMIN],
  'table.operate':         [ROLES.ADMIN, ROLES.CASHIER],        // bật/tắt, dọn bàn
  // ordering
  'order.read':            [ROLES.ADMIN, ROLES.CASHIER, ROLES.WAITER],
  'order.create':          [ROLES.ADMIN, ROLES.WAITER],
  'order.modify':          [ROLES.ADMIN, ROLES.CASHIER, ROLES.WAITER],
  'order.move':            [ROLES.ADMIN, ROLES.CASHIER],
  'order.confirm_guest':   [ROLES.ADMIN, ROLES.CASHIER, ROLES.WAITER],
  // billing
  'invoice.read':          [ROLES.ADMIN, ROLES.CASHIER],
  'invoice.checkout':      [ROLES.ADMIN, ROLES.CASHIER],
  // analytics & auditing
  'stats.read':            [ROLES.ADMIN, ROLES.CASHIER],
  'log.read':              [ROLES.ADMIN],
  'guest_session.read':    [ROLES.ADMIN, ROLES.CASHIER, ROLES.WAITER],
});

const isValidRole = (role) => ALL_ROLES.includes(role);

/** Vai trò `role` có được thực hiện `action` không? */
function can(role, action) {
  const allowed = PERMISSIONS[action];
  if (!allowed) return false; // mặc định từ chối — hành động chưa khai báo thì không ai được làm
  return allowed.includes(role);
}

/** Danh sách hành động một vai trò được phép — phục vụ tài liệu & màn hình phân quyền. */
function actionsFor(role) {
  return Object.entries(PERMISSIONS).filter(([, roles]) => roles.includes(role)).map(([a]) => a);
}

module.exports = { ROLES, ALL_ROLES, GUEST, PERMISSIONS, isValidRole, can, actionsFor };
