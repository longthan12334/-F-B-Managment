// =============================================================================
//  MODULE catalog · APPLICATION — Use-case quản lý thực đơn
// -----------------------------------------------------------------------------
//  Service nhận `storage` (cổng lưu trữ) qua tham số thay vì require cứng, nên
//  test có thể truyền một storage giả mà không cần MinIO chạy thật.
// =============================================================================
const repo = require('../infrastructure/menu-repository');
const storage = require('../../../platform/storage');
const { assertValidMenuItem, assertAllowedImage, toView, toGuestView } = require('../domain/menu-item');
const { AppError } = require('../../../shared/errors');
const { toAmount } = require('../../../shared/money');
const EVENTS = require('../../../platform/events/event-names');
const bus = require('../../../platform/events/event-bus');
const log = require('../../../shared/logger').child('catalog');

async function listCategories() {
  return repo.listCategories();
}

async function listItems(filters = {}) {
  const rows = await repo.findItems(filters);
  return rows.map(toView);
}

async function getItem(id) {
  const item = await repo.findItemById(id);
  if (!item) throw AppError.notFound('Món ăn không tồn tại');
  return toView(item);
}

/** Thực đơn dành cho khách quét QR: chỉ món đang bán, chỉ trường cần hiển thị. */
async function guestMenu() {
  const [categories, items] = await Promise.all([
    repo.listCategories(),
    repo.findItems({ is_active: true }),
  ]);
  const usedCategoryIds = new Set(items.map((i) => i.category_id).filter(Boolean));
  return {
    categories: categories
      .filter((c) => usedCategoryIds.has(c.id))
      .map((c) => ({ id: c.id, code: c.code, name: c.name })),
    items: items.map(toGuestView),
  };
}

async function createItem(input, file, actor) {
  assertValidMenuItem(input);
  assertAllowedImage(file);

  if (await repo.findItemByName(input.name)) {
    throw AppError.conflict(`Món "${input.name}" đã có trong thực đơn`);
  }

  let image_url = null;
  let image_key = null;
  if (file) {
    const uploaded = await storage.upload(file.buffer, {
      originalName: file.originalname, contentType: file.mimetype, prefix: 'menu',
    });
    image_url = uploaded.url;
    image_key = uploaded.key;
  }

  const item = await repo.createItem({
    name: String(input.name).trim(),
    description: input.description,
    price: toAmount(input.price),
    category_id: input.category_id || null,
    emoji: input.emoji,
    image_url, image_key,
  });

  bus.publish(EVENTS.MENU_ITEM_CREATED, {
    actor_id: actor?.id, actor_name: actor?.full_name,
    item_id: item.id, name: item.name, price: toAmount(item.price),
  }, { actor: actor?.full_name });

  return toView(item);
}

async function updateItem(id, patch, file, actor) {
  const existing = await repo.findItemById(id);
  if (!existing) throw AppError.notFound('Món ăn không tồn tại');

  assertValidMenuItem(patch, { partial: true });
  assertAllowedImage(file);

  const next = { ...patch };
  if (next.price !== undefined) next.price = toAmount(next.price);
  if (next.is_active !== undefined) next.is_active = next.is_active === true || next.is_active === 'true';

  if (file) {
    const uploaded = await storage.upload(file.buffer, {
      originalName: file.originalname, contentType: file.mimetype, prefix: 'menu',
    });
    next.image_url = uploaded.url;
    next.image_key = uploaded.key;
    // Xoá ảnh cũ sau khi ảnh mới đã lên thành công (không chặn phản hồi)
    if (existing.image_key) {
      storage.remove(existing.image_key).catch((e) => log.warn(`Không xoá được ảnh cũ: ${e.message}`));
    }
  }

  const updated = await repo.updateItem(id, next);

  bus.publish(EVENTS.MENU_ITEM_UPDATED, {
    actor_id: actor?.id, actor_name: actor?.full_name, item_id: id, changes: Object.keys(next),
  }, { actor: actor?.full_name });

  return toView(updated);
}

async function removeItem(id, actor) {
  const removed = await repo.removeItem(id);
  if (!removed) throw AppError.notFound('Món ăn không tồn tại');
  if (removed.image_key) {
    storage.remove(removed.image_key).catch((e) => log.warn(`Không xoá được ảnh: ${e.message}`));
  }

  bus.publish(EVENTS.MENU_ITEM_DELETED, {
    actor_id: actor?.id, actor_name: actor?.full_name, item_id: id,
  }, { actor: actor?.full_name });

  return removed;
}

/**
 * Định giá một giỏ hàng theo GIÁ TRONG CSDL.
 * Hàm then chốt về bảo mật: client (kể cả trang khách quét QR) chỉ gửi
 * menu_item_id + số lượng; giá và tên món luôn do catalog quyết định, nên
 * không thể sửa giá bằng cách can thiệp request.
 *
 * @param {Array<{menu_item_id:string, quantity:number, notes?:string}>} lines
 * @returns {Promise<{lines:Array, unavailable:Array<string>, total:number}>}
 */
async function priceBasket(lines) {
  const ids = [...new Set(lines.map((l) => String(l.menu_item_id).toLowerCase()))];
  const found = await repo.findActiveByIds(ids);
  const byId = new Map(found.map((m) => [m.id, m]));

  const unavailable = ids.filter((id) => !byId.has(id));
  const priced = lines
    .filter((l) => byId.has(String(l.menu_item_id).toLowerCase()))
    .map((l) => {
      const m = byId.get(String(l.menu_item_id).toLowerCase());
      const quantity = Number(l.quantity);
      const price = toAmount(m.price);
      return {
        menu_item_id: m.id,
        item_name: m.name,
        quantity,
        price,
        total_price: price * quantity,
        notes: l.notes || null,
      };
    });

  return {
    lines: priced,
    unavailable,
    total: priced.reduce((s, l) => s + l.total_price, 0),
  };
}

module.exports = {
  listCategories, listItems, getItem, guestMenu,
  createItem, updateItem, removeItem, priceBasket,
};
