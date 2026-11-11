// =============================================================================
//  MODULE identity · INFRASTRUCTURE — Truy cập bảng `refresh_tokens`
// =============================================================================
const crypto = require('crypto');
const db = require('../../../platform/database/pool');

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

class RefreshTokenRepository {
  async store({ user_id, token, expires_at, user_agent, ip }) {
    return db.queryOne(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, user_id, expires_at, created_at`,
      [user_id, hash(token), expires_at, user_agent || null, ip || null]
    );
  }

  /** Token còn hiệu lực: chưa thu hồi và chưa hết hạn. */
  async findActive(token) {
    return db.queryOne(
      `SELECT * FROM refresh_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
      [hash(token)]
    );
  }

  /** Thu hồi một token; `replacedBy` dùng khi xoay vòng để lần vết chuỗi phiên. */
  async revoke(token, replacedBy = null) {
    return db.queryOne(
      `UPDATE refresh_tokens
       SET revoked_at = NOW(), replaced_by = $2
       WHERE token_hash = $1 AND revoked_at IS NULL
       RETURNING id`,
      [hash(token), replacedBy ? hash(replacedBy) : null]
    );
  }

  async revokeAllForUser(user_id) {
    return db.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [user_id]
    );
  }

  async listActiveSessions(user_id) {
    return db.query(
      `SELECT id, user_agent, ip, created_at, expires_at
       FROM refresh_tokens
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [user_id]
    );
  }

  /** Dọn token hết hạn — gọi định kỳ bởi tác vụ nền. */
  async cleanupExpired() {
    const rows = await db.query(
      `DELETE FROM refresh_tokens
       WHERE expires_at < NOW() - INTERVAL '7 days'
       RETURNING id`
    );
    return rows.length;
  }
}

module.exports = new RefreshTokenRepository();
module.exports.hashToken = hash;
