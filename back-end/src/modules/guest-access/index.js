// =============================================================================
//  MODULE: guest-access — Khách quét mã QR tự gọi món
// -----------------------------------------------------------------------------
//  Đây là module trả lời ba nhận xét của giảng viên:
//    1. "chưa rõ việc lưu thông tin khi khách đặt qua QR (chưa nắm thiết kế
//        bảng)"  →  guest_sessions, guest_order_requests (xem migrations/)
//    2. "chưa xem lịch sử đặt ở bên khách hàng"
//        →  GET /api/public/orders  (màn hình "Đơn của tôi")
//    3. "cần có xác nhận đơn"
//        →  order_items.status = pending_confirm → confirmed/rejected,
//           duyệt tại POST /api/orders/guest-requests/:id/review
//
//  Tác nhân KHÁCH HÀNG vì vậy trở thành một actor thực thụ của hệ thống, có
//  phiên riêng, dữ liệu riêng và quyền hạn riêng — không còn là "người dùng
//  ẩn danh gửi dữ liệu vào API công khai" như phiên bản trước.
// =============================================================================
const contract = require('./contract');
const publicRoutes = require('./interface/public-routes');
const staffRoutes = require('./interface/staff-routes');
const orderService = require('./application/guest-order-service');
const sessionService = require('./application/guest-session-service');
const repo = require('./infrastructure/guest-repository');
const EVENTS = require('../../platform/events/event-names');
const realtime = require('../../platform/realtime/realtime');
const log = require('../../shared/logger').child('guest-access');

module.exports = {
  name: 'guest-access',
  description: 'Phiên khách quét mã QR: gọi món, theo dõi trạng thái xác nhận và xem lịch sử đơn của mình.',

  dependsOn: ['identity', 'dining', 'catalog', 'ordering'],
  owns: ['guest_sessions', 'guest_order_requests'],

  routers: [
    { path: '/api/public', router: publicRoutes },
    { path: '/api/guest-requests', router: staffRoutes },
  ],

  publishes: [
    EVENTS.GUEST_SESSION_STARTED, EVENTS.GUEST_SESSION_CLOSED,
    EVENTS.GUEST_REQUEST_SUBMITTED, EVENTS.GUEST_REQUEST_REVIEWED,
  ],
  subscribes: [
    EVENTS.ORDER_ITEM_CONFIRMED, EVENTS.ORDER_ITEM_REJECTED,
    EVENTS.INVOICE_ISSUED, EVENTS.ORDER_CANCELLED,
  ],

  contract,

  async register({ eventBus }) {
    const sub = (event, fn) => eventBus.subscribe(event, fn, 'guest-access');

    // ── Nhân viên duyệt/từ chối → cập nhật trạng thái yêu cầu của khách ───
    const onReviewed = async (p) => {
      if (!p.guest_request_id) return;
      const updated = await orderService.syncRequestStatus(p.guest_request_id, {
        id: p.reviewer_id, name: p.reviewer_name,
      });
      if (!updated) return;

      // Đẩy kết quả về ĐÚNG phiên của khách đó (phòng riêng guest:<sid>)
      realtime.toGuest(updated.guest_session_id, 'guest:request-reviewed', {
        request_id: updated.id,
        status: updated.status,
        confirmed_amount: Number(updated.confirmed_amount || 0),
        reject_reason: updated.reject_reason,
        reviewed_by_name: updated.reviewed_by_name,
      });
    };
    sub(EVENTS.ORDER_ITEM_CONFIRMED, onReviewed);
    sub(EVENTS.ORDER_ITEM_REJECTED, onReviewed);

    // ── Thanh toán xong → đóng phiên của bàn, báo cho khách ───────────────
    sub(EVENTS.INVOICE_ISSUED, async (p) => {
      if (!p.table_id) return;
      const n = await sessionService.closeSessionsForTable(p.table_id, 'CHECKED_OUT');
      if (n) log.debug(`Đã đóng ${n} phiên khách của bàn ${p.table_code} sau khi thanh toán`);
    });

    // ── Dọn bàn / huỷ đơn → đóng phiên để khách không gọi tiếp vào đơn cũ ─
    sub(EVENTS.ORDER_CANCELLED, async (p) => {
      if (!p.table_id) return;
      await sessionService.closeSessionsForTable(p.table_id, 'ORDER_CANCELLED');
    });

    // ── Thông báo phiên khách đóng → cập nhật UI của chính khách đó ───────
    sub(EVENTS.GUEST_SESSION_CLOSED, async (p) => {
      realtime.toGuest(p.session_id, 'guest:session-closed', { reason: p.reason });
    });

    // ── Tác vụ nền: hết hạn phiên cũ & ẩn danh dữ liệu kỹ thuật ──────────
    const timer = setInterval(async () => {
      try {
        const expired = await repo.expireStaleSessions();
        const anonymized = await repo.anonymizeOldSessions(30);
        if (expired || anonymized) {
          log.info(`Dọn phiên khách: ${expired} hết hạn, ${anonymized} đã ẩn danh dữ liệu kỹ thuật`);
        }
      } catch (err) {
        log.warn(`Dọn phiên khách lỗi: ${err.message}`);
      }
    }, 30 * 60 * 1000);
    timer.unref();
  },

  async healthCheck() {
    return {
      ok: true,
      activeSessions: await repo.countActiveSessions(),
      pendingRequests: await repo.countPendingRequests(),
    };
  },
};
