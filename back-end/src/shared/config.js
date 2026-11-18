// =============================================================================
//  SHARED KERNEL — Cấu hình tập trung (12-Factor)
// -----------------------------------------------------------------------------
//  Toàn bộ biến môi trường được đọc MỘT LẦN tại đây và kiểm tra tính hợp lệ khi
//  khởi động (fail-fast). Không module nào được đọc `process.env` trực tiếp —
//  việc này giúp:
//    • Biết chính xác hệ thống phụ thuộc những biến nào (xem `.env.example`)
//    • Chặn khởi động ở production nếu cấu hình bảo mật còn yếu
//    • Dễ viết test (truyền config giả thay vì dựng biến môi trường)
// =============================================================================
require('dotenv').config();

const bool = (v, def = false) =>
  v === undefined || v === null || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const int = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

/** Các giá trị secret mẫu bị cấm dùng ở production. */
const WEAK_SECRETS = new Set([
  'restomanager-dev-secret-change-me', 'please-change-me-in-prod',
  'please-change-me-too-in-prod', 'change-me-too-32+chars-please',
  'REPLACE_ME_WITH_RANDOM_32_PLUS_CHARS',
  'REPLACE_ME_WITH_DIFFERENT_RANDOM_32_PLUS_CHARS',
  'secret', 'changeme', 'jwt-secret', 'dev-secret',
]);

/**
 * Mẫu chuỗi cho thấy secret vẫn là giá trị ví dụ trong tài liệu/.env.example.
 * Chặn theo MẪU thay vì danh sách cố định: khi .env.example đổi câu chữ, giá trị
 * mẫu mới vẫn bị bắt (đây là lỗi C-04 trong báo cáo review).
 */
const PLACEHOLDER_PATTERN = /doi-gia-tri-nay|change-?me|replace[-_ ]?me|placeholder|example|your[-_]?secret/i;

const fatals = [];
const warnings = [];

function requireSecret(name, value, { minLength = 32 } = {}) {
  if (!value) {
    if (isProd) fatals.push(`${name} chưa được đặt — bắt buộc ở production.`);
    else warnings.push(`${name} chưa đặt — dùng giá trị dev tạm thời.`);
    return null;
  }
  if (value.length < minLength) {
    const msg = `${name} chỉ dài ${value.length} ký tự — cần tối thiểu ${minLength}.`;
    isProd ? fatals.push(msg) : warnings.push(msg);
  }
  if (WEAK_SECRETS.has(value) || PLACEHOLDER_PATTERN.test(value)) {
    const msg = `${name} đang dùng giá trị mẫu/yếu đã biết.`;
    isProd ? fatals.push(msg) : warnings.push(msg);
  }
  return value;
}

const jwtSecret = requireSecret('JWT_SECRET', process.env.JWT_SECRET);
const refreshSecret = requireSecret('REFRESH_SECRET', process.env.REFRESH_SECRET);
const guestSecret = requireSecret('GUEST_SECRET', process.env.GUEST_SECRET, { minLength: 24 });

// Ba secret phải khác nhau từng đôi: lộ một secret không được kéo theo hai cái còn lại.
[
  ['JWT_SECRET', jwtSecret, 'REFRESH_SECRET', refreshSecret],
  ['JWT_SECRET', jwtSecret, 'GUEST_SECRET', guestSecret],
  ['REFRESH_SECRET', refreshSecret, 'GUEST_SECRET', guestSecret],
].forEach(([n1, v1, n2, v2]) => {
  if (v1 && v2 && v1 === v2) {
    const msg = `${n1} và ${n2} phải khác nhau.`;
    isProd ? fatals.push(msg) : warnings.push(msg);
  }
});

// Mật khẩu của tài khoản khởi tạo: ở production không được dùng mặc định '123'
// (lỗi C-03). Chỉ kiểm tra khi thật sự bật tạo dữ liệu mẫu.
const seedEnabled = bool(process.env.SEED_ON_BOOT, !isProd);
const seedPassword = process.env.SEED_PASSWORD || '';
if (isProd && seedEnabled && (seedPassword.length < 12 || PLACEHOLDER_PATTERN.test(seedPassword))) {
  fatals.push('SEED_ON_BOOT=true ở production cần SEED_PASSWORD mạnh (tối thiểu 12 ký tự, không dùng giá trị mẫu).');
}

const allowedOrigins = list(process.env.ALLOWED_ORIGINS);
if (isProd && allowedOrigins.length === 0) {
  fatals.push('ALLOWED_ORIGINS bắt buộc ở production (ví dụ: https://pos.example.com).');
}

