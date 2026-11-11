// =============================================================================
//  SHARED KERNEL — Envelope phản hồi HTTP + asyncHandler
// -----------------------------------------------------------------------------
//  Envelope chuẩn toàn hệ thống:
//    Thành công : { success: true,  data, message, meta? }
//    Thất bại   : { success: false, message, error: { code, details? } }
// =============================================================================

/** 200 OK (hoặc status tuỳ chọn). */
function ok(res, data = null, { status = 200, message = '', meta } = {}) {
  const body = { success: true, data: data === undefined ? null : data, message: message || '' };
  if (meta) body.meta = meta;
  return res.status(status).json(body);
}

/** 201 Created. */
const created = (res, data, message = 'Tạo thành công') =>
  ok(res, data, { status: 201, message });

/** 204 No Content. */
const noContent = (res) => res.status(204).end();

/** Trả danh sách kèm metadata phân trang. */
function paged(res, { items, total, page, limit, message = '' }) {
  const t = Number(total) || 0;
  const p = Math.max(1, parseInt(page) || 1);
  const l = Math.max(1, parseInt(limit) || 50);
  return ok(res, items, {
    message,
    meta: { total: t, page: p, limit: l, pages: Math.max(1, Math.ceil(t / l)) },
  });
}

/** Phân trang trên mảng có sẵn (dataset nhỏ, đã nằm trong bộ nhớ). */
function paginateArray(arr, { page = 1, limit = 50, max = 200 } = {}) {
  const all = Array.isArray(arr) ? arr : [];
  const p = Math.max(1, parseInt(page) || 1);
  const l = Math.max(1, Math.min(max, parseInt(limit) || 50));
  const start = (p - 1) * l;
  return { items: all.slice(start, start + l), total: all.length, page: p, limit: l };
}

/** Bọc handler async → tự forward lỗi sang global error handler. */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { ok, created, noContent, paged, paginateArray, asyncHandler };
