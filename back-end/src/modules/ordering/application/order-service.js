// =============================================================================
//  MODULE ordering · APPLICATION — Use-case đơn hàng
// -----------------------------------------------------------------------------
//  Quy ước chung của mọi use-case ghi dữ liệu:
//    1. Kiểm tra quy tắc nghiệp vụ (gọi hàm trong domain/).
//    2. Thực hiện trong MỘT transaction (nguyên tử).
//    3. SAU KHI commit mới phát sự kiện (nếu phát trước, module khác có thể
//       đọc phải dữ liệu chưa commit hoặc đã bị rollback).
// =============================================================================
const db = require('../../../platform/database/pool');
const repo = require('../infrastructure/order-repository');
const dining = require('../../dining/contract');
const catalog = require('../../catalog/contract');
const domain = require('../domain/order');
const { AppError } = require('../../../shared/errors');
const { toAmount } = require('../../../shared/money');
const EVENTS = require('../../../platform/events/event-names');
const bus = require('../../../platform/events/event-bus');

const { ORDER_STATUS, ITEM_STATUS, ITEM_SOURCE } = domain;

// ─── Trợ giúp ────────────────────────────────────────────────────────────────

/** Nạp đơn + dòng món, trả về góc nhìn đầy đủ. */
async function loadOrderView(orderId, client = null) {
  const order = await repo.findById(orderId, client);
  if (!order) return null;
  const items = await repo.getItems(orderId, client);
  return domain.toView(order, items);
}

/** Dựng payload sự kiện chuẩn — dining/analytics/auditing đều đọc cùng cấu trúc. */
function eventPayload(order, items, extra = {}) {
  return { ...domain.toSummary(order, items), ...extra };
}

/** Lấy bàn qua contract của dining và kiểm tra còn nhận khách. */
async function resolveTable({ table_id, table_code }) {
  const table = table_id
    ? await dining.getTableById(table_id)
    : table_code ? await dining.getTableByCode(table_code) : null;

  if (!table) throw AppError.notFound('Bàn không tồn tại');
  if (table.is_active === false) {
    throw AppError.conflict(`Bàn ${table.code} đang tạm ngưng, không thể mở đơn.`);
  }
  return table;
}

/**
 * Định giá giỏ món qua contract của catalog.
 * Giá KHÔNG BAO GIỜ lấy từ request — luôn lấy từ thực đơn trong CSDL.
 */
async function priceLines(rawLines, { source = ITEM_SOURCE.STAFF, status = ITEM_STATUS.CONFIRMED, guestRequestId = null } = {}) {
  const withMenuId = rawLines.filter((l) => l.menu_item_id);
  const adHoc = rawLines.filter((l) => !l.menu_item_id);

  const priced = withMenuId.length ? await catalog.priceBasket(withMenuId) : { lines: [], unavailable: [], total: 0 };

  if (priced.unavailable.length) {
    throw new AppError('Một số món không còn phục vụ, vui lòng tải lại thực đơn', {
      status: 422, code: 'ITEM_UNAVAILABLE', details: { unavailable: priced.unavailable },
    });
  }

  // Món ngoài thực đơn (nhân viên nhập tay) — chỉ chấp nhận từ nguồn staff
  const adHocLines = adHoc.map((l) => {
    if (source !== ITEM_SOURCE.STAFF) {
      throw AppError.validation('Khách chỉ được gọi món có trong thực đơn', ['items: thiếu menu_item_id']);
    }
    const price = toAmount(l.price);
    const quantity = Number(l.quantity);
    return {
      menu_item_id: null,
      item_name: String(l.item_name).trim(),
      quantity, price, total_price: price * quantity, notes: l.notes || null,
    };
  });

  return [...priced.lines, ...adHocLines].map((l) => ({
    ...l, status, source, guest_request_id: guestRequestId,
  }));
}

// ─── Use-cases: đọc ──────────────────────────────────────────────────────────

async function listOrders(filters) {
  const orders = await repo.findAll(filters);
  return Promise.all(orders.map(async (o) => domain.toView(o, await repo.getItems(o.id))));
}

async function getOrder(id) {
  const view = await loadOrderView(id);
  if (!view) throw AppError.notFound('Đơn hàng không tồn tại');
  return view;
}

async function getOpenOrderForTable(tableId) {
  const order = await repo.findOpenByTable(tableId);
  if (!order) return null;
  return domain.toView(order, await repo.getItems(order.id));
}

async function listPendingItems(filters) {
  const rows = await repo.findPendingItems(filters);
  return rows.map((r) => ({ ...r, price: toAmount(r.price), total_price: toAmount(r.total_price) }));
}

