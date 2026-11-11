// =============================================================================
//  MODULE ordering · INFRASTRUCTURE — Truy cập orders / order_items
// -----------------------------------------------------------------------------
//  Mọi hàm ghi đều nhận `client` tuỳ chọn để nhiều thao tác gộp chung một
//  transaction (ví dụ: thêm món + tính lại tổng tiền phải nguyên tử).
// =============================================================================
const db = require('../../../platform/database/pool');
const { BILLABLE_ITEM_STATUSES, OPEN_STATUSES } = require('../domain/order');

const BILLABLE_SQL = BILLABLE_ITEM_STATUSES.map((s) => `'${s}'`).join(',');
const OPEN_SQL = OPEN_STATUSES.map((s) => `'${s}'`).join(',');

class OrderRepository {
  // ── Đọc ──────────────────────────────────────────────────────────────────
  async findById(id, client = null) {
    const r = db.runner(client);
    return r.queryOne('SELECT * FROM orders WHERE id = $1', [id]);
  }

  async findByCode(code) {
    return db.queryOne('SELECT * FROM orders WHERE code = $1', [code]);
  }

  async findOpenByTable(tableId, client = null) {
    const r = db.runner(client);
    return r.queryOne(
      `SELECT * FROM orders WHERE table_id = $1 AND status IN (${OPEN_SQL})
       ORDER BY created_at DESC LIMIT 1`,
      [tableId]
    );
  }

