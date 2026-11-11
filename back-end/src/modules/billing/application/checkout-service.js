// =============================================================================
//  MODULE billing · APPLICATION — Use-case thanh toán
// -----------------------------------------------------------------------------
//  Thanh toán là thao tác xuyên module: đọc đơn (ordering) → lập hoá đơn
//  (billing) → đóng đơn (ordering). Cả ba bước nằm trong MỘT transaction
//  PostgreSQL. Nếu bước nào hỏng thì không có hoá đơn mồ côi, cũng không có
//  đơn bị đóng mà chưa thu tiền.
//
//  (Với microservices, cùng kịch bản này phải triển khai Saga + hành động bù
//  trừ + xử lý trạng thái trung gian. Đây là lý do chính chọn Modular Monolith
//  cho bài toán POS nhà hàng — xem Mục 4.2 báo cáo.)
// =============================================================================
const db = require('../../../platform/database/pool');
const repo = require('../infrastructure/invoice-repository');
const ordering = require('../../ordering/contract');
const domain = require('../domain/invoice');
const { AppError } = require('../../../shared/errors');
const { config } = require('../../../shared/config');
const EVENTS = require('../../../platform/events/event-names');
const bus = require('../../../platform/events/event-bus');

async function checkout(orderId, input, cashier) {
  domain.assertValidPaymentMethod(input.payment_method);

  const invoice = await db.transaction(async (client) => {
    // 1) Nạp đơn trong transaction để không ai sửa giữa chừng
    const order = await ordering.getOrderRaw(orderId, client);
    if (!order) throw AppError.notFound('Đơn hàng không tồn tại');

    const existing = await repo.findByOrderId(orderId, client);
    if (existing) {
      throw AppError.conflict(`Đơn ${order.code} đã được thanh toán (hoá đơn ${existing.code}).`);
    }

    const items = await ordering.getOrderItems(orderId, client);

    // 2) Kiểm tra điều kiện: đơn còn mở & không còn món khách gọi chờ duyệt
    ordering.assertReadyForCheckout(order, items);

    const billable = items.filter((i) => ordering.BILLABLE_ITEM_STATUSES.includes(i.status));
    const subtotal = billable.reduce((s, i) => s + Number(i.total_price), 0);

    // 3) Tính tiền (hàm thuần tuý trong domain)
    const totals = domain.computeTotals({
      subtotal,
      discount: input.discount,
      vatRate: input.vat_rate !== undefined ? input.vat_rate : config.business.defaultVatRate,
      paidAmount: input.paid_amount,
    });

    // 4) Ghi hoá đơn + sao chép dòng món (snapshot bất biến)
    const created = await repo.insert({
      order_id: order.id,
      table_code: order.table_code,
      waiter_name: order.waiter_name,
      cashier_id: cashier?.id || null,
      cashier_name: String(input.cashier_name || cashier?.full_name || 'Thu ngân').trim(),
      discount_note: input.discount_note,
      payment_method: input.payment_method || 'cash',
      check_in_time: order.check_in_time,
      ...totals,
    }, client);

    const invoiceItems = await repo.insertItems(created.id, billable, client);

    // 5) Đóng đơn — CÙNG transaction với bước 4
    await ordering.closeOrderWithin(client, orderId);

    return { ...created, items: invoiceItems, _order: order };
  }).catch((err) => {
    if (err.code === '23505') throw AppError.conflict('Đơn này vừa được thanh toán bởi người khác.');
    throw err;
  });

  const view = domain.toView(invoice, invoice.items);

  bus.publish(EVENTS.INVOICE_ISSUED, {
    invoice_id: invoice.id,
    invoice_code: invoice.code,
    order_id: invoice.order_id,
    order_code: invoice._order?.code,
    table_id: invoice._order?.table_id,
    table_code: invoice.table_code,
    final_amount: view.final_amount,
    total_amount: view.total_amount,
    discount: view.discount,
    vat_amount: view.vat_amount,
    payment_method: invoice.payment_method,
    cashier_id: invoice.cashier_id,
    cashier_name: invoice.cashier_name,
    items_count: invoice.items.length,
    created_at: invoice.created_at,
  }, { actor: cashier?.full_name });

  delete view._order;
  return view;
}

async function getInvoice(id) {
  const inv = await repo.findById(id);
  if (!inv) throw AppError.notFound('Hoá đơn không tồn tại');
  return domain.toView(inv, await repo.getItems(id));
}

async function listInvoices(filters) {
  const rows = await repo.findAll(filters);
  const withItems = await repo.attachItemsBulk(rows);
  return withItems.map((inv) => domain.toView(inv, inv.items));
}

module.exports = { checkout, getInvoice, listInvoices };
