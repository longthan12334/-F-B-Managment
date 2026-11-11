// =============================================================================
//  MODULE dining · DOMAIN — Quy tắc nghiệp vụ của bàn ăn
// =============================================================================
const { AppError } = require('../../../shared/errors');

const TABLE_CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,15}$/;
const MAX_CAPACITY = 20;

/** Trạng thái bàn (đồng bộ với CHECK constraint của dining_table_state). */
const TABLE_STATE = Object.freeze({
  EMPTY: 'empty',                       // trống, sẵn sàng nhận khách
  ORDERING: 'ordering',                 // khách đã ngồi, đơn đang mở, chưa phục vụ xong
  SERVING: 'serving',                   // đang phục vụ
  AWAITING_PAYMENT: 'awaiting_payment', // đã gọi thanh toán
  INACTIVE: 'inactive',                 // tạm ngưng (sửa chữa, kê lại)
});

/** Màu/nhãn hiển thị — đặt ở domain để web và mobile dùng chung một bộ. */
const STATE_LABELS = Object.freeze({
  empty:            { label: 'Trống',            tone: 'neutral' },
  ordering:         { label: 'Đang gọi món',     tone: 'info' },
  serving:          { label: 'Đang phục vụ',     tone: 'warning' },
  awaiting_payment: { label: 'Chờ thanh toán',   tone: 'danger' },
  inactive:         { label: 'Tạm ngưng',        tone: 'muted' },
});

function assertValidTable({ code, capacity }, { partial = false } = {}) {
  const errs = [];
  if (!partial || code !== undefined) {
    const c = String(code || '').trim().toUpperCase();
    if (!TABLE_CODE_RE.test(c)) errs.push('code: 2–16 ký tự, chỉ gồm chữ in hoa, số và dấu -');
  }
  if (!partial || capacity !== undefined) {
    const n = Number(capacity);
    if (!Number.isInteger(n) || n < 1 || n > MAX_CAPACITY) {
      errs.push(`capacity: số nguyên từ 1 đến ${MAX_CAPACITY}`);
    }
  }
  if (errs.length) throw AppError.validation('Dữ liệu bàn không hợp lệ', errs);
}

/** Không được tạm ngưng bàn đang có khách. */
function assertCanDeactivate(tableState) {
  const busy = [TABLE_STATE.ORDERING, TABLE_STATE.SERVING, TABLE_STATE.AWAITING_PAYMENT];
  if (tableState && busy.includes(tableState.state)) {
    throw AppError.conflict(
      `Bàn ${tableState.table_code} đang có đơn mở (${tableState.current_order_code || 'chưa rõ mã'}). ` +
      'Hãy thanh toán hoặc dọn bàn trước khi tạm ngưng.'
    );
  }
}

/** Không được xoá bàn đang có khách. */
function assertCanDelete(tableState) {
  if (tableState && tableState.state !== TABLE_STATE.EMPTY && tableState.state !== TABLE_STATE.INACTIVE) {
    throw AppError.conflict(`Bàn ${tableState.table_code} đang có khách, không thể xoá.`);
  }
}

/** Phút đã ngồi, phục vụ cho cảnh báo bàn ngồi quá lâu. */
function minutesOccupied(occupiedSince) {
  if (!occupiedSince) return 0;
  return Math.max(0, Math.round((Date.now() - new Date(occupiedSince).getTime()) / 60000));
}

module.exports = {
  TABLE_STATE, STATE_LABELS, TABLE_CODE_RE, MAX_CAPACITY,
  assertValidTable, assertCanDeactivate, assertCanDelete, minutesOccupied,
};
