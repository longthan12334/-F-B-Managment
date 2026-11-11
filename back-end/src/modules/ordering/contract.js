// =============================================================================
//  MODULE ordering · CONTRACT — API công khai cho các module khác
// -----------------------------------------------------------------------------
//  Người dùng chính:
//    • billing      : đọc đơn + kiểm tra điều kiện thanh toán, đóng đơn.
//    • guest-access : gửi món khách gọi, đọc món của một lượt gửi.
// =============================================================================
const service = require('./application/order-service');
const guestItems = require('./application/guest-items-service');
const repo = require('./infrastructure/order-repository');
const domain = require('./domain/order');

module.exports = {
  ORDER_STATUS: domain.ORDER_STATUS,
  ITEM_STATUS: domain.ITEM_STATUS,
  BILLABLE_ITEM_STATUSES: domain.BILLABLE_ITEM_STATUSES,

  /** Đơn đầy đủ (kèm dòng món, tổng tiền đã chuẩn hoá). */
  getOrder: (id) => service.loadOrderView(id),

  /** Đơn đang mở của một bàn, hoặc null. */
  getOpenOrderForTable: service.getOpenOrderForTable,

  /** Kiểm tra đơn đủ điều kiện thanh toán (còn món chờ duyệt thì chặn). */
  assertReadyForCheckout: domain.assertReadyForCheckout,

  /**
   * Đóng đơn NGAY TRONG transaction của module gọi.
   *
   * billing dùng hàm này để "lập hoá đơn" và "đóng đơn" là một thao tác nguyên
   * tử: hoặc cả hai cùng thành công, hoặc cùng bị huỷ. Đây chính là điểm mạnh
   * của Modular Monolith — với microservices phải dùng Saga + bù trừ, ở đây chỉ
   * cần truyền chung một `client` của PostgreSQL.
   *
   * @param {import('pg').PoolClient} client Transaction đang mở của bên gọi
   */
  closeOrderWithin: (client, orderId) => repo.updateStatus(orderId, domain.ORDER_STATUS.COMPLETED, client),

  /** Đóng đơn ngoài transaction (dùng cho kịch bản không cần nguyên tử). */
  completeOrder: (orderId, actor) => service.updateStatus(orderId, domain.ORDER_STATUS.COMPLETED, actor),

  /** Dòng món của một đơn — billing dùng để sao chép sang hoá đơn. */
  getOrderItems: (orderId, client) => repo.getItems(orderId, client),

  /** Đơn theo id, có thể trong transaction của bên gọi. */
  getOrderRaw: (orderId, client) => repo.findById(orderId, client),

  /** Ảnh chụp đơn đang mở — dining dùng để dựng lại hình chiếu trạng thái bàn. */
  snapshotOpenOrders: () => repo.snapshotOpenOrders(),

  // ── Dành cho guest-access ───────────────────────────────────────────────
  /** Khách gửi món qua QR → tạo/bổ sung đơn với các dòng chờ duyệt. */
  submitGuestItems: guestItems.submitGuestItems,

  /** Các dòng món thuộc một lượt khách gửi (để dựng lịch sử cho khách). */
  itemsOfGuestRequest: guestItems.itemsOfGuestRequest,

  /** Nhãn hiển thị cho đơn do khách tự gọi. */
  GUEST_WAITER_LABEL: guestItems.GUEST_WAITER_LABEL,
};
