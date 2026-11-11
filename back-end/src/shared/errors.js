// =============================================================================
//  SHARED KERNEL — Lỗi nghiệp vụ chuẩn hoá (AppError)
// -----------------------------------------------------------------------------
//  Mọi module dùng chung lớp lỗi này để tầng HTTP có thể ánh xạ sang mã trạng
//  thái và envelope thống nhất. Shared kernel KHÔNG chứa logic nghiệp vụ của
//  bất kỳ module nào — chỉ các khái niệm kỹ thuật dùng chung.
// =============================================================================

class AppError extends Error {
  /**
   * @param {string} message  Thông điệp hiển thị cho người dùng (tiếng Việt)
   * @param {object} opts     { status, code, details, cause }
   */
  constructor(message, { status = 400, code = 'BAD_REQUEST', details, cause } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    if (cause) this.cause = cause;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(msg = 'Yêu cầu không hợp lệ', details) {
    return new AppError(msg, { status: 400, code: 'BAD_REQUEST', details });
  }
  static unauthorized(msg = 'Chưa xác thực', code = 'UNAUTHORIZED') {
    return new AppError(msg, { status: 401, code });
  }
  static forbidden(msg = 'Không có quyền truy cập') {
    return new AppError(msg, { status: 403, code: 'FORBIDDEN' });
  }
  static notFound(msg = 'Không tìm thấy tài nguyên') {
    return new AppError(msg, { status: 404, code: 'NOT_FOUND' });
  }
  static conflict(msg = 'Xung đột dữ liệu', details) {
    return new AppError(msg, { status: 409, code: 'CONFLICT', details });
  }
  static validation(msg = 'Dữ liệu không hợp lệ', details) {
    return new AppError(msg, { status: 422, code: 'VALIDATION_ERROR', details });
  }
  static rateLimited(msg = 'Quá nhiều yêu cầu, vui lòng thử lại sau') {
    return new AppError(msg, { status: 429, code: 'RATE_LIMITED' });
  }
  static internal(msg = 'Lỗi server nội bộ', cause) {
    return new AppError(msg, { status: 500, code: 'INTERNAL_ERROR', cause });
  }
}

/** Lỗi vi phạm bất biến nghiệp vụ trong tầng domain (không phụ thuộc HTTP). */
class DomainError extends AppError {
  constructor(message, { code = 'DOMAIN_RULE_VIOLATION', details } = {}) {
    super(message, { status: 409, code, details });
    this.name = 'DomainError';
  }
}

module.exports = { AppError, DomainError };
