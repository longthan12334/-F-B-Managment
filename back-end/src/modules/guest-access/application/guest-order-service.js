// =============================================================================
//  MODULE guest-access · APPLICATION — Khách gọi món & xem lịch sử
// -----------------------------------------------------------------------------
//  LUỒNG ĐẦY ĐỦ (trả lời nhận xét "cần có xác nhận đơn" + "xem lịch sử đặt"):
//
//   1. Khách bấm "Gửi" trên điện thoại
//   2. guest-access  : kiểm tra phiên, chống spam, định giá qua catalog
//   3. guest-access  : ghi guest_order_requests (status = pending) + ảnh chụp món
//   4. ordering      : mở/dùng lại đơn của bàn, chèn order_items (pending_confirm)
//                      gắn guest_request_id
//   5. realtime      : đẩy thông báo tới thu ngân & phục vụ
//   6. Nhân viên duyệt hoặc từ chối (API của ordering)
//   7. ordering phát sự kiện  →  guest-access cập nhật trạng thái yêu cầu
//   8. realtime      : đẩy kết quả về đúng phiên của khách (phòng guest:<sid>)
//   9. Khách thấy lịch sử cập nhật ngay, không cần tải lại trang
// =============================================================================
const db = require('../../../platform/database/pool');
const repo = require('../infrastructure/guest-repository');
const ordering = require('../../ordering/contract');
const catalog = require('../../catalog/contract');
const { AppError } = require('../../../shared/errors');
const { config } = require('../../../shared/config');
const { toAmount } = require('../../../shared/money');
const EVENTS = require('../../../platform/events/event-names');
const bus = require('../../../platform/events/event-bus');
const log = require('../../../shared/logger').child('guest-access');

/** Chống spam ở tầng nghiệp vụ (rate limit theo IP đã có ở tầng HTTP). */
const MAX_REQUESTS_PER_10_MIN = 8;

const STATUS_LABELS = Object.freeze({
  pending: 'Đang chờ nhà hàng xác nhận',
  confirmed: 'Nhà hàng đã xác nhận',
  partially_confirmed: 'Đã xác nhận một phần',
  rejected: 'Nhà hàng không nhận được yêu cầu này',
  cancelled: 'Đã huỷ',
});

/** Gộp các dòng trùng món và kiểm tra số lượng. */
function normalizeLines(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw AppError.validation('Chưa chọn món nào', ['items: cần ít nhất 1 món']);
  }
  if (raw.length > config.guest.maxLinesPerRequest) {
    throw AppError.validation('Gửi quá nhiều món một lúc', [
      `items: tối đa ${config.guest.maxLinesPerRequest} dòng mỗi lần gửi`,
    ]);
  }

  const merged = new Map();
  const errs = [];
  raw.forEach((line, i) => {
    const id = typeof line?.menu_item_id === 'string' ? line.menu_item_id.trim().toLowerCase() : '';
    const qty = Number(line?.quantity);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      errs.push(`items[${i}].menu_item_id: không hợp lệ`);
      return;
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > config.guest.maxQtyPerLine) {
      errs.push(`items[${i}].quantity: số nguyên từ 1 đến ${config.guest.maxQtyPerLine}`);
      return;
    }
    const prev = merged.get(id);
    const notes = line.notes ? String(line.notes).slice(0, 200) : null;
    merged.set(id, {
      menu_item_id: id,
      quantity: (prev?.quantity || 0) + qty,
      notes: notes || prev?.notes || null,
    });
  });

  if (errs.length) throw AppError.validation('Dữ liệu không hợp lệ', errs);

  for (const line of merged.values()) {
    if (line.quantity > config.guest.maxQtyPerLine) {
      throw AppError.validation('Số lượng vượt mức cho phép', [
        `Tổng số lượng mỗi món tối đa ${config.guest.maxQtyPerLine}`,
      ]);
    }
  }
  return [...merged.values()];
}

/** Thực đơn cho khách — chỉ món đang bán, không lộ trường quản trị. */
async function menuForGuest(session) {
  const menu = await catalog.guestMenu();
  return { table: { code: session.table_code }, ...menu };
}

/**
 * Khách gửi món.
 * @param {object} session Phiên khách đã xác thực
 * @param {{items:Array, note?:string}} input
 */
