// =============================================================================
//  SHARED KERNEL — Logger có ngữ cảnh module
// -----------------------------------------------------------------------------
//  Mỗi module tạo logger riêng: logger.child('ordering') → log có tiền tố
//  [ordering], giúp đọc log của một module trong monolith dễ như đọc log của
//  một service riêng. Ở production xuất JSON một dòng để hệ thống thu thập log
//  (Loki/CloudWatch/…) phân tích được.
// =============================================================================
const { config } = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || (config.isProd ? 'info' : 'debug')).toLowerCase()] || 20;

function emit(level, scope, msg, meta) {
  if (LEVELS[level] < threshold) return;
  const stream = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (config.isProd) {
    stream(JSON.stringify({ ts: new Date().toISOString(), level, scope, msg, ...(meta || {}) }));
  } else {
    const tag = scope ? `[${scope}]` : '';
    stream(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${tag} ${msg}`,
      meta !== undefined ? meta : '');
  }
}

function make(scope) {
  return {
    scope,
    debug: (msg, meta) => emit('debug', scope, msg, meta),
    info:  (msg, meta) => emit('info',  scope, msg, meta),
    warn:  (msg, meta) => emit('warn',  scope, msg, meta),
    error: (msg, meta) => emit('error', scope, msg, meta),
    child: (sub) => make(scope ? `${scope}:${sub}` : sub),
  };
}

module.exports = make('app');
module.exports.child = (scope) => make(scope);