const config = Object.freeze({
  env: NODE_ENV,
  isProd,
  isTest: NODE_ENV === 'test',
  port: int(process.env.PORT, 3000),
  appName: 'RestoManager',
  appVersion: process.env.APP_VERSION || '3.0.0',

  http: Object.freeze({
    allowedOrigins,
    bodyLimit: process.env.BODY_LIMIT || '5mb',
    trustProxy: bool(process.env.TRUST_PROXY, true),
  }),

  database: Object.freeze({
    url: process.env.DATABASE_URL || null,
    host: process.env.DB_HOST || 'postgres',
    port: int(process.env.DB_PORT, 5432),
    name: process.env.DB_NAME || 'restaurant_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    ssl: bool(process.env.DB_SSL, false),
    poolMax: int(process.env.DB_POOL_MAX, 10),
    statementTimeoutMs: int(process.env.DB_STATEMENT_TIMEOUT_MS, 15000),
  }),

  // Lớp lưu trữ đối tượng: tương thích S3 → MinIO (self-host), AWS S3, Cloudflare R2
  storage: Object.freeze({
    driver: (process.env.STORAGE_DRIVER || 'minio').toLowerCase(), // minio | s3 | r2
    endpoint: process.env.S3_ENDPOINT || process.env.MINIO_ENDPOINT || 'minio',
    port: int(process.env.S3_PORT || process.env.MINIO_PORT, 9000),
    useSSL: bool(process.env.S3_USE_SSL ?? process.env.MINIO_USE_SSL, false),
    region: process.env.S3_REGION || 'us-east-1',
    accessKey: process.env.S3_ACCESS_KEY || process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.S3_SECRET_KEY || process.env.MINIO_SECRET_KEY || 'minioadmin',
    bucket: process.env.S3_BUCKET || process.env.MINIO_BUCKET || 'restaurant',
    publicUrl: (process.env.S3_PUBLIC_URL || process.env.MINIO_PUBLIC_URL || 'http://localhost:9000').replace(/\/+$/, ''),
    // R2/S3 riêng tư → phát hành URL ký tạm thời thay vì bucket public-read
    signedUrls: bool(process.env.S3_SIGNED_URLS, false),
    signedUrlTtlSec: int(process.env.S3_SIGNED_URL_TTL, 3600),
    forcePathStyle: bool(process.env.S3_FORCE_PATH_STYLE, true),
    // Backend có tự tạo bucket + đặt policy public-read không. Với R2/S3 nên tắt:
    // token R2 thường chỉ có quyền đọc/ghi đối tượng trong MỘT bucket, và R2 không
    // hỗ trợ bucket policy. Bucket được tạo và công khai qua dashboard Cloudflare.
    manageBucket: bool(process.env.S3_MANAGE_BUCKET, (process.env.STORAGE_DRIVER || 'minio').toLowerCase() === 'minio'),
    // URL ảnh có chứa tên bucket không:
    //   MinIO/S3 path-style : https://cdn.example.com/<bucket>/<key>
    //   R2 + custom domain  : https://img.example.com/<key>   (domain gắn thẳng vào bucket)
    publicUrlIncludesBucket: bool(process.env.S3_PUBLIC_URL_INCLUDE_BUCKET, (process.env.STORAGE_DRIVER || 'minio').toLowerCase() !== 'r2'),
    maxUploadBytes: int(process.env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024),
  }),

  auth: Object.freeze({
    jwtSecret: jwtSecret || 'restomanager-dev-secret-change-me-0123456789',
    jwtExpires: process.env.JWT_EXPIRES || '15m',
    refreshSecret: refreshSecret || 'restomanager-dev-refresh-secret-0123456789',
    refreshExpires: process.env.REFRESH_EXPIRES || '30d',
    bcryptRounds: int(process.env.BCRYPT_ROUNDS, 10),
    minPasswordLength: int(process.env.MIN_PASSWORD_LENGTH, 6),
  }),

  guest: Object.freeze({
    secret: guestSecret || 'restomanager-dev-guest-secret-0123456789',
    // Phiên khách quét QR sống bằng một bữa ăn; hết hạn thì phải quét lại.
    sessionTtlHours: int(process.env.GUEST_SESSION_TTL_HOURS, 6),
    maxLinesPerRequest: int(process.env.GUEST_MAX_LINES, 30),
    maxQtyPerLine: int(process.env.GUEST_MAX_QTY, 50),
    // true  → món khách gọi phải được nhân viên duyệt mới vào đơn chính thức
    // false → tự động duyệt (chế độ "tin khách", dùng cho quán tự phục vụ)
    requireStaffConfirmation: bool(process.env.GUEST_REQUIRE_CONFIRMATION, true),
  }),

  rateLimit: Object.freeze({
    authMax: int(process.env.RL_AUTH_MAX, 10),
    authWindowMs: int(process.env.RL_AUTH_WINDOW_MS, 15 * 60 * 1000),
    apiMax: int(process.env.RL_API_MAX, 200),
    apiWindowMs: int(process.env.RL_API_WINDOW_MS, 60 * 1000),
    publicMax: int(process.env.RL_PUBLIC_MAX, 30),
    publicWindowMs: int(process.env.RL_PUBLIC_WINDOW_MS, 60 * 1000),
  }),

  business: Object.freeze({
    defaultVatRate: Number(process.env.DEFAULT_VAT_RATE || 8),
    timezone: process.env.TZ_NAME || 'Asia/Ho_Chi_Minh',
    currency: 'VND',
  }),

  seed: Object.freeze({
    enabled: seedEnabled,
    defaultPassword: seedPassword || '123',
    passwordFromEnv: Boolean(seedPassword),
  }),
});

/** Gọi ở server.js trước khi khởi động — dừng ngay nếu cấu hình không an toàn. */
function assertConfigValid(logger = console) {
  warnings.forEach((w) => logger.warn(`[config][WARN] ${w}`));
  if (fatals.length) {
    fatals.forEach((f) => logger.error(`[config][FATAL] ${f}`));
    throw new Error(`Cấu hình không hợp lệ (${fatals.length} lỗi). Xem log phía trên.`);
  }
}

module.exports = { config, assertConfigValid };