async function submitOrder(session, input, meta = {}) {
  const lines = normalizeLines(input.items);

  // Chống spam ở tầng nghiệp vụ
  const recent = await repo.countRecentRequests(session.id, 10);
  if (recent >= MAX_REQUESTS_PER_10_MIN) {
    await repo.blockSession(session.id, 'SPAM_GUARD');
    throw AppError.rateLimited(
      'Bạn đã gửi quá nhiều yêu cầu trong thời gian ngắn. Vui lòng gọi nhân viên hỗ trợ.'
    );
  }

  // Định giá qua catalog — giá KHÔNG bao giờ lấy từ dữ liệu khách gửi lên
  const priced = await catalog.priceBasket(lines);
  if (priced.unavailable.length) {
    throw new AppError('Một số món vừa hết, vui lòng tải lại thực đơn', {
      status: 422, code: 'ITEM_UNAVAILABLE', details: { unavailable: priced.unavailable },
    });
  }
  if (!priced.lines.length) throw AppError.validation('Không có món hợp lệ trong yêu cầu');

  // 1) Ghi yêu cầu của khách (lịch sử phía khách)
  const request = await repo.createRequest({
    guest_session_id: session.id,
    table_id: session.table_id,
    table_code: session.table_code,
    items_count: priced.lines.reduce((s, l) => s + l.quantity, 0),
    amount: priced.total,
    items_snapshot: priced.lines.map((l) => ({
      menu_item_id: l.menu_item_id,
      name: l.item_name,
      quantity: l.quantity,
      price: l.price,
      total_price: l.total_price,
      notes: l.notes,
    })),
    guest_note: input.note ? String(input.note).slice(0, 300) : null,
    client_ip: meta.ip,
  });

  // 2) Chuyển cho ordering tạo dòng món chờ duyệt
  let submitted;
  try {
    submitted = await ordering.submitGuestItems({
      table: { id: session.table_id, code: session.table_code },
      items: lines,
      guestRequestId: request.id,
      guestLabel: session.display_name,
    });
  } catch (err) {
    // Không tạo được dòng món → huỷ yêu cầu để khách không thấy đơn "ma"
    await repo.setRequestStatus(request.id, { status: 'cancelled', reject_reason: err.message })
      .catch(() => {});
    throw err;
  }

  // 3) Gắn mã đơn vào yêu cầu + cập nhật chỉ số phiên
  const linked = await repo.attachOrder(request.id, {
    order_id: submitted.order.id,
    order_code: submitted.order.code,
    created_new_order: submitted.createdNewOrder,
  });
  await repo.bumpSessionCounters(session.id, {
    items: request.items_count, amount: priced.total,
  }).catch(() => {});

  // 4) Nếu hệ thống không bắt buộc duyệt → đánh dấu đã xác nhận ngay
  if (!submitted.requiresConfirmation) {
    await repo.setRequestStatus(request.id, {
      status: 'confirmed', confirmed_amount: priced.total, reviewer_name: 'Tự động',
    });
  }

  bus.publish(EVENTS.GUEST_REQUEST_SUBMITTED, {
    request_id: request.id,
    request_code: request.code,
    guest_session_id: session.id,
    guest_name: session.display_name,
    table_id: session.table_id,
    table_code: session.table_code,
    order_id: submitted.order.id,
    order_code: submitted.order.code,
    items_count: request.items_count,
    amount: priced.total,
    requires_confirmation: submitted.requiresConfirmation,
  });

  return toGuestRequestView(linked, priced.lines.map((l) => ({
    item_name: l.item_name, quantity: l.quantity, price: l.price,
    total_price: l.total_price, notes: l.notes,
    status: submitted.requiresConfirmation ? 'pending_confirm' : 'confirmed',
  })));
}

/** Góc nhìn một yêu cầu dành cho khách. */
function toGuestRequestView(request, items = null) {
  if (!request) return null;
  const snapshot = Array.isArray(request.items_snapshot) ? request.items_snapshot : [];
  return {
    request_id: request.id,
    code: request.code,
    status: request.status,
    status_label: STATUS_LABELS[request.status] || request.status,
    table_code: request.table_code,
    order_code: request.order_code,
    items_count: request.items_count,
    amount: toAmount(request.amount),
    confirmed_amount: toAmount(request.confirmed_amount),
    guest_note: request.guest_note,
    reject_reason: request.reject_reason,
    reviewed_by_name: request.reviewed_by_name,
    reviewed_at: request.reviewed_at,
    submitted_at: request.submitted_at,
    items: items || snapshot.map((s) => ({
      item_name: s.name, quantity: s.quantity, price: s.price,
      total_price: s.total_price, notes: s.notes,
    })),
  };
}

/**
 * LỊCH SỬ ĐẶT MÓN CỦA KHÁCH — màn hình "Đơn của tôi".
 * Ghép hai nguồn: bản ghi yêu cầu (ảnh chụp lúc gửi) + trạng thái hiện tại của
 * từng dòng món bên ordering (đã duyệt / từ chối / đã phục vụ).
 */
