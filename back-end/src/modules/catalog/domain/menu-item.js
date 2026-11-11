// =============================================================================
//  MODULE catalog · DOMAIN — Quy tắc nghiệp vụ của món ăn
// =============================================================================
const { AppError } = require('../../../shared/errors');
const { toAmount } = require('../../../shared/money');

const MAX_PRICE = 100_000_000; // 100 triệu/món — chặn lỗi gõ thừa số 0
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function assertValidMenuItem({ name, price }, { partial = false } = {}) {
  const errs = [];

  if (!partial || name !== undefined) {
    if (!name || String(name).trim().length < 2) errs.push('name: tối thiểu 2 ký tự');
    if (name && String(name).length > 128) errs.push('name: tối đa 128 ký tự');
  }
  if (!partial || price !== undefined) {
    const p = Number(price);
    if (!Number.isFinite(p)) errs.push('price: phải là số');
    else if (p < 0) errs.push('price: không được âm');
    else if (p > MAX_PRICE) errs.push(`price: tối đa ${MAX_PRICE.toLocaleString('vi-VN')} ₫`);
  }

  if (errs.length) throw AppError.validation('Dữ liệu món ăn không hợp lệ', errs);
}

function assertAllowedImage(file) {
  if (!file) return;
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    throw AppError.validation('Ảnh không hợp lệ', [
      `image: chỉ chấp nhận ${ALLOWED_IMAGE_TYPES.join(', ')}`,
    ]);
  }
}

/** Chuẩn hoá bản ghi trước khi trả ra API. */
function toView(item) {
  if (!item) return null;
  return {
    ...item,
    price: toAmount(item.price),
  };
}

/** Góc nhìn rút gọn cho khách quét QR: không lộ trường quản trị. */
function toGuestView(item) {
  if (!item) return null;
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    price: toAmount(item.price),
    emoji: item.emoji,
    image_url: item.image_url,
    category_id: item.category_id,
    category_code: item.category_code,
  };
}

module.exports = { assertValidMenuItem, assertAllowedImage, toView, toGuestView, ALLOWED_IMAGE_TYPES, MAX_PRICE };
