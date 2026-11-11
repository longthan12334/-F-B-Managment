// =============================================================================
//  MODULE analytics · APPLICATION — Báo cáo & dashboard
// =============================================================================
const repo = require('../infrastructure/analytics-repository');
const billing = require('../../billing/contract');
const { toAmount } = require('../../../shared/money');
const { config } = require('../../../shared/config');
const log = require('../../../shared/logger').child('analytics');

/** Khoảng mặc định: từ 00:00 tới 23:59:59 hôm nay theo giờ Việt Nam. */
function defaultRange(from, to) {
  const now = new Date();
  const start = from ? new Date(from) : new Date(now.setHours(0, 0, 0, 0));
  const end = to ? new Date(to) : new Date(new Date().setHours(23, 59, 59, 999));
  return { from: start.toISOString(), to: end.toISOString() };
}

async function overview({ from, to } = {}) {
  const range = defaultRange(from, to);

  const [summary, byHour, byMethod, topItems] = await Promise.all([
    repo.revenueBetween(range.from, range.to),
    repo.hourlyForDay(range.from),
    repo.paymentBreakdown(range.from, range.to),
    repo.topItems(range.from, range.to, 5),
  ]);

  const invoiceCount = Number(summary.invoice_count || 0);
  const netRevenue = toAmount(summary.net_revenue);

  return {
    summary: {
      invoice_count: invoiceCount,
      total_revenue: netRevenue,
      gross_amount: toAmount(summary.gross_amount),
      discount_total: toAmount(summary.discount_total),
      vat_total: toAmount(summary.vat_total),
      avg_invoice: invoiceCount ? Math.round(netRevenue / invoiceCount) : 0,
    },
    byHour: byHour.map((r) => ({ hour: Number(r.hour), count: Number(r.count), revenue: toAmount(r.revenue) })),
    byPaymentMethod: byMethod.map((r) => ({
      payment_method: r.payment_method,
      payment_label: billing.PAYMENT_LABELS[r.payment_method] || r.payment_method,
      revenue: toAmount(r.revenue),
    })),
    topItems: topItems.map((r) => ({
      name: r.name, qty: Number(r.qty), revenue: toAmount(r.revenue), price: toAmount(r.price),
    })),
    meta: { ...range, timezone: config.business.timezone },
  };
}

async function daily({ days = 14 } = {}) {
  const n = Math.min(Math.max(parseInt(days, 10) || 14, 1), 90);
  const rows = await repo.dailySeries(n);
  return rows.map((r) => ({
    day: r.day,
    invoice_count: Number(r.invoice_count),
    revenue: toAmount(r.revenue),
  }));
}

/**
 * Dựng lại toàn bộ hình chiếu từ nguồn sự thật (bảng invoices của billing).
 * Dùng khi: triển khai lần đầu trên CSDL đã có dữ liệu, hoặc nghi ngờ hình
 * chiếu bị lệch. Gọi `billing.listInvoices()` qua CONTRACT, không đọc bảng
 * `invoices` trực tiếp — giữ nguyên ranh giới module.
 */
async function rebuild({ since } = {}) {
  const started = Date.now();
  await repo.truncate();

  const invoices = await billing.listInvoices({
    from: since || new Date(Date.now() - 365 * 86400 * 1000).toISOString(),
    limit: 2000,
  });

  for (const inv of invoices) {
    await repo.applyInvoice({
      created_at: inv.created_at,
      total_amount: inv.total_amount,
      discount: inv.discount,
      vat_amount: inv.vat_amount,
      final_amount: inv.final_amount,
      payment_method: inv.payment_method,
    });
    if (inv.items?.length) await repo.applyItems(inv.created_at, inv.items);
  }

  log.info(`Đã dựng lại hình chiếu báo cáo từ ${invoices.length} hoá đơn (${Date.now() - started}ms)`);
  return { invoices: invoices.length, durationMs: Date.now() - started };
}

/** Xử lý sự kiện hoá đơn mới — cộng dồn vào hình chiếu. */
async function onInvoiceIssued(payload) {
  await repo.applyInvoice({
    created_at: payload.created_at || new Date().toISOString(),
    total_amount: payload.total_amount || 0,
    discount: payload.discount || 0,
    vat_amount: payload.vat_amount || 0,
    final_amount: payload.final_amount || 0,
    payment_method: payload.payment_method || 'cash',
  });

  // Payload sự kiện cố ý không mang toàn bộ dòng món (giữ gói tin nhỏ);
  // lấy chi tiết qua contract của billing khi cần.
  const invoice = await billing.getInvoice(payload.invoice_id).catch(() => null);
  if (invoice?.items?.length) {
    await repo.applyItems(invoice.created_at, invoice.items);
  }
}

module.exports = { overview, daily, rebuild, onInvoiceIssued, defaultRange };