async function orderHistory(session) {
  const requests = await repo.listRequestsForSession(session.id);

  const detailed = await Promise.all(requests.map(async (r) => {
    const liveItems = await ordering.itemsOfGuestRequest(r.id).catch(() => []);
    const snapshot = Array.isArray(r.items_snapshot) ? r.items_snapshot : [];

    // Ưu tiên trạng thái sống; nếu dòng món đã bị xoá thì dùng ảnh chụp
    const items = liveItems.length
      ? liveItems.map((i) => ({
          item_name: i.item_name,
          quantity: i.quantity,
          price: toAmount(i.price),
          total_price: toAmount(i.total_price),
          notes: i.notes,
          status: i.status,
          reject_reason: i.reject_reason,
          served_at: i.served_at,
        }))
      : snapshot.map((s) => ({
          item_name: s.name, quantity: s.quantity, price: s.price,
          total_price: s.total_price, notes: s.notes, status: 'cancelled',
        }));

    return { ...toGuestRequestView(r), items };
  }));

  const confirmedTotal = detailed.reduce(
    (sum, r) => sum + r.items
      .filter((i) => ['confirmed', 'served'].includes(i.status))
      .reduce((s, i) => s + i.total_price, 0),
    0
  );
  const pendingTotal = detailed.reduce(
    (sum, r) => sum + r.items
      .filter((i) => i.status === 'pending_confirm')
      .reduce((s, i) => s + i.total_price, 0),
    0
  );

  return {
    session: {
      table_code: session.table_code,
      display_name: session.display_name,
      started_at: session.started_at,
      expires_at: session.expires_at,
    },
    summary: {
      request_count: detailed.length,
      confirmed_amount: confirmedTotal,
      pending_amount: pendingTotal,
      estimated_total: confirmedTotal + pendingTotal,
      has_pending: pendingTotal > 0,
    },
    requests: detailed,
  };
}

// ─── Đồng bộ trạng thái khi nhân viên duyệt / từ chối ───────────────────────

/**
 * Tính lại trạng thái tổng hợp của một yêu cầu từ trạng thái các dòng món.
 * Gọi khi nhận sự kiện ORDER_ITEM_CONFIRMED / ORDER_ITEM_REJECTED.
 */
async function syncRequestStatus(requestId, reviewer = {}) {
  const items = await ordering.itemsOfGuestRequest(requestId);
  if (!items.length) return null;

  const hasPending = items.some((i) => i.status === 'pending_confirm');
  const confirmed = items.filter((i) => ['confirmed', 'served'].includes(i.status));
  const rejected = items.filter((i) => i.status === 'rejected');

  let status = 'pending';
  if (!hasPending) {
    if (confirmed.length && rejected.length) status = 'partially_confirmed';
    else if (rejected.length && !confirmed.length) status = 'rejected';
    else if (confirmed.length) status = 'confirmed';
  }

  const confirmedAmount = confirmed.reduce((s, i) => s + toAmount(i.total_price), 0);
  const rejectReason = rejected.find((i) => i.reject_reason)?.reject_reason || null;

  const updated = await repo.setRequestStatus(requestId, {
    status,
    confirmed_amount: confirmedAmount,
    reviewer_id: reviewer.id,
    reviewer_name: reviewer.name,
    reject_reason: rejectReason,
  });

  if (updated && status !== 'pending') {
    bus.publish(EVENTS.GUEST_REQUEST_REVIEWED, {
      request_id: requestId,
      guest_session_id: updated.guest_session_id,
      table_id: updated.table_id,
      table_code: updated.table_code,
      status,
      confirmed_amount: confirmedAmount,
      reject_reason: rejectReason,
      reviewer_name: reviewer.name,
    });
  }

  return updated;
}

// ─── Góc nhìn cho nhân viên ─────────────────────────────────────────────────
async function listPendingRequests(filters) {
  const rows = await repo.listPendingRequests(filters);
  return rows.map((r) => ({
    ...toGuestRequestView(r),
    guest_name: r.guest_name,
    guest_session_id: r.guest_session_id,
    table_id: r.table_id,
    order_id: r.order_id,
    waiting_minutes: Math.max(0, Math.round((Date.now() - new Date(r.submitted_at).getTime()) / 60000)),
  }));
}

async function listRequestsForTable(tableId) {
  const rows = await repo.listRequestsForTable(tableId);
  return rows.map((r) => ({ ...toGuestRequestView(r), guest_name: r.guest_name }));
}

module.exports = {
  STATUS_LABELS,
  menuForGuest, submitOrder, orderHistory,
  syncRequestStatus, listPendingRequests, listRequestsForTable,
  toGuestRequestView, normalizeLines,
};
