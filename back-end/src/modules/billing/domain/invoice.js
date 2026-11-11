// =============================================================================
//  MODULE billing · DOMAIN — Quy tắc tính tiền
// -----------------------------------------------------------------------------
//  Công thức duy nhất của hệ thống:
//      tạm tính   = tổng các dòng món được tính tiền
//      sau giảm   = tạm tính − giảm giá
//      VAT        = làm tròn(sau giảm × thuế suất / 100)
//      phải trả   = sau giảm + VAT
//      tiền thừa  = khách đưa − phải trả
//
//  Mọi số tiền là SỐ NGUYÊN ĐỒNG (VND không có đơn vị nhỏ hơn). Làm tròn tập
//  trung tại shared/money để tổng tiền đơn và tổng tiền hoá đơn không lệch nhau
//  một đồng do mỗi nơi làm tròn một kiểu.
// =============================================================================
const { AppError } = require('../../../shared/errors');
const { toAmount, percentOf } = require('../../../shared/money');

const PAYMENT_METHODS = Object.freeze([
  'cash', 'card', 'transfer', 'online', 'grab', 'vnpay', 'banking', 'momo', 'zalopay',
]);

const PAYMENT_LABELS = Object.freeze({
  cash: 'Tiền mặt', card: 'Thẻ', transfer: 'Chuyển khoản', online: 'Thanh toán online',
  grab: 'GrabFood', vnpay: 'VNPay', banking: 'Internet Banking', momo: 'MoMo', zalopay: 'ZaloPay',
});

const MAX_VAT_RATE = 100;

/**
 * Tính toàn bộ các khoản tiền của một hoá đơn.
 * Hàm thuần tuý → kiểm thử trực tiếp bằng unit test, không cần CSDL.
 */
function computeTotals({ subtotal, discount = 0, vatRate = 8, paidAmount }) {
  const base = toAmount(subtotal);
  const disc = toAmount(discount);
  const rate = Number(vatRate);

  const errs = [];
  if (base < 0) errs.push('Tổng tiền món không hợp lệ');
  if (disc < 0) errs.push('discount: không được âm');
  if (disc > base) errs.push(`discount: không vượt quá tổng tiền món (${base.toLocaleString('vi-VN')} ₫)`);
  if (!Number.isFinite(rate) || rate < 0 || rate > MAX_VAT_RATE) errs.push(`vat_rate: từ 0 đến ${MAX_VAT_RATE}`);
  if (errs.length) throw AppError.validation('Dữ liệu thanh toán không hợp lệ', errs);

  const afterDiscount = base - disc;
  const vatAmount = percentOf(afterDiscount, rate);
  const finalAmount = afterDiscount + vatAmount;

  const paid = paidAmount === undefined || paidAmount === null ? finalAmount : toAmount(paidAmount);
  if (paid < 0) throw AppError.validation('Dữ liệu thanh toán không hợp lệ', ['paid_amount: không được âm']);
  if (paid < finalAmount) {
    throw AppError.validation('Khách trả thiếu', [
      `paid_amount: cần tối thiểu ${finalAmount.toLocaleString('vi-VN')} ₫, nhận ${paid.toLocaleString('vi-VN')} ₫`,
    ]);
  }

  return {
    total_amount: base,
    discount: disc,
    vat_rate: rate,
    vat_amount: vatAmount,
    final_amount: finalAmount,
    paid_amount: paid,
    change_amount: paid - finalAmount,
  };
}

function assertValidPaymentMethod(method) {
  if (method && !PAYMENT_METHODS.includes(method)) {
    throw AppError.validation('Phương thức thanh toán không hợp lệ', [
      `payment_method: phải thuộc {${PAYMENT_METHODS.join('|')}}`,
    ]);
  }
}

function toView(invoice, items = []) {
  if (!invoice) return null;
  return {
    ...invoice,
    total_amount: toAmount(invoice.total_amount),
    discount: toAmount(invoice.discount),
    vat_amount: toAmount(invoice.vat_amount),
    final_amount: toAmount(invoice.final_amount),
    paid_amount: toAmount(invoice.paid_amount),
    change_amount: toAmount(invoice.change_amount),
    payment_label: PAYMENT_LABELS[invoice.payment_method] || invoice.payment_method,
    items: items.map((i) => ({ ...i, price: toAmount(i.price), total_price: toAmount(i.total_price) })),
  };
}

module.exports = { PAYMENT_METHODS, PAYMENT_LABELS, computeTotals, assertValidPaymentMethod, toView };
