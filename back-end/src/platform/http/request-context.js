// =============================================================================
//  PLATFORM — Ngữ cảnh request (request id + log truy cập)
// -----------------------------------------------------------------------------
//  Gắn cho mỗi request một mã `request_id` duy nhất. Mã này:
//    • Xuất hiện trong log của mọi module xử lý request đó.
//    • Được trả về trong header `X-Request-Id` và trong body lỗi.
//    • Trở thành `correlationId` khi module phát sự kiện → lần ngược được cả
//      chuỗi xử lý bất đồng bộ từ một thao tác của người dùng.
// =============================================================================
const crypto = require('crypto');
const log = require('../../shared/logger').child('http');
const { trustedClientIp } = require('./rate-limit');

/** Không ghi log thân request để tránh lọt mật khẩu / token. */
function requestContext(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  req.clientIp = trustedClientIp(req);
  res.setHeader('X-Request-Id', req.id);

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const line = `${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`;
    if (res.statusCode >= 500) log.error(line, { requestId: req.id, ip: req.clientIp });
    else if (res.statusCode >= 400) log.warn(line, { requestId: req.id });
    else log.info(line, { requestId: req.id });
  });

  next();
}

module.exports = { requestContext };
