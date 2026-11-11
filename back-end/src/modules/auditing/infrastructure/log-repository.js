// =============================================================================
//  MODULE auditing · INFRASTRUCTURE — Truy cập activity_logs
// =============================================================================
const db = require('../../../platform/database/pool');

class LogRepository {
  async write(entry) {
    return db.query(
      `INSERT INTO activity_logs
         (event, module, action, entity, entity_id, user_id, user_name, details, ip, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
      [
        entry.event || null, entry.module || null, entry.action,
        entry.entity || null, entry.entity_id ? String(entry.entity_id) : null,
        entry.user_id || null, entry.user_name || null,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.ip || null, entry.request_id || null,
      ]
    );
  }

  async list({ from, to, action, module, entity, user_name, limit = 200 } = {}) {
    const conds = [];
    const params = [];
    if (from)      { params.push(from);                conds.push(`created_at >= $${params.length}`); }
    if (to)        { params.push(to);                  conds.push(`created_at <= $${params.length}`); }
    if (action)    { params.push(action);              conds.push(`action = $${params.length}`); }
    if (module)    { params.push(module);              conds.push(`module = $${params.length}`); }
    if (entity)    { params.push(entity);              conds.push(`entity = $${params.length}`); }
    if (user_name) { params.push(`%${user_name}%`);    conds.push(`user_name ILIKE $${params.length}`); }
    params.push(Math.min(Number(limit) || 200, 1000));
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return db.query(
      `SELECT * FROM activity_logs ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
  }

  /** Dòng thời gian của một thực thể (vd. toàn bộ thao tác trên một đơn). */
  async timelineFor(entity, entityId) {
    return db.query(
      'SELECT * FROM activity_logs WHERE entity = $1 AND entity_id = $2 ORDER BY created_at ASC',
      [entity, String(entityId)]
    );
  }

  async count() {
    const row = await db.queryOne('SELECT COUNT(*)::int AS count FROM activity_logs');
    return row?.count ?? 0;
  }

  /** Xoá nhật ký cũ hơn N ngày (mặc định giữ 180 ngày). */
  async purgeOlderThan(days = 180) {
    const rows = await db.query(
      `DELETE FROM activity_logs WHERE created_at < NOW() - ($1 || ' days')::interval RETURNING id`,
      [String(days)]
    );
    return rows.length;
  }
}

module.exports = new LogRepository();
