// =============================================================================
//  MODULE catalog · CONTRACT — API công khai cho các module khác
// -----------------------------------------------------------------------------
//  `priceBasket` là hàm quan trọng nhất: ordering và guest-access KHÔNG tự
//  truy vấn bảng menu_items để lấy giá, mà gọi qua đây. Nhờ vậy quy tắc
//  "giá luôn lấy từ thực đơn trong CSDL" chỉ tồn tại ở một chỗ duy nhất.
// =============================================================================
const service = require('./application/menu-service');
const repo = require('./infrastructure/menu-repository');

module.exports = {
  /**
   * Định giá giỏ hàng theo giá hiện hành trong thực đơn.
   * @param {Array<{menu_item_id:string, quantity:number, notes?:string}>} lines
   * @returns {Promise<{lines:Array, unavailable:string[], total:number}>}
   */
  priceBasket: service.priceBasket,

  /** Thực đơn rút gọn cho khách quét QR (chỉ món đang bán). */
  guestMenu: service.guestMenu,

  /** Một món theo id (đã chuẩn hoá giá về số nguyên đồng). */
  getItem: service.getItem,

  /** Các món đang bán theo danh sách id. */
  findActiveByIds: (ids) => repo.findActiveByIds(ids),

  /** Danh mục món — dùng cho bộ lọc báo cáo. */
  listCategories: service.listCategories,
};
