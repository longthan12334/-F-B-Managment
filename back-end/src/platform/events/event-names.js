// =============================================================================
//  PLATFORM — Danh mục tên sự kiện (hợp đồng chung giữa các module)
// -----------------------------------------------------------------------------
//  Đây là "hợp đồng tích hợp" của hệ thống. Module phát sự kiện và module lắng
//  nghe đều tham chiếu hằng số ở đây, nên đổi tên sự kiện là đổi một chỗ duy
//  nhất và IDE tìm được mọi nơi sử dụng.
// =============================================================================

const EVENTS = Object.freeze({
  // ─── identity ────────────────────────────────────────────────────────────
  USER_LOGGED_IN:        'identity.user.logged_in',
  USER_LOGGED_OUT:       'identity.user.logged_out',
  USER_CREATED:          'identity.user.created',
  USER_UPDATED:          'identity.user.updated',
  USER_DELETED:          'identity.user.deleted',
  USER_PASSWORD_RESET:   'identity.user.password_reset',

  // ─── catalog ─────────────────────────────────────────────────────────────
  MENU_ITEM_CREATED:     'catalog.menu_item.created',
  MENU_ITEM_UPDATED:     'catalog.menu_item.updated',
  MENU_ITEM_DELETED:     'catalog.menu_item.deleted',

  // ─── dining (bàn & khu vực) ──────────────────────────────────────────────
  TABLE_CREATED:         'dining.table.created',
  TABLE_UPDATED:         'dining.table.updated',
  TABLE_DELETED:         'dining.table.deleted',
  TABLE_STATE_CHANGED:   'dining.table.state_changed',

  // ─── ordering ────────────────────────────────────────────────────────────
  ORDER_CREATED:         'ordering.order.created',
  ORDER_UPDATED:         'ordering.order.updated',
  ORDER_CANCELLED:       'ordering.order.cancelled',
  ORDER_MOVED:           'ordering.order.moved',
  ORDER_COMPLETED:       'ordering.order.completed',
  ORDER_ITEMS_ADDED:     'ordering.order.items_added',
  ORDER_ITEM_CONFIRMED:  'ordering.order_item.confirmed',
  ORDER_ITEM_REJECTED:   'ordering.order_item.rejected',

  // ─── billing ─────────────────────────────────────────────────────────────
  INVOICE_ISSUED:        'billing.invoice.issued',

  // ─── guest-access (khách quét QR) ────────────────────────────────────────
  GUEST_SESSION_STARTED: 'guest.session.started',
  GUEST_SESSION_CLOSED:  'guest.session.closed',
  GUEST_REQUEST_SUBMITTED: 'guest.request.submitted',
  GUEST_REQUEST_REVIEWED:  'guest.request.reviewed',
});

module.exports = EVENTS;
