// =============================================================================
//  MODULE: dining — Khu vực, bàn ăn và sơ đồ bàn
// -----------------------------------------------------------------------------
//  Điểm kiến trúc đáng chú ý: dining KHÔNG phụ thuộc ordering, dù sơ đồ bàn
//  hiển thị thông tin đơn hàng. Nó NGHE sự kiện của ordering/billing/guest và
//  tự duy trì hình chiếu `dining_table_state`. Đây là cách phá vỡ phụ thuộc
//  vòng dining ↔ ordering mà vẫn giữ giao diện thời gian thực.
// =============================================================================
const contract = require('./contract');
const tableRoutes = require('./interface/table-routes');
const service = require('./application/table-service');
const repo = require('./infrastructure/table-repository');
const { TABLE_STATE } = require('./domain/table');
const EVENTS = require('../../platform/events/event-names');
const realtime = require('../../platform/realtime/realtime');
const log = require('../../shared/logger').child('dining');

module.exports = {
  name: 'dining',
  description: 'Khu vực, bàn ăn, mã QR của bàn và hình chiếu trạng thái bàn theo thời gian thực.',

  dependsOn: ['identity'],
  owns: ['dining_zones', 'tables', 'dining_table_state'],

  routers: [{ path: '/api/tables', router: tableRoutes }],

  publishes: [EVENTS.TABLE_CREATED, EVENTS.TABLE_UPDATED, EVENTS.TABLE_DELETED, EVENTS.TABLE_STATE_CHANGED],
  subscribes: [
    EVENTS.ORDER_CREATED, EVENTS.ORDER_ITEMS_ADDED, EVENTS.ORDER_UPDATED,
    EVENTS.ORDER_CANCELLED, EVENTS.ORDER_COMPLETED, EVENTS.ORDER_MOVED,
    EVENTS.INVOICE_ISSUED, EVENTS.GUEST_REQUEST_SUBMITTED, EVENTS.GUEST_REQUEST_REVIEWED,
  ],

  contract,

  async register({ eventBus }) {
    const sub = (event, fn) => eventBus.subscribe(event, fn, 'dining');

    // ── Đơn mở / có thay đổi → bàn chuyển sang trạng thái bận ──────────────
    const occupy = async (p) => {
      await service.applyOrderOpened({
        table_id: p.table_id,
        table_code: p.table_code,
        order_id: p.order_id,
        order_code: p.order_code,
        amount: p.total_amount,
        occupied_since: p.check_in_time,
        state: p.table_state || TABLE_STATE.ORDERING,
      });
    };

    sub(EVENTS.ORDER_CREATED, occupy);
    sub(EVENTS.ORDER_ITEMS_ADDED, occupy);
    sub(EVENTS.ORDER_UPDATED, occupy);

    // ── Đơn đóng (huỷ / thanh toán) → giải phóng bàn ───────────────────────
    const release = async (p) => service.applyTableReleased({ table_id: p.table_id, table_code: p.table_code });
    sub(EVENTS.ORDER_CANCELLED, release);
    sub(EVENTS.ORDER_COMPLETED, release);
    sub(EVENTS.INVOICE_ISSUED, release);

    // ── Chuyển bàn → giải phóng bàn cũ, chiếm bàn mới ──────────────────────
    sub(EVENTS.ORDER_MOVED, async (p) => {
      await service.applyTableReleased({ table_id: p.from_table_id, table_code: p.from_table_code });
      await occupy({ ...p, table_id: p.to_table_id, table_code: p.to_table_code });
    });

    // ── Khách quét QR gửi yêu cầu → hiện huy hiệu "chờ duyệt" trên sơ đồ ──
    sub(EVENTS.GUEST_REQUEST_SUBMITTED, async (p) => service.adjustPendingGuestRequests(p.table_id, +1));
    sub(EVENTS.GUEST_REQUEST_REVIEWED, async (p) => service.adjustPendingGuestRequests(p.table_id, -1));

    // ── Đẩy thay đổi trạng thái bàn xuống mọi màn hình nhân viên ──────────
    sub(EVENTS.TABLE_STATE_CHANGED, async (p) => realtime.toStaff('tables:changed', p));
    sub(EVENTS.TABLE_CREATED,  async (p) => realtime.toStaff('tables:changed', { reason: 'created', ...p }));
    sub(EVENTS.TABLE_UPDATED,  async (p) => realtime.toStaff('tables:changed', { reason: 'updated', ...p }));
    sub(EVENTS.TABLE_DELETED,  async (p) => realtime.toStaff('tables:changed', { reason: 'deleted', ...p }));

    log.debug('Đã đăng ký lắng nghe sự kiện cập nhật hình chiếu trạng thái bàn');
  },

  async healthCheck() {
    return { ok: true, tables: await repo.count(), zones: (await repo.listZones()).length };
  },
};
