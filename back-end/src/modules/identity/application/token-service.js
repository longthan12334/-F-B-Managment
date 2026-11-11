// =============================================================================
//  MODULE identity · APPLICATION — Phát hành & xác minh JWT
// -----------------------------------------------------------------------------
//  Hai loại token với hai secret KHÁC NHAU:
//    access  (15 phút) — gửi kèm mọi request, hết hạn nhanh để giảm thiệt hại
//                        nếu bị lộ.
//    refresh (30 ngày) — chỉ gửi tới /auth/refresh, được lưu hash trong CSDL
//                        nên có thể thu hồi ngay lập tức.
//  Dùng chung một secret cho cả hai là lỗi bảo mật kinh điển: kẻ tấn công lấy
//  được access token hết hạn có thể tự ký refresh token. Vì vậy `config.js`
//  chặn khởi động ở production nếu hai secret trùng nhau.
// =============================================================================
const jwt = require('jsonwebtoken');
const { config } = require('../../../shared/config');

/** Chuyển '15m' | '30d' | 900 → số giây. */
function toSeconds(ttl) {
  if (typeof ttl === 'number') return ttl;
  const m = String(ttl).match(/^(\d+)\s*([smhd])?$/i);
  if (!m) return 900;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 's').toLowerCase();
  return { s: n, m: n * 60, h: n * 3600, d: n * 86400 }[unit] ?? n;
}

const ACCESS_TTL = toSeconds(config.auth.jwtExpires);
const REFRESH_TTL = toSeconds(config.auth.refreshExpires);

const signAccessToken = (payload) =>
  jwt.sign({ ...payload, typ: 'access' }, config.auth.jwtSecret, { expiresIn: config.auth.jwtExpires });

const signRefreshToken = (payload) =>
  jwt.sign({ ...payload, typ: 'refresh' }, config.auth.refreshSecret, { expiresIn: config.auth.refreshExpires });

/** Xác minh access token. Ném JsonWebTokenError / TokenExpiredError. */
function verifyAccessToken(token) {
  const decoded = jwt.verify(token, config.auth.jwtSecret);
  // Chặn dùng refresh token thay cho access token
  if (decoded.typ && decoded.typ !== 'access') {
    const err = new Error('WRONG_TOKEN_TYPE');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return decoded;
}

function verifyRefreshToken(token) {
  const decoded = jwt.verify(token, config.auth.refreshSecret);
  if (decoded.typ !== 'refresh') {
    const err = new Error('NOT_A_REFRESH_TOKEN');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return decoded;
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  accessTtlSeconds: () => ACCESS_TTL,
  refreshTtlSeconds: () => REFRESH_TTL,
};
