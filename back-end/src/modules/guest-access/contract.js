// =============================================================================
//  MODULE guest-access · CONTRACT
// -----------------------------------------------------------------------------
//  Hiện chỉ platform/realtime cần `verifyTokenForSocket` để xác thực WebSocket
//  của khách. Contract nhỏ là dấu hiệu tốt: module này gần như tự chứa.
// =============================================================================
const sessionService = require('./application/guest-session-service');
const orderService = require('./application/guest-order-service');

module.exports = {
  /** Xác minh guest token cho kết nối WebSocket (chỉ kiểm tra chữ ký). */
  verifyTokenForSocket: sessionService.verifyTokenForSocket,

  /** Lịch sử yêu cầu của một bàn — dùng cho màn hình nhân viên. */
  listRequestsForTable: orderService.listRequestsForTable,

  /** Đóng mọi phiên khách của một bàn. */
  closeSessionsForTable: sessionService.closeSessionsForTable,
};
