// =============================================================================
//  MODULE: billing — Hoá đơn & thanh toán
// -----------------------------------------------------------------------------
//  Phạm vi: tính tiền (giảm giá, VAT, tiền khách đưa, tiền thừa), phát hành
//  hoá đơn bất biến, tra cứu lịch sử hoá đơn.
// =============================================================================
const contract = require('./contract');
const invoiceRoutes = require('./interface/invoice-routes');
const legacyCheckoutRoute = require('./interface/legacy-checkout-route');
const repo = require('./infrastructure/invoice-repository');
const EVENTS = require('../../platform/events/event-names');
const realtime = require('../../platform/realtime/realtime');

module.exports = {
  name: 'billing',
  description: 'Thanh toán và hoá đơn: giảm giá, VAT, tiền thừa, lịch sử hoá đơn bất biến.',

  dependsOn: ['identity', 'ordering'],
  owns: ['invoices', 'invoice_items'],

  routers: [
    { path: '/api/invoices', router: invoiceRoutes },
    // Tương thích ngược cho ứng dụng di động bản cũ — xem file route để biết
    // kế hoạch gỡ bỏ.
    { path: '/api/orders', router: legacyCheckoutRoute, legacy: true },
  ],

  publishes: [EVENTS.INVOICE_ISSUED],
  subscribes: [],

  contract,

  async register({ eventBus }) {
    eventBus.subscribe(EVENTS.INVOICE_ISSUED, async (p) => {
      realtime.toStaff('invoice:created', p);
      // Khách quét QR cũng được báo đã thanh toán xong (nếu còn mở trang)
      if (p.guest_session_id) realtime.toGuest(p.guest_session_id, 'invoice:paid', p);
    }, 'billing');
  },

  async healthCheck() {
    return { ok: true, invoicesToday: await repo.countToday() };
  },
};
