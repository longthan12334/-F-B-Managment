// =============================================================================
//  MODULE dining · INFRASTRUCTURE — Truy cập dining_zones / tables
// -----------------------------------------------------------------------------
//  Lưu ý ranh giới: trạng thái "bàn đang có khách" phụ thuộc vào đơn hàng —
//  vốn thuộc module `ordering`. dining KHÔNG truy vấn bảng `orders`; thay vào
//  đó `table-service` hỏi ordering qua contract rồi ghép lại. Nhờ vậy ordering
//  có thể đổi cấu trúc bảng mà dining không bị ảnh hưởng.
// =============================================================================
const db = require('../../../platform/database/pool');
const crypto = require('crypto');

const newSlug = () => crypto.randomBytes(6).toString('hex');

class TableRepository {
  // ── Khu vực ──────────────────────────────────────────────────────────────
  async listZones({ activeOnly = false } = {}) {
    const where = activeOnly ? 'WHERE is_active = TRUE' : '';
    return db.query(`SELECT * FROM dining_zones ${where} ORDER BY sort_order, name`);
  }

  async zoneExists(code) {
    const row = await db.queryOne('SELECT 1 AS x FROM dining_zones WHERE code = $1 AND is_active = TRUE', [code]);
    return Boolean(row);
  }

  async createZone({ code, name, sort_order = 50 }) {
    return db.queryOne(
      `INSERT INTO dining_zones (code, name, sort_order) VALUES ($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [code, name, sort_order]
    );
  }

  // ── Bàn ──────────────────────────────────────────────────────────────────
  async findAll({ zone } = {}) {
    const params = [];
    let where = '';
    if (zone && zone !== 'all') { params.push(zone); where = `WHERE t.zone = $${params.length}`; }
    return db.query(
      `SELECT t.*, z.name AS zone_name
       FROM tables t LEFT JOIN dining_zones z ON z.code = t.zone
       ${where} ORDER BY t.zone, t.code`,
      params
    );
  }

  async findById(id) {
    return db.queryOne(
      `SELECT t.*, z.name AS zone_name
       FROM tables t LEFT JOIN dining_zones z ON z.code = t.zone WHERE t.id = $1`, [id]
    );
  }

  async findByCode(code) {
    return db.queryOne(
      `SELECT t.*, z.name AS zone_name
       FROM tables t LEFT JOIN dining_zones z ON z.code = t.zone
       WHERE UPPER(t.code) = UPPER($1)`, [code]
    );
  }

  /** Tra bàn từ tham số trên URL mã QR: ưu tiên qr_slug, dự phòng mã bàn. */
  async findByQrKey(key) {
    const bySlug = await db.queryOne(
      `SELECT t.*, z.name AS zone_name
       FROM tables t LEFT JOIN dining_zones z ON z.code = t.zone
       WHERE t.qr_slug = $1`, [String(key).toLowerCase()]
    );
    return bySlug || this.findByCode(key);
  }

  async create({ code, zone, capacity, note }) {
    return db.queryOne(
      `INSERT INTO tables (code, zone, capacity, note, qr_slug)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [code, zone, capacity, note || null, newSlug()]
    );
  }

  async update(id, patch) {
    return db.queryOne(
      `UPDATE tables SET
         code       = COALESCE($1, code),
         zone       = COALESCE($2, zone),
         capacity   = COALESCE($3, capacity),
         note       = COALESCE($4, note),
         is_active  = COALESCE($5, is_active),
         updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [patch.code ?? null, patch.zone ?? null, patch.capacity ?? null,
       patch.note ?? null, patch.is_active ?? null, id]
    );
  }

  /** Cấp lại mã QR mới — dùng khi mã cũ bị dán nhầm bàn hoặc bị phát tán. */
  async rotateQrSlug(id) {
    return db.queryOne(
      'UPDATE tables SET qr_slug = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [newSlug(), id]
    );
  }

  async remove(id) {
    return db.queryOne('DELETE FROM tables WHERE id = $1 RETURNING id, code', [id]);
  }

  async count() {
    const row = await db.queryOne('SELECT COUNT(*)::int AS count FROM tables');
    return row?.count ?? 0;
  }
}

module.exports = new TableRepository();