// ─── Use-cases: ghi ──────────────────────────────────────────────────────────

/**
 * Mở đơn mới cho một bàn.
 * Bất biến "mỗi bàn một đơn mở" được bảo vệ hai lớp: kiểm tra ở ứng dụng (cho
 * thông báo dễ hiểu) và unique index ở CSDL (chống đua giữa hai request).
 */
async function createOrder(input, actor) {
  domain.assertValidBasket(input.items);
  const table = await resolveTable(input);

  const lines = await priceLines(input.items, { source: ITEM_SOURCE.STAFF, status: ITEM_STATUS.CONFIRMED });

  const { order, items } = await db.transaction(async (client) => {
    await repo.lockTable(table.id, client);

    const existing = await repo.findOpenByTable(table.id, client);
    if (existing) {
      throw AppError.conflict(`Bàn ${table.code} đang có đơn mở (${existing.code}). Hãy thêm món vào đơn đó.`);
    }

    const created = await repo.insertOrder({
      table_id: table.id,
      table_code: table.code,
      waiter_id: actor?.id || null,
      waiter_name: String(input.waiter_name || actor?.full_name || 'Nhân viên').trim(),
      source: ITEM_SOURCE.STAFF,
      notes: input.notes,
    }, client);

    const inserted = await repo.insertItems(created.id, lines, client);
    const recalculated = await repo.recalculateTotal(created.id, client);
    return { order: recalculated, items: inserted };
  }).catch((err) => {
    if (err.code === '23505') throw AppError.conflict('Bàn này vừa được mở đơn bởi người khác, vui lòng tải lại.');
    throw err;
  });

  bus.publish(EVENTS.ORDER_CREATED, eventPayload(order, items, {
    actor_id: actor?.id, actor_name: actor?.full_name,
  }), { actor: actor?.full_name });

  return domain.toView(order, items);
}

/** Thêm món vào đơn đang mở (nhân viên). */
async function addItems(orderId, rawItems, actor) {
  domain.assertValidBasket(rawItems);
  const lines = await priceLines(rawItems, { source: ITEM_SOURCE.STAFF, status: ITEM_STATUS.CONFIRMED });

  const { order, items } = await db.transaction(async (client) => {
    const existing = await repo.findById(orderId, client);
    domain.assertOpen(existing, 'thêm món');
    await repo.insertItems(orderId, lines, client);
    const updated = await repo.recalculateTotal(orderId, client);
    return { order: updated, items: await repo.getItems(orderId, client) };
  });

  bus.publish(EVENTS.ORDER_ITEMS_ADDED, eventPayload(order, items, {
    actor_id: actor?.id, actor_name: actor?.full_name, added: lines.length,
  }), { actor: actor?.full_name });

  return domain.toView(order, items);
}

async function updateItem(orderId, itemId, patch, actor) {
  const { order, items } = await db.transaction(async (client) => {
    const existing = await repo.findById(orderId, client);
    domain.assertOpen(existing, 'sửa món');

    const item = await repo.getItem(orderId, itemId, client);
    if (!item) throw AppError.notFound('Món trong đơn không tồn tại');
    if (item.status === ITEM_STATUS.REJECTED) {
      throw AppError.conflict('Món đã bị từ chối, không thể sửa.');
    }

    const quantity = patch.quantity !== undefined ? Number(patch.quantity) : item.quantity;
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw AppError.validation('Dữ liệu không hợp lệ', ['quantity: số nguyên dương']);
    }

    await repo.updateItem(itemId, {
      quantity,
      total_price: toAmount(item.price) * quantity,
      notes: patch.notes,
    }, client);

    const updated = await repo.recalculateTotal(orderId, client);
    return { order: updated, items: await repo.getItems(orderId, client) };
  });

  bus.publish(EVENTS.ORDER_UPDATED, eventPayload(order, items, {
    change: 'item_updated', item_id: itemId, actor_id: actor?.id, actor_name: actor?.full_name,
  }), { actor: actor?.full_name });

  return domain.toView(order, items);
}

async function removeItem(orderId, itemId, actor) {
  const { order, items, removed } = await db.transaction(async (client) => {
    const existing = await repo.findById(orderId, client);
    domain.assertOpen(existing, 'xoá món');

    const item = await repo.getItem(orderId, itemId, client);
    if (!item) throw AppError.notFound('Món trong đơn không tồn tại');

    const deleted = await repo.deleteItem(itemId, client);
    const updated = await repo.recalculateTotal(orderId, client);
    return { order: updated, items: await repo.getItems(orderId, client), removed: deleted };
  });

  bus.publish(EVENTS.ORDER_UPDATED, eventPayload(order, items, {
    change: 'item_removed', item_id: itemId, item_name: removed?.item_name,
    actor_id: actor?.id, actor_name: actor?.full_name,
  }), { actor: actor?.full_name });

  return domain.toView(order, items);
}

