// =============================================================================
//  MODULE billing · CONTRACT — API công khai cho các module khác
// -----------------------------------------------------------------------------
//  analytics dùng contract này thay vì truy vấn trực tiếp bảng `invoices`.
// =============================================================================
const repo = require('./infrastructure/invoice-repository');
const service = require('./application/checkout-service');
const { PAYMENT_METHODS, PAYMENT_LABELS, computeTotals } = require('./domain/invoice');

module.exports = {
  PAYMENT_METHODS,
  PAYMENT_LABELS,

  /** Công thức tính tiền (thuần tuý) — dùng để xem trước hoá đơn trước khi thu. */
  computeTotals,

  /** Hoá đơn theo id. */
  getInvoice: service.getInvoice,

  /** Hoá đơn của một đơn hàng, hoặc null. */
  getInvoiceByOrder: (orderId) => repo.findByOrderId(orderId),

  /** Danh sách hoá đơn theo bộ lọc (dùng cho báo cáo). */
  listInvoices: service.listInvoices,
};
