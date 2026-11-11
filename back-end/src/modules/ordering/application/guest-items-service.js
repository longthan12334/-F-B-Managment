// =============================================================================
//  MODULE ordering · APPLICATION — Món do khách tự gọi qua mã QR
// -----------------------------------------------------------------------------
//  Chia vai trò rõ ràng giữa hai module:
//    • guest-access : sở hữu PHIÊN KHÁCH và LỊCH SỬ YÊU CẦU (khách nhìn thấy gì)
//    • ordering     : sở hữu ĐƠN HÀNG và DÒNG MÓN (nhà hàng vận hành trên gì)
//
//  Khi khách bấm "Gửi":
//    guest-access tạo guest_order_requests  →  gọi hàm dưới đây
//    →  ordering mở/dùng lại đơn của bàn, chèn các dòng món ở trạng thái
//       `pending_confirm`, gắn `guest_request_id` để lần ngược được.
//
//  Khi nhân viên duyệt / từ chối:
//    ordering đổi trạng thái dòng món  →  phát sự kiện
//    →  guest-access nghe và cập nhật trạng thái yêu cầu cho khách thấy.
//
//  Nhờ vậy ordering KHÔNG phụ thuộc guest-access (chiều phụ thuộc một chiều),
//  mà khách vẫn theo dõi được đơn của mình theo thời gian thực.
// =============================================================================
const db = require('../../../platform/database/pool');
const repo = require('../infrastructure/order-repository');
const domain = require('../domain/order');
const orderService = require('./order-service');
const { AppError } = require('../../../shared/errors');
const { config } = require('../../../shared/config');
const EVENTS = require('../../../platform/events/event-names');
const bus = require('../../../platform/events/event-bus');

const { ITEM_STATUS, ITEM_SOURCE } = domain;

const GUEST_WAITER_LABEL = 'Khách (QR)';

/**
 * Khách gửi món.
 * @param {object} p
 * @param {object} p.table          Bàn (lấy từ dining.contract)
 * @param {Array}  p.items          [{ menu_item_id, quantity, notes? }]
 * @param {string} p.guestRequestId Mã yêu cầu do guest-access sinh ra
 * @param {string} [p.guestLabel]   Tên khách tự đặt, ví dụ "Bàn 5 - Anh Minh"
 * @returns {Promise<{order, addedItems, createdNewOrder, requiresConfirmation}>}
 */
async function submitGuestItems({ table, items, guestRequestId, guestLabel }) {
  domain.assertValidBasket(items, {
    maxLines: config.guest.maxLinesPerRequest,
    maxQty: config.guest.maxQtyPerLine,
  });

  // Chế độ duyệt: bật → món vào hàng đợi chờ nhân viên xác nhận.
  // Tắt  → món vào đơn ngay (quán tự phục vụ, tin khách).
  const requiresConfirmation = config.guest.requireStaffConfirmation;
  const itemStatus = requiresConfirmation ? ITEM_STATUS.PENDING_CONFIRM : ITEM_STATUS.CONFIRMED;

  const lines = await orderService.priceLines(items, {
    source: ITEM_SOURCE.QR,
    status: itemStatus,
    guestRequestId,
  });
  if (!lines.length) throw AppError.validation('Không có món hợp lệ trong yêu cầu');

  // Thử lại một lần: nhân viên có thể vừa mở đơn cho đúng bàn này giữa chừng
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await db.transaction(async (client) => {
        await repo.lockTable(table.id, client);

        let order = await repo.findOpenByTable(table.id, client);
        const createdNewOrder = !order;

        if (!order) {
          order = await repo.insertOrder({
            table_id: table.id,
            table_code: table.code,
            waiter_id: null,
            waiter_name: guestLabel ? `${GUEST_WAITER_LABEL} · ${guestLabel}` : GUEST_WAITER_LABEL,
            source: ITEM_SOURCE.QR,
            notes: null,
          }, client);
        }

        const addedItems = await repo.insertItems(order.id, lines, client);
        const updated = await repo.recalculateTotal(order.id, client);
        return {
          order: updated,
          addedItems,
          createdNewOrder,
          allItems: await repo.getItems(order.id, client),
        };
      });

      const payload = orderService.eventPayload(result.order, result.allItems, {
        source: ITEM_SOURCE.QR,
        guest_request_id: guestRequestId,
        added: result.addedItems.length,
        requires_confirmation: requiresConfirmation,
      });

      bus.publish(result.createdNewOrder ? EVENTS.ORDER_CREATED : EVENTS.ORDER_ITEMS_ADDED, payload);

      return { ...result, requiresConfirmation, order: domain.toView(result.order, result.allItems) };
    } catch (err) {
      if (err.code === '23505' && attempt < 3) continue; // đua tạo đơn — thử lại
      throw err;
    }
  }
}