async function updateStatus(orderId, status, actor) {
  const { order, items } = await db.transaction(async (client) => {
    const existing = await repo.findById(orderId, client);
    if (!existing) throw AppError.notFound('Đơn hàng không tồn tại');
    domain.assertTransition(existing.status, status);
    const updated = await repo.updateStatus(orderId, status, client);
    return { order: updated, items: await repo.getItems(orderId, client) };
  });

  const event = status === ORDER_STATUS.CANCELLED ? EVENTS.ORDER_CANCELLED
    : status === ORDER_STATUS.COMPLETED ? EVENTS.ORDER_COMPLETED
    : EVENTS.ORDER_UPDATED;

  bus.publish(event, eventPayload(order, items, {
    change: 'status', status, actor_id: actor?.id, actor_name: actor?.full_name,
  }), { actor: actor?.full_name });

  return domain.toView(order, items);
}

async function cancelOrder(orderId, reason, actor) {
  const { order, items } = await db.transaction(async (client) => {
    const existing = await repo.findById(orderId, client);
    if (!existing) throw AppError.notFound('Đơn hàng không tồn tại');
    domain.assertTransition(existing.status, ORDER_STATUS.CANCELLED);
    const cancelled = await repo.cancel(orderId, reason, client);
    return { order: cancelled, items: await repo.getItems(orderId, client) };
  });

  bus.publish(EVENTS.ORDER_CANCELLED, eventPayload(order, items, {
    reason, actor_id: actor?.id, actor_name: actor?.full_name,
  }), { actor: actor?.full_name });

  return domain.toView(order, items);
}

/**
 * "Dọn bàn": huỷ đơn đang mở của một bàn mà KHÔNG lập hoá đơn.
 * Dùng khi khách bỏ về hoặc cần trả bàn về trạng thái trống.
 * Endpoint nằm ở module ordering vì thao tác này ghi vào bảng `orders`.
 */
async function clearTable(tableId, reason, actor) {
  const table = await dining.getTableById(tableId);
  if (!table) throw AppError.notFound('Bàn không tồn tại');

  const open = await repo.findOpenByTable(tableId);
  if (!open) {
    return { table_code: table.code, cancelled_order: null, message: `Bàn ${table.code} đã trống.` };
  }

  const cancelled = await cancelOrder(open.id, reason || 'CLEAR_TABLE', actor);
  return {
    table_code: table.code,
    cancelled_order: cancelled,
    message: `Đã dọn bàn ${table.code} (huỷ đơn ${cancelled.code}).`,
  };
}

/** Chuyển đơn sang bàn khác. */
async function moveOrder(orderId, toTableId, actor) {
  const toTable = await resolveTable({ table_id: toTableId });

  const result = await db.transaction(async (client) => {
    const order = await repo.findById(orderId, client);
    domain.assertOpen(order, 'chuyển bàn');
    if (order.table_id === toTable.id) throw AppError.conflict('Đơn đã ở bàn này rồi.');

    await repo.lockTable(toTable.id, client);
    const occupied = await repo.findOpenByTable(toTable.id, client);
    if (occupied) throw AppError.conflict(`Bàn ${toTable.code} đang có đơn mở (${occupied.code}).`);

    const from = { id: order.table_id, code: order.table_code };
    const moved = await repo.moveToTable(orderId, { table_id: toTable.id, table_code: toTable.code }, client);
    return { order: moved, from, items: await repo.getItems(orderId, client) };
  }).catch((err) => {
    if (err.code === '23505') throw AppError.conflict(`Bàn ${toTable.code} vừa được mở đơn, vui lòng chọn bàn khác.`);
    throw err;
  });

  bus.publish(EVENTS.ORDER_MOVED, {
    ...domain.toSummary(result.order, result.items),
    from_table_id: result.from.id, from_table_code: result.from.code,
    to_table_id: toTable.id, to_table_code: toTable.code,
    actor_id: actor?.id, actor_name: actor?.full_name,
  }, { actor: actor?.full_name });

  return domain.toView(result.order, result.items);
}

module.exports = {
  // đọc
  listOrders, getOrder, getOpenOrderForTable, listPendingItems, loadOrderView,
  // ghi
  createOrder, addItems, updateItem, removeItem, updateStatus, cancelOrder, clearTable, moveOrder,
  // dùng lại bởi guest-ordering-service
  priceLines, resolveTable, eventPayload,
};
