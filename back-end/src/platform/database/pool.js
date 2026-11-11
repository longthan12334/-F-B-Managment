// =============================================================================
//  PLATFORM — Kết nối PostgreSQL dùng chung
// -----------------------------------------------------------------------------
//  Trong Modular Monolith, các module dùng CHUNG một connection pool (đây chính
//  là ưu điểm lớn so với microservices: giao dịch xuyên module vẫn là ACID).
//  Ranh giới module được giữ ở tầng repository — mỗi module chỉ truy vấn đúng
//  các bảng mình sở hữu (xem tools/check-boundaries.js).
// =============================================================================
const { Pool } = require('pg');
const { config } = require('../../shared/config');
const log = require('../../shared/logger').child('db');

const pool = new Pool(
  config.database.url
    ? {
        connectionString: config.database.url,
        ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
        max: config.database.poolMax,
      }
    : {
        host: config.database.host,
        port: config.database.port,
        database: config.database.name,
        user: config.database.user,
        password: config.database.password,
        ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
        max: config.database.poolMax,
      }
);

pool.on('error', (err) => log.error('Lỗi pool PostgreSQL', { message: err.message }));

/** Chờ Postgres sẵn sàng (container khởi động chậm hơn backend). */
async function waitForDatabase(maxRetries = 30, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      log.info('Đã kết nối PostgreSQL');
      return;
    } catch (err) {
      log.warn(`PostgreSQL chưa sẵn sàng (${attempt}/${maxRetries}): ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('Không thể kết nối PostgreSQL sau nhiều lần thử');
}

async function query(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}

async function queryOne(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows[0] ?? null;
}

/**
 * Chạy một hàm trong transaction.
 * Nếu đã có `client` (đang trong transaction của caller) thì tái sử dụng —
 * cho phép một use-case gọi nhiều repository mà vẫn chung một transaction.
 */
async function transaction(fn, existingClient = null) {
  if (existingClient) return fn(existingClient);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Trình thực thi: dùng client của transaction nếu có, ngược lại dùng pool. */
const runner = (client) => ({
  query: async (sql, params = []) => (client ? (await client.query(sql, params)).rows : query(sql, params)),
  queryOne: async (sql, params = []) =>
    client ? (await client.query(sql, params)).rows[0] ?? null : queryOne(sql, params),
});

async function healthCheck() {
  const started = Date.now();
  await pool.query('SELECT 1');
  return { ok: true, latencyMs: Date.now() - started, totalConnections: pool.totalCount, idle: pool.idleCount };
}

async function closePool() {
  await pool.end();
  log.info('Đã đóng pool PostgreSQL');
}

module.exports = { pool, waitForDatabase, query, queryOne, transaction, runner, healthCheck, closePool };
