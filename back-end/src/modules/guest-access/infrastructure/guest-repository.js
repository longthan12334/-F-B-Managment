// =============================================================================
//  MODULE guest-access · INFRASTRUCTURE — guest_sessions & guest_order_requests
// =============================================================================
const db = require('../../../platform/database/pool');

class GuestRepository {
  // ── Phiên khách ──────────────────────────────────────────────────────────
  async createSession({ table_id, table_code, token_hash, display_name, phone, user_agent, ip, expires_at }, client) {
    const r = db.runner(client);
    return r.queryOne(
      `INSERT INTO guest_sessions
         (table_id, table_code, token_hash, display_name, phone, user_agent, ip, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [table_id, table_code, token_hash, display_name || null, phone || null,
       user_agent || null, ip || null, expires_at]
    );
  }

  async findSessionById(id, client = null) {
    const r = db.runner(client);
    return r.queryOne('SELECT * FROM guest_sessions WHERE id = $1', [id]);
  }

  async findSessionByTokenHash(token_hash) {
    return db.queryOne('SELECT * FROM guest_sessions WHERE token_hash = $1', [token_hash]);
  }

  async touchSession(id) {
    return db.queryOne(
      'UPDATE guest_sessions SET last_seen_at = NOW() WHERE id = $1 RETURNING *', [id]
    );
  }

  async updateSessionProfile(id, { display_name, phone }) {
    return db.queryOne(
      `UPDATE guest_sessions SET
         display_name = COALESCE($2, display_name),
         phone        = COALESCE($3, phone),
         last_seen_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, display_name ?? null, phone ?? null]
    );
  }

  async closeSession(id, { status = 'closed', reason = null } = {}) {
    return db.queryOne(
      `UPDATE guest_sessions
       SET status = $2, closed_at = NOW(), close_reason = $3
       WHERE id = $1 AND status = 'active' RETURNING *`,
      [id, status, reason]
    );
  }

  /** Đóng mọi phiên đang mở của một bàn (khi thanh toán xong hoặc dọn bàn). */
  async closeSessionsForTable(table_id, reason) {
    return db.query(
      `UPDATE guest_sessions
       SET status = 'closed', closed_at = NOW(), close_reason = $2
       WHERE table_id = $1 AND status = 'active' RETURNING id, table_code`,
      [table_id, reason || null]
    );
  }

  async listSessionsForTable(table_id, { activeOnly = true } = {}) {
    const extra = activeOnly ? "AND status = 'active' AND expires_at > NOW()" : '';
    return db.query(
      `SELECT * FROM guest_sessions WHERE table_id = $1 ${extra} ORDER BY started_at DESC`,
      [table_id]
    );
  }

  /** Đếm yêu cầu gửi gần đây của một phiên — dùng để chống spam. */
  async countRecentRequests(sessionId, minutes = 10) {
    const row = await db.queryOne(
      `SELECT COUNT(*)::int AS count FROM guest_order_requests
       WHERE guest_session_id = $1 AND submitted_at > NOW() - ($2 || ' minutes')::interval`,
      [sessionId, String(minutes)]
    );
    return row?.count ?? 0;
  }

  async blockSession(id, reason) {
    return db.queryOne(
      `UPDATE guest_sessions SET status = 'blocked', close_reason = $2, closed_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, reason]
    );
  }

  /** Đánh dấu hết hạn các phiên quá giờ (tác vụ nền). */
  async expireStaleSessions() {
    const rows = await db.query(
      `UPDATE guest_sessions SET status = 'expired', closed_at = NOW(), close_reason = 'TTL'
       WHERE status = 'active' AND expires_at < NOW() RETURNING id`
    );
    return rows.length;
  }

  /**
   * Xoá dấu vết kỹ thuật của phiên đã kết thúc quá 30 ngày.
   * Giữ lại bản ghi (để đối chiếu doanh thu) nhưng bỏ ip / user_agent / số
   * điện thoại — tối thiểu hoá dữ liệu cá nhân theo thời gian.
   */
  async anonymizeOldSessions(days = 30) {
    const rows = await db.query(
      `UPDATE guest_sessions
       SET ip = NULL, user_agent = NULL, phone = NULL
       WHERE status <> 'active'
         AND closed_at < NOW() - ($1 || ' days')::interval
         AND (ip IS NOT NULL OR user_agent IS NOT NULL OR phone IS NOT NULL)
       RETURNING id`,
      [String(days)]
    );
    return rows.length;
  }

  async countActiveSessions() {
    const row = await db.queryOne(
      "SELECT COUNT(*)::int AS count FROM guest_sessions WHERE status = 'active' AND expires_at > NOW()"
    );
    return row?.count ?? 0;
  }

  // ── Yêu cầu gọi món ──────────────────────────────────────────────────────
  async createRequest(data, client) {
    const r = db.runner(client);
    return r.queryOne(
      `INSERT INTO guest_order_requests
         (guest_session_id, table_id, table_code, items_count, amount,
          items_snapshot, guest_note, client_ip)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *`,
      [
        data.guest_session_id, data.table_id, data.table_code,
        data.items_count, data.amount, JSON.stringify(data.items_snapshot || []),
        data.guest_note || null, data.client_ip || null,
      ]
    );
  }

  async attachOrder(requestId, { order_id, order_code, created_new_order }, client) {
    const r = db.runner(client);
    return r.queryOne(
      `UPDATE guest_order_requests
       SET order_id = $2, order_code = $3, created_new_order = $4
       WHERE id = $1 RETURNING *`,
      [requestId, order_id, order_code, Boolean(created_new_order)]
    );
  }

  async setRequestStatus(requestId, { status, confirmed_amount, reviewer_id, reviewer_name, reject_reason }) {
    return db.queryOne(
      `UPDATE guest_order_requests SET
         status           = $2,
         confirmed_amount = COALESCE($3, confirmed_amount),
         reviewed_by      = COALESCE($4, reviewed_by),
         reviewed_by_name = COALESCE($5, reviewed_by_name),
         reviewed_at      = CASE WHEN $2 <> 'pending' THEN NOW() ELSE reviewed_at END,
         reject_reason    = COALESCE($6, reject_reason)
       WHERE id = $1 RETURNING *`,
      [requestId, status, confirmed_amount ?? null, reviewer_id || null, reviewer_name || null, reject_reason || null]
    );
  }

  async findRequestById(id) {
    return db.queryOne('SELECT * FROM guest_order_requests WHERE id = $1', [id]);
  }

  async listRequestsForSession(sessionId) {
    return db.query(
      'SELECT * FROM guest_order_requests WHERE guest_session_id = $1 ORDER BY submitted_at DESC',
      [sessionId]
    );
  }

  async listPendingRequests({ table_code } = {}) {
    const params = [];
    let extra = '';
    if (table_code) { params.push(table_code); extra = `AND table_code = $${params.length}`; }
    return db.query(
      `SELECT r.*, s.display_name AS guest_name
       FROM guest_order_requests r
       LEFT JOIN guest_sessions s ON s.id = r.guest_session_id
       WHERE r.status = 'pending' ${extra}
       ORDER BY r.submitted_at ASC`,
      params
    );
  }

  async listRequestsForTable(table_id, limit = 50) {
    return db.query(
      `SELECT r.*, s.display_name AS guest_name
       FROM guest_order_requests r
       LEFT JOIN guest_sessions s ON s.id = r.guest_session_id
       WHERE r.table_id = $1 ORDER BY r.submitted_at DESC LIMIT $2`,
      [table_id, limit]
    );
  }

  /** Cập nhật chỉ số tổng hợp của phiên sau mỗi lần gửi. */
  async bumpSessionCounters(sessionId, { items, amount }, client) {
    const r = db.runner(client);
    return r.queryOne(
      `UPDATE guest_sessions SET
         request_count     = request_count + 1,
         total_items_count = total_items_count + $2,
         total_amount      = total_amount + $3,
         last_seen_at      = NOW()
       WHERE id = $1 RETURNING *`,
      [sessionId, items, amount]
    );
  }

  async countPendingRequests() {
    const row = await db.queryOne(
      "SELECT COUNT(*)::int AS count FROM guest_order_requests WHERE status = 'pending'"
    );
    return row?.count ?? 0;
  }
}

module.exports = new GuestRepository();