/** Duyệt hoặc từ chối TOÀN BỘ món của một lượt khách gửi. */
async function reviewGuestRequest(guestRequestId, { approve, reason, reviewer }) {
  const targetStatus = approve ? ITEM_STATUS.CONFIRMED : ITEM_STATUS.REJECTED;

  const result = await db.transaction(async (client) => {
    const affected = await repo.setItemsStatusByRequest(
      guestRequestId, targetStatus,
      { reviewer_id: reviewer?.id, reject_reason: approve ? null : reason },
      client
    );
    if (!affected.length) {
      throw AppError.conflict('Yêu cầu này đã được xử lý hoặc không còn món nào chờ duyệt.');
    }

    const orderId = affected[0].order_id;
    const order = await repo.recalculateTotal(orderId, client);
    return { order, affected, items: await repo.getItems(orderId, client) };
  });

  const payload = orderService.eventPayload(result.order, result.items, {
    guest_request_id: guestRequestId,
    reviewed_count: result.affected.length,
    approved: Boolean(approve),
    reject_reason: approve ? null : reason || null,
    reviewer_id: reviewer?.id,
    reviewer_name: reviewer?.full_name,
    items: result.affected.map((i) => ({
      id: i.id, item_name: i.item_name, quantity: i.quantity, status: i.status,
    })),
  });

  bus.publish(approve ? EVENTS.ORDER_ITEM_CONFIRMED : EVENTS.ORDER_ITEM_REJECTED, payload,
    { actor: reviewer?.full_name });

  return { order: domain.toView(result.order, result.items), reviewed: result.affected };
}

/** Duyệt / từ chối MỘT dòng món (khi chỉ hết đúng một món trong lượt gọi). */
async function reviewSingleItem(orderId, itemId, { approve, reason, reviewer }) {
  const result = await db.transaction(async (client) => {
    const order = await repo.findById(orderId, client);
    domain.assertOpen(order, 'duyệt món');

    const item = await repo.getItem(orderId, itemId, client);
    if (!item) throw AppError.notFound('Món trong đơn không tồn tại');
    if (item.status !== ITEM_STATUS.PENDING_CONFIRM) {
      throw AppError.conflict(`Món "${item.item_name}" không ở trạng thái chờ duyệt.`);
    }

    const updated = await repo.setItemStatus(
      itemId, approve ? ITEM_STATUS.CONFIRMED : ITEM_STATUS.REJECTED,
      { reviewer_id: reviewer?.id, reject_reason: approve ? null : reason },
      client
    );
    const recalculated = await repo.recalculateTotal(orderId, client);
    return { order: recalculated, item: updated, items: await repo.getItems(orderId, client) };
  });

  bus.publish(approve ? EVENTS.ORDER_ITEM_CONFIRMED : EVENTS.ORDER_ITEM_REJECTED,
    orderService.eventPayload(result.order, result.items, {
      guest_request_id: result.item.guest_request_id,
      single_item: true,
      approved: Boolean(approve),
      reject_reason: approve ? null : reason || null,
      reviewer_id: reviewer?.id, reviewer_name: reviewer?.full_name,
      items: [{ id: result.item.id, item_name: result.item.item_name, status: result.item.status }],
    }), { actor: reviewer?.full_name });

  return domain.toView(result.order, result.items);
}

/** Đánh dấu món đã phục vụ xong (phục vụ cho màn hình bếp sau này). */
async function markItemServed(orderId, itemId, actor) {
  const result = await db.transaction(async (client) => {
    const order = await repo.findById(orderId, client);
    domain.assertOpen(order, 'đánh dấu đã phục vụ');

    const item = await repo.getItem(orderId, itemId, client);
    if (!item) throw AppError.notFound('Món trong đơn không tồn tại');
    if (item.status !== ITEM_STATUS.CONFIRMED) {
      throw AppError.conflict('Chỉ món đã được xác nhận mới đánh dấu phục vụ được.');
    }
    await repo.setItemStatus(itemId, ITEM_STATUS.SERVED, { reviewer_id: actor?.id }, client);
    return { order, items: await repo.getItems(orderId, client) };
  });

  bus.publish(EVENTS.ORDER_UPDATED, orderService.eventPayload(result.order, result.items, {
    change: 'item_served', item_id: itemId, actor_id: actor?.id, actor_name: actor?.full_name,
  }), { actor: actor?.full_name });

  return domain.toView(result.order, result.items);
}

/** Các món của một lượt khách gửi — guest-access dùng để dựng lịch sử cho khách. */
async function itemsOfGuestRequest(guestRequestId) {
  return db.query(
    `SELECT id, item_name, quantity, price, total_price, notes, status, reject_reason,
            reviewed_at, served_at, created_at
     FROM order_items WHERE guest_request_id = $1 ORDER BY created_at, id`,
    [guestRequestId]
  );
}

module.exports = {
  GUEST_WAITER_LABEL,
  submitGuestItems, reviewGuestRequest, reviewSingleItem, markItemServed, itemsOfGuestRequest,
};
