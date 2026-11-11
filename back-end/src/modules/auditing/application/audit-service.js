// =============================================================================
//  MODULE auditing · APPLICATION — Biến sự kiện thành dòng nhật ký
// -----------------------------------------------------------------------------
//  Bảng ánh xạ dưới đây là toàn bộ "trí tuệ" của module: chuyển tên sự kiện kỹ
//  thuật (`ordering.order.created`) thành dòng nhật ký người đọc hiểu được
//  ("CREATE_ORDER · ORDER · bàn T1-01 · 540.000 ₫").
//
//  Thêm sự kiện mới chỉ cần thêm một dòng ở đây, không sửa module phát sự kiện.
// =============================================================================
const repo = require('../infrastructure/log-repository');
const EVENTS = require('../../../platform/events/event-names');
const { toAmount } = require('../../../shared/money');

/**
 * Mỗi mục: [nhãn hành động, loại thực thể, hàm rút trích chi tiết]
 * Hàm rút trích chỉ giữ các trường CÓ Ý NGHĨA KIỂM TOÁN — không nhồi cả payload
 * vào JSONB (vừa phình CSDL, vừa dễ lưu nhầm dữ liệu nhạy cảm).
 */
const MAP = {
  [EVENTS.USER_LOGGED_IN]:   ['LOGIN',  'USER', (p) => ({ role: p.role })],
  [EVENTS.USER_LOGGED_OUT]:  ['LOGOUT', 'USER', (p) => ({ all_devices: p.all })],
  [EVENTS.USER_CREATED]:     ['CREATE_USER', 'USER', (p) => ({ username: p.username, role: p.role })],
  [EVENTS.USER_UPDATED]:     ['UPDATE_USER', 'USER', (p) => ({ changes: p.changes })],
  [EVENTS.USER_DELETED]:     ['DELETE_USER', 'USER', (p) => ({ username: p.username })],
  [EVENTS.USER_PASSWORD_RESET]: ['RESET_PASSWORD', 'USER', (p) => ({ self: p.self })],

  [EVENTS.MENU_ITEM_CREATED]: ['CREATE_MENU', 'MENU_ITEM', (p) => ({ name: p.name, price: p.price })],
  [EVENTS.MENU_ITEM_UPDATED]: ['UPDATE_MENU', 'MENU_ITEM', (p) => ({ changes: p.changes })],
  [EVENTS.MENU_ITEM_DELETED]: ['DELETE_MENU', 'MENU_ITEM', () => ({})],

  [EVENTS.TABLE_CREATED]: ['CREATE_TABLE', 'TABLE', (p) => ({ code: p.table_code, zone: p.zone })],
  [EVENTS.TABLE_UPDATED]: ['UPDATE_TABLE', 'TABLE', (p) => ({ code: p.table_code, changes: p.changes })],
  [EVENTS.TABLE_DELETED]: ['DELETE_TABLE', 'TABLE', (p) => ({ code: p.table_code })],

  [EVENTS.ORDER_CREATED]:   ['CREATE_ORDER', 'ORDER',
    (p) => ({ table: p.table_code, total: toAmount(p.total_amount), source: p.source })],
  [EVENTS.ORDER_ITEMS_ADDED]: ['ADD_ORDER_ITEMS', 'ORDER',
    (p) => ({ table: p.table_code, added: p.added, total: toAmount(p.total_amount) })],
  [EVENTS.ORDER_UPDATED]:   ['UPDATE_ORDER', 'ORDER', (p) => ({ change: p.change, table: p.table_code })],
  [EVENTS.ORDER_CANCELLED]: ['CANCEL_ORDER', 'ORDER', (p) => ({ table: p.table_code, reason: p.reason })],
  [EVENTS.ORDER_COMPLETED]: ['COMPLETE_ORDER', 'ORDER', (p) => ({ table: p.table_code })],
  [EVENTS.ORDER_MOVED]:     ['MOVE_ORDER', 'ORDER',
    (p) => ({ from: p.from_table_code, to: p.to_table_code })],
  [EVENTS.ORDER_ITEM_CONFIRMED]: ['CONFIRM_GUEST_ITEMS', 'ORDER',
    (p) => ({ table: p.table_code, count: p.reviewed_count || 1, request: p.guest_request_id })],
  [EVENTS.ORDER_ITEM_REJECTED]:  ['REJECT_GUEST_ITEMS', 'ORDER',
    (p) => ({ table: p.table_code, reason: p.reject_reason, request: p.guest_request_id })],

  [EVENTS.INVOICE_ISSUED]: ['CHECKOUT', 'INVOICE',
    (p) => ({ table: p.table_code, final: toAmount(p.final_amount), payment: p.payment_method })],

  [EVENTS.GUEST_SESSION_STARTED]: ['GUEST_SESSION_START', 'GUEST_SESSION',
    (p) => ({ table: p.table_code, name: p.display_name })],
  [EVENTS.GUEST_SESSION_CLOSED]:  ['GUEST_SESSION_CLOSE', 'GUEST_SESSION',
    (p) => ({ table: p.table_code, reason: p.reason })],
  [EVENTS.GUEST_REQUEST_SUBMITTED]: ['QR_SUBMIT_ORDER', 'GUEST_REQUEST',
    (p) => ({ table: p.table_code, items: p.items_count, amount: toAmount(p.amount) })],
  [EVENTS.GUEST_REQUEST_REVIEWED]:  ['QR_REVIEW_ORDER', 'GUEST_REQUEST',
    (p) => ({ table: p.table_code, status: p.status, amount: toAmount(p.confirmed_amount) })],
};

/** Đoán id thực thể từ payload (mỗi loại sự kiện đặt tên khoá khác nhau). */
function entityIdOf(payload) {
  return payload.order_id || payload.invoice_id || payload.user_id || payload.table_id
      || payload.item_id || payload.request_id || payload.session_id || null;
}

/** Tên người thao tác: ưu tiên người thực hiện, lùi về khách nếu là đơn QR. */
function actorOf(payload, envelope) {
  const name = payload.actor_name || payload.reviewer_name || payload.user_name
    || payload.cashier_name || envelope.actor || null;
  const id = payload.actor_id || payload.reviewer_id || payload.user_id
    || payload.cashier_id || null;
  if (name) return { id, name };
  if (payload.guest_session_id || payload.source === 'qr') {
    return { id: null, name: payload.guest_name ? `Khách · ${payload.guest_name}` : 'Khách (QR)' };
  }
  return { id, name: 'Hệ thống' };
}

/** Handler đăng ký với mẫu đại diện '*' — nhận MỌI sự kiện. */
async function record(payload, envelope) {
  const mapping = MAP[envelope.event];
  if (!mapping) return; // sự kiện nội bộ không cần ghi nhật ký (vd. table.state_changed)

  const [action, entity, extract] = mapping;
  const actor = actorOf(payload, envelope);

  await repo.write({
    event: envelope.event,
    module: envelope.event.split('.')[0],
    action,
    entity,
    entity_id: entityIdOf(payload),
    user_id: actor.id,
    user_name: actor.name,
    details: extract(payload),
    ip: payload.ip || null,
    request_id: envelope.correlationId || null,
  });
}

async function list(filters) {
  return repo.list(filters);
}

async function timelineFor(entity, entityId) {
  return repo.timelineFor(entity, entityId);
}

module.exports = { record, list, timelineFor, MAP };
