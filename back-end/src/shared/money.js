// =============================================================================
//  SHARED KERNEL — Tiền tệ (VND)
// -----------------------------------------------------------------------------
//  VND không có đơn vị nhỏ hơn đồng, nên mọi phép tính tiền đều làm tròn về số
//  nguyên đồng. Tập trung tại đây để không nơi nào tự ý `Math.round` khác kiểu,
//  gây lệch tổng tiền giữa đơn hàng và hoá đơn.
// =============================================================================

/** Ép về số nguyên đồng (làm tròn nửa lên). */
function toAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** Cộng nhiều khoản tiền an toàn. */
const sum = (...values) => values.reduce((acc, v) => acc + toAmount(v), 0);

/** Nhân đơn giá × số lượng. */
const multiply = (price, qty) => toAmount(Number(price) * Number(qty));

/** Tính VAT trên một khoản tiền theo phần trăm. */
const percentOf = (amount, percent) => toAmount((toAmount(amount) * Number(percent)) / 100);

/** Định dạng hiển thị 1.234.567 ₫ */
const format = (amount) => `${toAmount(amount).toLocaleString('vi-VN')} ₫`;

module.exports = { toAmount, sum, multiply, percentOf, format };
