// =============================================================================
//  PLATFORM — Xử lý lỗi tập trung
// -----------------------------------------------------------------------------
//  Mọi lỗi (AppError do nghiệp vụ ném ra, lỗi JWT, lỗi multer, lỗi PostgreSQL)
//  đều được quy về một envelope duy nhất để client chỉ cần xử lý một dạng:
//      { success:false, message, error:{ code, details? } }
// =============================================================================
const { AppError } = require('../../shared/errors');
const { config } = require('../../shared/config');
const log = require('../../shared/logger').child('http');

/** Ánh xạ SQLSTATE của PostgreSQL sang lỗi nghiệp vụ dễ hiểu. */
const PG_ERRORS = {
  '23505': [409, 'Dữ liệu đã tồn tại', 'DUPLICATE'],
  '23503': [409, 'Vi phạm ràng buộc khoá ngoại', 'FK_VIOLATION'],
  '23502': [400, 'Thiếu trường bắt buộc', 'NOT_NULL_VIOLATION'],
  '23514': [400, 'Dữ liệu vi phạm ràng buộc kiểm tra', 'CHECK_VIOLATION'],
  '22P02': [400, 'Tham số không đúng định dạng', 'BAD_PARAM'],
  '42P01': [500, 'Bảng không tồn tại — cần chạy migration', 'UNDEFINED_TABLE'],
  '40001': [409, 'Xung đột giao dịch, vui lòng thử lại', 'SERIALIZATION_FAILURE'],
  '40P01': [409, 'Phát hiện deadlock, vui lòng thử lại', 'DEADLOCK'],
  '57014': [504, 'Truy vấn quá thời gian cho phép', 'STATEMENT_TIMEOUT'],
};

const MULTER_ERRORS = {
  LIMIT_FILE_SIZE: [413, 'Tệp vượt quá dung lượng cho phép', 'FILE_TOO_LARGE'],
  LIMIT_UNEXPECTED_FILE: [400, 'Trường tải tệp không hợp lệ', 'UNEXPECTED_FIELD'],
  LIMIT_FILE_COUNT: [400, 'Vượt quá số lượng tệp cho phép', 'TOO_MANY_FILES'],
};

function send(res, status, message, code, details, requestId) {
  const body = { success: false, message: message || 'Lỗi không xác định', error: { code } };
  if (details !== undefined) body.error.details = details;
  if (requestId) body.error.request_id = requestId;
  return res.status(status).json(body);
}

const notFoundHandler = (req, res) =>
  send(res, 404, `Không tìm thấy đường dẫn: ${req.method} ${req.originalUrl}`, 'ROUTE_NOT_FOUND', undefined, req.id);

// eslint-disable-next-line no-unused-vars
function globalErrorHandler(err, req, res, _next) {
  const requestId = req.id;

  if (err instanceof AppError) {
    if (err.status >= 500) log.error(err.message, { code: err.code, requestId, stack: err.stack });
    return send(res, err.status, err.message, err.code, err.details, requestId);
  }

  if (err?.name === 'JsonWebTokenError')  return send(res, 401, 'Token không hợp lệ', 'INVALID_TOKEN', undefined, requestId);
  if (err?.name === 'TokenExpiredError')  return send(res, 401, 'Token đã hết hạn', 'TOKEN_EXPIRED', undefined, requestId);

  if (err?.name === 'MulterError') {
    const [status, msg, code] = MULTER_ERRORS[err.code] || [400, 'Lỗi tải tệp', 'UPLOAD_ERROR'];
    return send(res, status, msg, code, err.field, requestId);
  }

  if (err?.type === 'entity.parse.failed') return send(res, 400, 'JSON không hợp lệ', 'BAD_JSON', undefined, requestId);
  if (err?.type === 'entity.too.large')    return send(res, 413, 'Nội dung quá lớn', 'PAYLOAD_TOO_LARGE', undefined, requestId);

  if (err?.code && PG_ERRORS[err.code]) {
    const [status, msg, code] = PG_ERRORS[err.code];
    log.warn(`PostgreSQL ${err.code}: ${err.message}`, { requestId });
    return send(res, status, msg, code, config.isProd ? undefined : err.detail, requestId);
  }

  if (/^CORS:/.test(err?.message || '')) {
    return send(res, 403, 'Nguồn gọi API không được phép (CORS)', 'CORS_FORBIDDEN', undefined, requestId);
  }

  log.error('Lỗi chưa được xử lý', { message: err?.message, stack: err?.stack, requestId });
  return send(
    res, 500,
    config.isProd ? 'Lỗi server nội bộ' : err?.message || 'Lỗi server',
    'INTERNAL_ERROR', undefined, requestId
  );
}

module.exports = { notFoundHandler, globalErrorHandler };
