// =============================================================================
//  MODULE: ordering — Đơn hàng tại bàn
// -----------------------------------------------------------------------------
//  Phạm vi: vòng đời đơn (mở → phục vụ → thanh toán/huỷ), dòng món, chuyển bàn,
//  dọn bàn, và QUY TRÌNH XÁC NHẬN món do khách tự gọi qua mã QR.
//
//  Đây là module "lõi" — nơi hội tụ nghiệp vụ, nên nó phụ thuộc dining (bàn) và
//  catalog (giá món), nhưng KHÔNG module nào được phụ thuộc ngược vào nó theo
//  kiểu gọi hàm; dining và analytics chỉ lắng nghe sự kiện.
// =============================================================================
const contract = require('./contract');
const orderRoutes = require('./interface/order-routes');
const repo = require('./infrastructure/order-repository');
const dining = require('../dining/contract');
const EVENTS = require('../../platform/events/event-names');
const realtime = require('../../platform/realtime/realtime');
const log = require('../../shared/logger').child('ordering');

module.exports = {
  name: 'ordering',
  description: 'Đơn hàng tại bàn: mở đơn, thêm/sửa/xoá món, chuyển bàn, dọn bàn, duyệt món khách gọi qua QR.',

  dependsOn: ['identity', 'dining', 'catalog'],
  owns: ['orders', 'order_items'],

  routers: [{ path: '/api/orders', router: orderRoutes }],

  publishes: [
    EVENTS.ORDER_CREATED, EVENTS.ORDER_UPDATED, EVENTS.ORDER_ITEMS_ADDED,
    EVENTS.ORDER_CANCELLED, EVENTS.ORDER_COMPLETED, EVENTS.ORDER_MOVED,
    EVENTS.ORDER_ITEM_CONFIRMED, EVENTS.ORDER_ITEM_REJECTED,
  ],
  subscribes: [EVENTS.INVOICE_ISSUED],

  contract,

  async register({ eventBus }) {
    // ── Đẩy thay đổi đơn hàng xuống màn hình nhân viên ────────────────────
    const push = (event, name) =>
      eventBus.subscribe(event, async (p) => {
        realtime.toStaff(name, p);
        realtime.toStaff('orders:changed', { reason: name, order_id: p.order_id });
      }, 'ordering');

    push(EVENTS.ORDER_CREATED, 'order:created');
    push(EVENTS.ORDER_ITEMS_ADDED, 'order:updated');
    push(EVENTS.ORDER_UPDATED, 'order:updated');
    push(EVENTS.ORDER_CANCELLED, 'order:cancelled');
    push(EVENTS.ORDER_COMPLETED, 'order:completed');
    push(EVENTS.ORDER_MOVED, 'order:moved');
    push(EVENTS.ORDER_ITEM_CONFIRMED, 'order:item-confirmed');
    push(EVENTS.ORDER_ITEM_REJECTED, 'order:item-rejected');

    // ── Khách gửi món → báo động cho thu ngân và phục vụ ──────────────────
    eventBus.subscribe(EVENTS.GUEST_REQUEST_SUBMITTED, async (p) => {
      realtime.toRole('cashier', 'guest:request-pending', p);
      realtime.toRole('waiter', 'guest:request-pending', p);
      realtime.toRole('admin', 'guest:request-pending', p);
    }, 'ordering');

    // ── Thanh toán xong → cập nhật màn hình ───────────────────────────────
    // Việc ĐÓNG ĐƠN không làm ở đây mà nằm trong cùng transaction với việc lập
    // hoá đơn (billing gọi contract.closeOrderWithin). Nếu đóng đơn bằng sự
    // kiện, sẽ có khoảnh khắc hoá đơn đã tồn tại mà đơn vẫn "đang mở" — thu
    // ngân có thể thanh toán lần hai. Đây là lợi thế của Modular Monolith:
    // giao dịch xuyên module vẫn là ACID.
    eventBus.subscribe(EVENTS.INVOICE_ISSUED, async (p) => {
      realtime.toStaff('orders:changed', { reason: 'checkout', order_id: p.order_id });
    }, 'ordering');

    // ── Dựng lại hình chiếu trạng thái bàn lúc khởi động ──────────────────
    // Nếu server tắt đột ngột giữa lúc xử lý sự kiện, hình chiếu của dining có
    // thể lệch. Ordering là nguồn sự thật nên nó chủ động đồng bộ lại.
    try {
      const snapshot = await repo.snapshotOpenOrders();
      const n = await dining.rebuildOccupancy(snapshot);
      log.info(`Đã đồng bộ trạng thái ${n} bàn đang có đơn mở`);
    } catch (err) {
      log.warn(`Không dựng lại được hình chiếu trạng thái bàn: ${err.message}`);
    }
  },

  async healthCheck() {
    return { ok: true, openOrders: await repo.countOpen() };
  },
};
