// =============================================================================
//  PLATFORM — Trình chạy migration theo module
// -----------------------------------------------------------------------------
//  Điểm mấu chốt của Modular Monolith: MỖI MODULE SỞ HỮU LƯỢC ĐỒ BẢNG CỦA MÌNH.
//  File SQL nằm trong `src/modules/<module>/migrations/*.sql`, không gom chung
//  một thư mục. Nhờ vậy:
//    • Nhìn thư mục module là biết module đó sở hữu bảng nào.
//    • Khi tách module thành service riêng, mang luôn cả migration đi theo.
//
//  Thứ tự chạy: sắp theo tên file (NNN_*.sql) trên toàn hệ thống, vì một số
//  module có khoá ngoại trỏ tới bảng của module nền (identity, dining).
//  Mỗi file chạy đúng một lần, ghi lại trong bảng `schema_migrations`.
// =============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('./pool');
const log = require('../../shared/logger').child('migrator');

const MODULES_DIR = path.join(__dirname, '..', '..', 'modules');
const LEGACY_DIR = path.join(__dirname, '..', '..', '..', 'migrations');

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          BIGSERIAL PRIMARY KEY,
      module      TEXT        NOT NULL,
      filename    TEXT        NOT NULL,
      checksum    TEXT        NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms INTEGER,
      UNIQUE (module, filename)
    )
  `);
}

/** Quét tất cả migration của mọi module + thư mục legacy (nếu còn). */
function discoverMigrations() {
  const found = [];

  if (fs.existsSync(MODULES_DIR)) {
    for (const moduleName of fs.readdirSync(MODULES_DIR).sort()) {
      const dir = path.join(MODULES_DIR, moduleName, 'migrations');
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
        found.push({ module: moduleName, filename: file, fullPath: path.join(dir, file) });
      }
    }
  }

  // Tương thích ngược: dự án cũ để migration ở back-end/migrations/
  if (fs.existsSync(LEGACY_DIR)) {
    for (const file of fs.readdirSync(LEGACY_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      found.push({ module: '_legacy', filename: file, fullPath: path.join(LEGACY_DIR, file) });
    }
  }

  // Sắp theo tiền tố số để tôn trọng phụ thuộc khoá ngoại giữa các module
  return found.sort((a, b) => a.filename.localeCompare(b.filename, 'en', { numeric: true }));
}

async function runMigrations() {
  const client = await pool.connect();
  try {
    await ensureMigrationTable(client);

    const { rows } = await client.query('SELECT module, filename, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [`${r.module}/${r.filename}`, r.checksum]));

    const all = discoverMigrations();
    let ran = 0;

    for (const mig of all) {
      const key = `${mig.module}/${mig.filename}`;
      const sql = fs.readFileSync(mig.fullPath, 'utf-8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);

      if (applied.has(key)) {
        if (applied.get(key) !== checksum) {
          log.warn(`Migration đã chạy nhưng nội dung thay đổi: ${key} — bỏ qua (tạo file mới thay vì sửa file cũ).`);
        }
        continue;
      }

      const started = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (module, filename, checksum, duration_ms)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (module, filename) DO NOTHING`,
          [mig.module, mig.filename, checksum, Date.now() - started]
        );
        await client.query('COMMIT');
        log.info(`✓ ${key} (${Date.now() - started}ms)`);
        ran++;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        log.error(`✗ Migration thất bại: ${key}`, { message: err.message });
        throw err;
      }
    }

    log.info(ran === 0 ? 'Lược đồ CSDL đã cập nhật, không có migration mới.' : `Đã áp dụng ${ran} migration.`);
    return { total: all.length, applied: ran };
  } finally {
    client.release();
  }
}

module.exports = { runMigrations, discoverMigrations };
