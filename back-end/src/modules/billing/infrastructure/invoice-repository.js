// =============================================================================
//  MODULE billing · INFRASTRUCTURE — Truy cập invoices / invoice_items
// =============================================================================
const db = require('../../../platform/database/pool');

class InvoiceRepository {
  async insert(invoice, client) {
    const r = db.runner(client);
    return r.queryOne(
      `INSERT INTO invoices
         (order_id, table_code, waiter_name, cashier_id, cashier_name,
          total_amount, discount, discount_note, vat_rate, vat_amount, final_amount,
          paid_amount, change_amount, check_in_time, check_out_time, payment_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),$15)
       RETURNING *`,
      [
        invoice.order_id, invoice.table_code, invoice.waiter_name,
        invoice.cashier_id || null, invoice.cashier_name,
        invoice.total_amount, invoice.discount, invoice.discount_note || null,
        invoice.vat_rate, invoice.vat_amount, invoice.final_amount,
        invoice.paid_amount, invoice.change_amount,
        invoice.check_in_time, invoice.payment_method,
      ]
    );
  }

  async insertItems(invoiceId, items, client) {
    const r = db.runner(client);
    const out = [];
    for (const it of items) {
      out.push(await r.queryOne(
        `INSERT INTO invoice_items (invoice_id, order_item_id, item_name, quantity, price, total_price, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [invoiceId, it.id || null, it.item_name, it.quantity, it.price, it.total_price, it.notes || null]
      ));
    }
    return out;
  }

  async findById(id) {
    return db.queryOne('SELECT * FROM invoices WHERE id = $1', [id]);
  }

  async findByOrderId(orderId, client = null) {
    const r = db.runner(client);
    return r.queryOne('SELECT * FROM invoices WHERE order_id = $1', [orderId]);
  }

  async getItems(invoiceId) {
    return db.query('SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id', [invoiceId]);
  }

  async findAll({ table_code, cashier_name, cashier_id, payment_method, from, to, limit = 500 } = {}) {
    const conds = [];
    const params = [];
    if (table_code)     { params.push(table_code);         conds.push(`table_code = $${params.length}`); }
    if (cashier_name)   { params.push(`%${cashier_name}%`); conds.push(`cashier_name ILIKE $${params.length}`); }
    if (cashier_id)     { params.push(cashier_id);         conds.push(`cashier_id = $${params.length}`); }
    if (payment_method) { params.push(payment_method);     conds.push(`payment_method = $${params.length}`); }
    if (from)           { params.push(from);               conds.push(`created_at >= $${params.length}`); }
    if (to)             { params.push(to);                 conds.push(`created_at <= $${params.length}`); }
    params.push(Math.min(Number(limit) || 500, 2000));
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return db.query(
      `SELECT * FROM invoices ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
  }

  /** Nạp dòng món cho nhiều hoá đơn trong MỘT truy vấn (tránh N+1 query). */
  async attachItemsBulk(invoices) {
    if (!invoices.length) return invoices;
    const ids = invoices.map((i) => i.id);
    const rows = await db.query(
      'SELECT * FROM invoice_items WHERE invoice_id = ANY($1::uuid[]) ORDER BY id',
      [ids]
    );
    const byInvoice = new Map();
    for (const r of rows) {
      if (!byInvoice.has(r.invoice_id)) byInvoice.set(r.invoice_id, []);
      byInvoice.get(r.invoice_id).push(r);
    }
    return invoices.map((inv) => ({ ...inv, items: byInvoice.get(inv.id) || [] }));
  }

  async countToday() {
    const row = await db.queryOne(
      `SELECT COUNT(*)::int AS count FROM invoices WHERE created_at >= date_trunc('day', NOW())`
    );
    return row?.count ?? 0;
  }
}

module.exports = new InvoiceRepository();
