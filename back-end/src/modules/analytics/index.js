// =============================================================================
//  MODULE: analytics — Báo cáo doanh thu (CQRS read model)
// -----------------------------------------------------------------------------
//  Module chỉ-đọc đối với nghiệp vụ: nó không thay đổi đơn hàng hay hoá đơn,
//  chỉ nghe sự kiện và cộng dồn vào hình chiếu của riêng mình. Nhờ vậy báo cáo
//  nặng tới đâu cũng không làm chậm luồng bán hàng.
// =============================================================================
const service = require('./application/analytics-service');
const statRoutes = require('./interface/stat-routes');
const repo = require('./infrastructure/analytics-repository');
const EVENTS = require('../../platform/events/event-names');
const realtime = require('../../platform/realtime/realtime');
const log = require('../../shared/logger').child('analytics');

module.exports = {
  name: 'analytics',
  description: 'Báo cáo doanh thu theo giờ/ngày, món bán chạy, tỷ trọng phương thức thanh toán.',

  dependsOn: ['identity', 'billing'],
  owns: ['analytics_revenue_hourly', 'analytics_item_sales'],

  routers: [{ path: '/api/stats', router: statRoutes }],

  publishes: [],
  subscribes: [EVENTS.INVOICE_ISSUED],

  contract: {
    overview: service.overview,
    daily: service.daily,
  },

  async register({ eventBus }) {
    eventBus.subscribe(EVENTS.INVOICE_ISSUED, async (p) => {
      await service.onInvoiceIssued(p);
      // Dashboard của quản trị viên tự cập nhật, không cần bấm làm mới
      realtime.toRole('admin', 'stats:changed', { reason: 'invoice', invoice_id: p.invoice_id });
      realtime.toRole('cashier', 'stats:changed', { reason: 'invoice', invoice_id: p.invoice_id });
    }, 'analytics');

    // Lần đầu triển khai trên CSDL đã có hoá đơn → nạp lại lịch sử
    if (await repo.isEmpty()) {
      service.rebuild().catch((e) => log.warn(`Không nạp được dữ liệu báo cáo lịch sử: ${e.message}`));
    }
  },

  async healthCheck() {
    const today = await repo.revenueBetween(new Date().toISOString(), new Date().toISOString());
    return { ok: true, invoicesToday: Number(today?.invoice_count || 0) };
  },
};
