// =============================================================================
//  MODULE identity · INFRASTRUCTURE — Truy cập bảng `users`
// -----------------------------------------------------------------------------
//  Repository là NƠI DUY NHẤT trong toàn hệ thống được viết SQL lên bảng
//  `users`. Module khác cần dữ liệu người dùng thì gọi contract của identity.
//  Công cụ `npm run check:boundaries` sẽ báo lỗi nếu quy ước này bị vi phạm.
// =============================================================================
const bcrypt = require('bcryptjs');
const db = require('../../../platform/database/pool');
const { config } = require('../../../shared/config');

const PUBLIC_COLUMNS = `id, username, full_name, role, email, phone, avatar_url,
                        is_active, last_login_at, created_at, updated_at`;

class UserRepository {
  async findByUsername(username) {
    return db.queryOne('SELECT * FROM users WHERE username = $1', [username]);
  }

  async findById(id) {
    return db.queryOne('SELECT * FROM users WHERE id = $1', [id]);
  }

  async findAll({ role, is_active } = {}) {
    const conds = [];
    const params = [];
    if (role)              { params.push(role);      conds.push(`role = $${params.length}`); }
    if (is_active !== undefined) { params.push(is_active); conds.push(`is_active = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return db.query(`SELECT ${PUBLIC_COLUMNS} FROM users ${where} ORDER BY created_at DESC`, params);
  }

  async countActiveAdmins() {
    const row = await db.queryOne(
      `SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND is_active = TRUE`
    );
    return row?.count ?? 0;
  }

  async count() {
    const row = await db.queryOne('SELECT COUNT(*)::int AS count FROM users');
    return row?.count ?? 0;
  }

  async create({ username, password, full_name, role, email, phone }) {
    const password_hash = await bcrypt.hash(password, config.auth.bcryptRounds);
    return db.queryOne(
      `INSERT INTO users (username, password_hash, full_name, role, email, phone)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING ${PUBLIC_COLUMNS}`,
      [username, password_hash, full_name, role, email || null, phone || null]
    );
  }

  async update(id, { full_name, role, email, phone, is_active }) {
    return db.queryOne(
      `UPDATE users SET
         full_name  = COALESCE($1, full_name),
         role       = COALESCE($2, role),
         email      = COALESCE($3, email),
         phone      = COALESCE($4, phone),
         is_active  = COALESCE($5, is_active),
         updated_at = NOW()
       WHERE id = $6
       RETURNING ${PUBLIC_COLUMNS}`,
      [full_name ?? null, role ?? null, email ?? null, phone ?? null, is_active ?? null, id]
    );
  }

  async setPassword(id, plainPassword) {
    const password_hash = await bcrypt.hash(plainPassword, config.auth.bcryptRounds);
    return db.queryOne(
      `UPDATE users SET password_hash = $1, updated_at = NOW()
       WHERE id = $2 RETURNING id, username, full_name, role`,
      [password_hash, id]
    );
  }

  async touchLastLogin(id) {
    return db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [id]);
  }

  async remove(id) {
    return db.queryOne('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
  }

  async verifyPassword(user, plain) {
    if (!user?.password_hash) return false;
    return bcrypt.compare(plain, user.password_hash);
  }

  /** Seed tài khoản mặc định — chỉ chạy khi bảng còn rỗng. */
  async seedDefaults(password) {
    const hash = await bcrypt.hash(password, config.auth.bcryptRounds);
    const rows = [
      ['admin',   'Nguyễn Văn Dũng', 'admin'],
      ['cashier', 'Trần Thị Lan',    'cashier'],
      ['waiter',  'Hoàng Nam',       'waiter'],
    ];
    for (const [username, full_name, role] of rows) {
      await db.query(
        `INSERT INTO users (username, password_hash, full_name, role)
         VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO NOTHING`,
        [username, hash, full_name, role]
      );
    }
    return rows.length;
  }
}

module.exports = new UserRepository();
