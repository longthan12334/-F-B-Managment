// =============================================================================
//  SHARED KERNEL — Kiểm tra dữ liệu đầu vào (không phụ thuộc thư viện ngoài)
// -----------------------------------------------------------------------------
//  Dùng ở hai nơi:
//    • Tầng interface/http: middleware validateBody/Query/Params chặn dữ liệu
//      sai ngay tại biên module.
//    • Tầng application: hàm `check()` dùng lại cùng bộ quy tắc khi service
//      được gọi từ module khác (không qua HTTP).
// =============================================================================
const { AppError } = require('./errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v.trim());

function checkField(field, v, rules) {
  const errs = [];
  const present = v !== undefined && v !== null && v !== '';

  if (rules.required && !present) return [`${field}: bắt buộc`];
  if (!present) return errs;

  switch (rules.type) {
    case 'number':
      if (!Number.isFinite(Number(v))) errs.push(`${field}: phải là số`);
      break;
    case 'integer':
      if (!Number.isInteger(Number(v))) errs.push(`${field}: phải là số nguyên`);
      break;
    case 'boolean':
      if (typeof v !== 'boolean' && v !== 'true' && v !== 'false') errs.push(`${field}: phải là boolean`);
      break;
    case 'array':
      if (!Array.isArray(v)) errs.push(`${field}: phải là mảng`);
      break;
    case 'string':
      if (typeof v !== 'string') errs.push(`${field}: phải là chuỗi`);
      break;
    case 'uuid':
      if (!isUuid(v)) errs.push(`${field}: phải là UUID hợp lệ`);
      break;
    case 'iso-date':
      if (Number.isNaN(Date.parse(v))) errs.push(`${field}: phải là ngày giờ ISO-8601`);
      break;
    default:
      break;
  }

  if (rules.enum && !rules.enum.includes(v)) errs.push(`${field}: phải thuộc {${rules.enum.join('|')}}`);
  if (rules.min !== undefined && Number(v) < rules.min) errs.push(`${field}: tối thiểu ${rules.min}`);
  if (rules.max !== undefined && Number(v) > rules.max) errs.push(`${field}: tối đa ${rules.max}`);
  if (rules.minLength !== undefined && String(v).length < rules.minLength)
    errs.push(`${field}: tối thiểu ${rules.minLength} ký tự`);
  if (rules.maxLength !== undefined && String(v).length > rules.maxLength)
    errs.push(`${field}: tối đa ${rules.maxLength} ký tự`);
  if (rules.pattern && !rules.pattern.test(String(v))) errs.push(`${field}: sai định dạng`);

  return errs;
}

/** Kiểm tra object theo schema. Trả về mảng lỗi (rỗng = hợp lệ). */
function collect(data, schema) {
  const errors = [];
  for (const [field, rules] of Object.entries(schema)) {
    errors.push(...checkField(field, (data || {})[field], rules));
  }
  return errors;
}

/** Như `collect` nhưng ném AppError 422 khi có lỗi — dùng trong application layer. */
function check(data, schema, message = 'Dữ liệu không hợp lệ') {
  const errors = collect(data, schema);
  if (errors.length) throw AppError.validation(message, errors);
  return data;
}

function buildMiddleware(source, schema) {
  return (req, _res, next) => {
    const errors = collect(req[source], schema);
    if (errors.length) return next(AppError.validation('Dữ liệu không hợp lệ', errors));
    return next();
  };
}

const validateBody   = (schema) => buildMiddleware('body', schema);
const validateQuery  = (schema) => buildMiddleware('query', schema);
const validateParams = (schema) => buildMiddleware('params', schema);

module.exports = {
  isUuid, UUID_RE, collect, check,
  validateBody, validateQuery, validateParams,
};
