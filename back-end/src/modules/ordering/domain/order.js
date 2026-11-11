// =============================================================================
//  MODULE ordering · DOMAIN — Quy tắc nghiệp vụ của đơn hàng
// -----------------------------------------------------------------------------
//  Tầng thuần tuý, không chạm CSDL. Mọi "luật chơi" của đơn hàng tập trung ở
//  đây để kiểm thử được bằng unit test và để người đọc tìm thấy ngay.
// =============================================================================
const { AppError } = require('../../../shared/errors');
const { toAmount } = require('../../../shared/money');

/** Trạng thái đơn. */
const ORDER_STATUS = Object.freeze({
  PENDING: 'pending',       // vừa mở, bếp chưa nhận
  SERVING: 'serving',       // đang phục vụ
  COMPLETED: 'completed',   // đã thanh toán
  CANCELLED: 'cancelled',   // đã huỷ
});

/** Trạng thái dòng món (vòng đời xác nhận). */
const ITEM_STATUS = Object.freeze({
  PENDING_CONFIRM: 'pending_confirm',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
  SERVED: 'served',
  CANCELLED: 'cancelled',
});

const ITEM_SOURCE = Object.freeze({ STAFF: 'staff', QR: 'qr' });

/** Các dòng món được TÍNH TIỀN. */
const BILLABLE_ITEM_STATUSES = [ITEM_STATUS.CONFIRMED, ITEM_STATUS.SERVED];

/** Đơn đang mở = còn có thể thêm/sửa món. */
const OPEN_STATUSES = [ORDER_STATUS.PENDING, ORDER_STATUS.SERVING];

/** Máy trạng thái: từ trạng thái nào được chuyển sang trạng thái nào. */
const STATUS_TRANSITIONS = Object.freeze({
  [ORDER_STATUS.PENDING]:   [ORDER_STATUS.SERVING, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.SERVING]:   [ORDER_STATUS.COMPLETED, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.COMPLETED]: [],
  [ORDER_STATUS.CANCELLED]: [],
});

const isOpen = (order) => OPEN_STATUSES.includes(order?.status);

function assertOpen(order, action = 'thao tác') {
  if (!order) throw AppError.notFound('Đơn hàng không tồn tại');
  if (!isOpen(order)) {
    const label = order.status === ORDER_STATUS.COMPLETED ? 'đã thanh toán' : 'đã huỷ';
    throw AppError.conflict(`Đơn ${order.code} ${label}, không thể ${action}.`);
  }
}

function assertTransition(from, to) {
  const allowed = STATUS_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw AppError.conflict(
      `Không thể chuyển đơn từ "${from}" sang "${to}". ` +
      (allowed.length ? `Chỉ được phép: ${allowed.join(', ')}.` : 'Đơn đã ở trạng thái kết thúc.')
    );
  }
}

/** Kiểm tra giỏ món gửi lên trước khi hỏi giá từ catalog. */
function assertValidBasket(lines, { maxLines = 50, maxQty = 99 } = {}) {
  const errs = [];
  if (!Array.isArray(lines) || lines.length === 0) {
    throw AppError.validation('Dữ liệu không hợp lệ', ['items: phải là mảng và có ít nhất 1 món']);
  }
  if (lines.length > maxLines) {
    throw AppError.validation('Dữ liệu không hợp lệ', [`items: tối đa ${maxLines} dòng mỗi lần gửi`]);
  }
  lines.forEach((l, i) => {
    const q = Number(l?.quantity);
    if (!Number.isInteger(q) || q < 1 || q > maxQty) {
      errs.push(`items[${i}].quantity: số nguyên từ 1 đến ${maxQty}`);
    }
    if (!l?.menu_item_id && !l?.item_name) {
      errs.push(`items[${i}]: cần menu_item_id (hoặc item_name cho món ngoài thực đơn)`);
    }
  });
  if (errs.length) throw AppError.validation('Dữ liệu không hợp lệ', errs);
}

/** Tổng tiền của đơn = tổng các dòng được tính tiền. */
function computeTotal(items = []) {
  return items
    .filter((i) => BILLABLE_ITEM_STATUSES.includes(i.status))
    .reduce((sum, i) => sum + toAmount(i.total_price), 0);
}

/** Tổng tiền các món khách đang chờ duyệt (hiển thị riêng, chưa tính vào đơn). */
function computePendingTotal(items = []) {
  return items
    .filter((i) => i.status === ITEM_STATUS.PENDING_CONFIRM)
    .reduce((sum, i) => sum + toAmount(i.total_price), 0);
}

/** Đơn có món nào đang chờ duyệt không? Dùng để chặn thanh toán. */
const hasPendingItems = (items = []) => items.some((i) => i.status === ITEM_STATUS.PENDING_CONFIRM);

/** Chặn thanh toán khi còn món chưa được duyệt — tránh thu thiếu/thu thừa. */
function assertReadyForCheckout(order, items) {
  assertOpen(order, 'thanh toán');
  if (hasPendingItems(items)) {
    const n = items.filter((i) => i.status === ITEM_STATUS.PENDING_CONFIRM).length;
    throw AppError.conflict(
      `Đơn ${order.code} còn ${n} món khách gọi đang chờ duyệt. ` +
      'Hãy duyệt hoặc từ chối các món đó trước khi thanh toán.'
    );
  }
  const billable = items.filter((i) => BILLABLE_ITEM_STATUSES.includes(i.status));
  if (billable.length === 0) {
    throw AppError.conflict(`Đơn ${order.code} chưa có món nào được xác nhận, không thể thanh toán.`);
  }
}

/** Trạng thái bàn tương ứng với tình trạng đơn — dining dùng để vẽ sơ đồ. */
function tableStateFor(order, items = []) {
  if (!order || !isOpen(order)) return 'empty';
  if (order.status === ORDER_STATUS.SERVING) return 'serving';
  if (items.some((i) => i.status === ITEM_STATUS.SERVED)) return 'serving';
  return 'ordering';
}

/** Chuẩn hoá đơn trước khi trả ra API. */
function toView(order, items = []) {
  if (!order) return null;
  return {
    ...order,
    total_amount: toAmount(order.total_amount),
    items: items.map((i) => ({ ...i, price: toAmount(i.price), total_price: toAmount(i.total_price) })),
    pending_amount: computePendingTotal(items),
    pending_count: items.filter((i) => i.status === ITEM_STATUS.PENDING_CONFIRM).length,
    billable_count: items.filter((i) => BILLABLE_ITEM_STATUSES.includes(i.status)).length,
  };
}

/** Bản tóm tắt gửi qua realtime — nhẹ và không lộ dữ liệu thừa. */
function toSummary(order, items = []) {
  if (!order) return null;
  return {
    order_id: order.id,
    order_code: order.code,
    table_id: order.table_id,
    table_code: order.table_code,
    status: order.status,
    source: order.source,
    total_amount: toAmount(order.total_amount),
    items_count: items.length,
    pending_count: items.filter((i) => i.status === ITEM_STATUS.PENDING_CONFIRM).length,
    waiter_name: order.waiter_name,
    check_in_time: order.check_in_time,
    updated_at: order.updated_at || order.created_at,
    table_state: tableStateFor(order, items),
  };
}

module.exports = {
  ORDER_STATUS, ITEM_STATUS, ITEM_SOURCE,
  OPEN_STATUSES, BILLABLE_ITEM_STATUSES, STATUS_TRANSITIONS,
  isOpen, assertOpen, assertTransition, assertValidBasket, assertReadyForCheckout,
  computeTotal, computePendingTotal, hasPendingItems,
  tableStateFor, toView, toSummary,
};