  async findAll({ status, table_code, waiter_id, source, from, to } = {}) {
    const conds = [];
    const params = [];
    if (status) {
      const list = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      const ph = list.map((_, i) => `$${params.length + i + 1}`);
      conds.push(`status IN (${ph.join(',')})`);
      params.push(...list);
    }
    if (table_code) { params.push(table_code); conds.push(`table_code = $${params.length}`); }
    if (waiter_id)  { params.push(waiter_id);  conds.push(`waiter_id = $${params.length}`); }
    if (source)     { params.push(source);     conds.push(`source = $${params.length}`); }
    if (from)       { params.push(from);       conds.push(`created_at >= $${params.length}`); }
    if (to)         { params.push(to);         conds.push(`created_at <= $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return db.query(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT 500`, params);
  }

  async getItems(orderId, client = null) {
    const r = db.runner(client);
    return r.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY created_at, id', [orderId]);
  }

  async getItem(orderId, itemId, client = null) {
    const r = db.runner(client);
    return r.queryOne('SELECT * FROM order_items WHERE id = $1 AND order_id = $2', [itemId, orderId]);
  }

  /** Các món đang chờ duyệt của toàn nhà hàng — hàng đợi cho nhân viên. */
  async findPendingItems({ table_code } = {}) {
    const params = [];
    let extra = '';
    if (table_code) { params.push(table_code); extra = `AND o.table_code = $${params.length}`; }
    return db.query(
      `SELECT oi.*, o.code AS order_code, o.table_id, o.table_code, o.source AS order_source
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.status = 'pending_confirm' AND o.status IN (${OPEN_SQL}) ${extra}
       ORDER BY oi.created_at ASC`,
      params
    );
  }

  /** Ảnh chụp các đơn đang mở — dùng để dựng lại hình chiếu trạng thái bàn. */
  async snapshotOpenOrders() {
    return db.query(
      `SELECT o.table_id, o.table_code, o.id AS order_id, o.code AS order_code,
              o.total_amount AS amount, o.check_in_time AS occupied_since,
              CASE WHEN o.status = 'serving' THEN 'serving' ELSE 'ordering' END AS state
       FROM orders o
       WHERE o.status IN (${OPEN_SQL}) AND o.table_id IS NOT NULL`
    );
  }

  async countOpen() {
    const row = await db.queryOne(`SELECT COUNT(*)::int AS count FROM orders WHERE status IN (${OPEN_SQL})`);
    return row?.count ?? 0;
  }

  // ── Ghi ──────────────────────────────────────────────────────────────────
  async insertOrder({ table_id, table_code, waiter_id, waiter_name, source, notes }, client) {
    const r = db.runner(client);
    return r.queryOne(
      `INSERT INTO orders (table_id, table_code, waiter_id, waiter_name, source, notes, total_amount)
       VALUES ($1,$2,$3,$4,$5,$6,0) RETURNING *`,
      [table_id, table_code, waiter_id || null, waiter_name, source || 'staff', notes || null]
    );
  }

  async insertItems(orderId, lines, client) {
    const r = db.runner(client);
    const out = [];
    for (const l of lines) {
      const row = await r.queryOne(
        `INSERT INTO order_items
           (order_id, menu_item_id, item_name, quantity, price, total_price, notes, status, source, guest_request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          orderId, l.menu_item_id || null, l.item_name, l.quantity, l.price, l.total_price,
          l.notes || null, l.status || 'confirmed', l.source || 'staff', l.guest_request_id || null,
        ]
      );
      out.push(row);
    }
    return out;
  }

  /**
   * Tính lại tổng tiền đơn TỪ CÁC DÒNG MÓN (không cộng dồn).
   * Cộng dồn (`total = total + x`) dễ lệch khi có lỗi hoặc thao tác đồng thời;
   * tính lại từ nguồn luôn cho con số đúng.
   */
  async recalculateTotal(orderId, client) {
    const r = db.runner(client);
    return r.queryOne(
      `UPDATE orders SET
         total_amount = (SELECT COALESCE(SUM(total_price),0) FROM order_items
                          WHERE order_id = $1 AND status IN (${BILLABLE_SQL})),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [orderId]
    );
  }

  async updateItem(itemId, { quantity, total_price, notes }, client) {
    const r = db.runner(client);
    return r.queryOne(
      `UPDATE order_items SET
         quantity    = COALESCE($2, quantity),
         total_price = COALESCE($3, total_price),
         notes       = COALESCE($4, notes)
       WHERE id = $1 RETURNING *`,
      [itemId, quantity ?? null, total_price ?? null, notes ?? null]
    );
  }

  async setItemStatus(itemId, status, { reviewer_id = null, reject_reason = null } = {}, client) {
    const r = db.runner(client);
    return r.queryOne(
      `UPDATE order_items SET
         status        = $2,
         reviewed_by   = COALESCE($3, reviewed_by),
         reviewed_at   = CASE WHEN $2 IN ('confirmed','rejected') THEN NOW() ELSE reviewed_at END,
         served_at     = CASE WHEN $2 = 'served' THEN NOW() ELSE served_at END,
         reject_reason = COALESCE($4, reject_reason)
       WHERE id = $1 RETURNING *`,
      [itemId, status, reviewer_id, reject_reason]
    );
  }

  async setItemsStatusByRequest(guestRequestId, status, { reviewer_id, reject_reason } = {}, client) {
    const r = db.runner(client);
    return r.query(
      `UPDATE order_items SET
         status = $2, reviewed_by = $3, reviewed_at = NOW(), reject_reason = $4
       WHERE guest_request_id = $1 AND status = 'pending_confirm'
       RETURNING *`,
      [guestRequestId, status, reviewer_id || null, reject_reason || null]
    );
  }

  async deleteItem(itemId, client) {
    const r = db.runner(client);
    return r.queryOne('DELETE FROM order_items WHERE id = $1 RETURNING *', [itemId]);
  }

  async updateStatus(orderId, status, client) {
    const r = db.runner(client);
    return r.queryOne(
      `UPDATE orders SET status = $2,
         check_out_time = CASE WHEN $2 IN ('completed','cancelled') THEN NOW() ELSE check_out_time END,
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [orderId, status]
    );
  }

  async cancel(orderId, reason, client) {
    const r = db.runner(client);
    return r.queryOne(
      `UPDATE orders SET status = 'cancelled', cancelled_reason = $2,
              check_out_time = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [orderId, reason || null]
    );
  }

  async moveToTable(orderId, { table_id, table_code }, client) {
    const r = db.runner(client);
    return r.queryOne(
      `UPDATE orders SET table_id = $2, table_code = $3, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [orderId, table_id, table_code]
    );
  }

  /**
   * Khoá tuần tự hoá theo BÀN trong phạm vi transaction.
   *
   * Phiên bản trước dùng `SELECT ... FROM tables ... FOR NO KEY UPDATE` — vừa
   * khoá được, vừa VI PHẠM RANH GIỚI MODULE (ordering viết SQL lên bảng của
   * dining). Nay dùng advisory lock của PostgreSQL: khoá theo một con số dẫn
   * xuất từ table_id, không chạm bảng nào cả.
   *
   * Khoá tự nhả khi transaction kết thúc (commit hoặc rollback), nên không có
   * nguy cơ kẹt khoá nếu xảy ra lỗi.
   */
  async lockTable(tableId, client) {
    const r = db.runner(client);
    // 'ordering:table' là không gian khoá, tránh đụng với tính năng khác
    await r.query("SELECT pg_advisory_xact_lock(hashtext('ordering:table'), hashtext($1))", [String(tableId)]);
  }
}

module.exports = new OrderRepository();
