// =============================================================================
//  MODULE dining · INFRASTRUCTURE — Hình chiếu trạng thái bàn
// =============================================================================
const db = require('../../../platform/database/pool');

class TableStateRepository {
  async listWithTables({ zone } = {}) {
    const params = [];
    let where = '';
    if (zone && zone !== 'all') { params.push(zone); where = `WHERE t.zone = $${params.length}`; }
    return db.query(
      `SELECT t.id, t.code, t.zone, z.name AS zone_name, t.capacity, t.qr_slug, t.note, t.is_active,
              COALESCE(s.state, CASE WHEN t.is_active THEN 'empty' ELSE 'inactive' END) AS state,
              s.current_order_id, s.current_order_code,
              COALESCE(s.current_amount, 0)          AS current_amount,
              COALESCE(s.pending_guest_requests, 0)  AS pending_guest_requests,
              s.occupied_since
       FROM tables t
       LEFT JOIN dining_zones z        ON z.code = t.zone
       LEFT JOIN dining_table_state s  ON s.table_id = t.id
       ${where}
       ORDER BY t.zone, t.code`,
      params
    );
  }

  async get(tableId) {
    return db.queryOne('SELECT * FROM dining_table_state WHERE table_id = $1', [tableId]);
  }

  /** Ghi đè trạng thái một bàn (upsert). */
  async set(tableId, { table_code, state, order_id = null, order_code = null, amount = 0, occupied_since = null }) {
    return db.queryOne(
      `INSERT INTO dining_table_state
         (table_id, table_code, state, current_order_id, current_order_code, current_amount, occupied_since, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (table_id) DO UPDATE SET
         table_code         = EXCLUDED.table_code,
         state              = EXCLUDED.state,
         current_order_id   = EXCLUDED.current_order_id,
         current_order_code = EXCLUDED.current_order_code,
         current_amount     = EXCLUDED.current_amount,
         occupied_since     = COALESCE(EXCLUDED.occupied_since, dining_table_state.occupied_since),
         updated_at         = NOW()
       RETURNING *`,
      [tableId, table_code, state, order_id, order_code, amount, occupied_since]
    );
  }

  /** Giải phóng bàn (thanh toán xong / huỷ đơn / dọn bàn). */
  async release(tableId, { inactive = false } = {}) {
    return db.queryOne(
      `UPDATE dining_table_state
       SET state = $2, current_order_id = NULL, current_order_code = NULL,
           current_amount = 0, pending_guest_requests = 0, occupied_since = NULL, updated_at = NOW()
       WHERE table_id = $1 RETURNING *`,
      [tableId, inactive ? 'inactive' : 'empty']
    );
  }

  async setPendingGuestRequests(tableId, delta) {
    return db.queryOne(
      `UPDATE dining_table_state
       SET pending_guest_requests = GREATEST(0, pending_guest_requests + $2), updated_at = NOW()
       WHERE table_id = $1 RETURNING *`,
      [tableId, delta]
    );
  }

  async setInactive(tableId, inactive) {
    return db.queryOne(
      `UPDATE dining_table_state
       SET state = CASE WHEN $2 THEN 'inactive'
                        WHEN state = 'inactive' THEN 'empty'
                        ELSE state END,
           updated_at = NOW()
       WHERE table_id = $1 RETURNING *`,
      [tableId, inactive]
    );
  }

  async ensureRow(tableId, tableCode, isActive = true) {
    return db.queryOne(
      `INSERT INTO dining_table_state (table_id, table_code, state)
       VALUES ($1, $2, $3)
       ON CONFLICT (table_id) DO UPDATE SET table_code = EXCLUDED.table_code
       RETURNING *`,
      [tableId, tableCode, isActive ? 'empty' : 'inactive']
    );
  }

  async removeRow(tableId) {
    return db.query('DELETE FROM dining_table_state WHERE table_id = $1', [tableId]);
  }

  /**
   * Dựng lại toàn bộ hình chiếu từ ảnh chụp đơn đang mở.
   * Gọi lúc khởi động để tự chữa lành nếu có sự kiện bị mất (ví dụ server
   * tắt đột ngột giữa lúc xử lý). Đây là ưu điểm của read model: luôn có thể
   * tái tạo từ nguồn sự thật.
   */
  async rebuild(openOrders = []) {
    await db.query(
      `UPDATE dining_table_state
       SET state = CASE WHEN state = 'inactive' THEN 'inactive' ELSE 'empty' END,
           current_order_id = NULL, current_order_code = NULL,
           current_amount = 0, occupied_since = NULL, updated_at = NOW()`
    );
    for (const o of openOrders) {
      await this.set(o.table_id, {
        table_code: o.table_code,
        state: o.state,
        order_id: o.order_id,
        order_code: o.order_code,
        amount: o.amount,
        occupied_since: o.occupied_since,
      });
    }
    return openOrders.length;
  }
}

module.exports = new TableStateRepository();
