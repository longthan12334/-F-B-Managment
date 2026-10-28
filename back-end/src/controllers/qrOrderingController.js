// =============================================================================
//  qrOrderingController.js (BE-2)
//
//  Gộp toàn bộ nghiệp vụ staff liên quan QR Ordering vào 1 file (tinh thần slim):
//    - guestOrder.* : xem danh sách pending, confirm (snapshot sang orders cũ), reject
//    - staffCall.*  : xem list, acknowledge, markDone
//
//  Thay vì tách 2 file controller riêng, gộp vì cùng bounded context "staff xử lý
//  yêu cầu từ bàn QR". Khi feature lớn hơn (>500 dòng) mới tách.
// =============================================================================

const { ok, ApiError, asyncHandler } = require('../utils/response');
const db = require('../database/db');
const realtime = require('../realtime/io');

// ─── 1. Guest Orders ────────────────────────────────────────────────────────

exports.guestOrder = {
  listPending: asyncHandler(async (_req, res) => {
    const rows = await db.query(`
      SELECT
        go.id, go.code, go.table_code, go.total_amount, go.notes, go.created_at,
        COALESCE((
          SELECT json_agg(json_build_object(
            'id', goi.id, 'menuItemId', goi.menu_item_id,
            'itemName', goi.item_name, 'quantity', goi.quantity,
            'price', goi.price, 'totalPrice', goi.total_price, 'notes', goi.notes
          ) ORDER BY goi.created_at)
            FROM guest_order_items goi WHERE goi.guest_order_id = go.id
        ), '[]'::json) AS items
      FROM guest_orders go
      WHERE go.status = 'pending_confirmation'
      ORDER BY go.created_at ASC
    `);
    return ok(res, rows);
  }),

  confirm: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    const result = await db.transaction(async (client) => {
      const { rows: [go] } = await client.query(
        'SELECT * FROM guest_orders WHERE id=$1 FOR UPDATE', [id]);
      if (!go) throw ApiError.notFound('Đơn khách không tồn tại.');
      if (go.status !== 'pending_confirmation')
        throw ApiError.conflict(`Đơn đang '${go.status}', không thể xác nhận.`);

      const { rows: [user] } = await client.query(
        'SELECT id, full_name FROM users WHERE id=$1', [userId]);
      if (!user) throw ApiError.unauthorized('Không tìm thấy user staff.');

      // Khoá dòng bàn → 2 staff confirm cùng lúc cho 1 bàn sẽ chạy tuần tự,
      // tránh cả 2 cùng không thấy order mở rồi cùng INSERT (vi phạm one_open_order_per_table).
      const { rows: [tbl] } = await client.query(
        'SELECT id FROM tables WHERE code=$1 FOR UPDATE', [go.table_code]);
      if (!tbl) throw ApiError.notFound(`Bàn ${go.table_code} không tồn tại.`);

      // Bàn đã có order đang mở → ghép món vào order đó thay vì tạo order mới
      const { rows: [openOrder] } = await client.query(`
        SELECT id, code FROM orders
         WHERE table_id=$1 AND status IN ('pending','serving')
         LIMIT 1 FOR UPDATE
      `, [tbl.id]);

      let order;
      if (openOrder) {
        const noteLine = go.notes ? `[${go.code}] ${go.notes}` : null;
        await client.query(`
          UPDATE orders
             SET total_amount = total_amount + $1,
                 notes = CASE WHEN $2::text IS NULL THEN notes
                              ELSE CONCAT_WS(E'\\n', NULLIF(notes, ''), $2::text) END,
                 updated_at = NOW()
           WHERE id=$3
        `, [go.total_amount, noteLine, openOrder.id]);
        order = openOrder;
      } else {
        const { rows: [newOrder] } = await client.query(`
          INSERT INTO orders (
            code, table_id, table_code, waiter_id, waiter_name,
            status, total_amount, check_in_time, notes,
            guest_order_id, source
          )
          VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, 'guest_qr')
          RETURNING id, code
        `, [go.code, tbl.id, go.table_code, userId, user.full_name,
            go.total_amount, go.created_at, go.notes, go.id]);
        order = newOrder;
      }

      await client.query(`
        INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, price, total_price, notes)
        SELECT $1, menu_item_id, item_name, quantity, price, total_price, notes
          FROM guest_order_items WHERE guest_order_id=$2
      `, [order.id, go.id]);

      await client.query(`
        UPDATE guest_orders
           SET status='confirmed', confirmed_by=$1, confirmed_at=NOW(),
               order_id=$2, updated_at=NOW()
         WHERE id=$3
      `, [userId, order.id, id]);

      return { order, merged: !!openOrder, guestOrder: go };
    });

    try {
      // → Staff dashboard (authenticated room)
      realtime.emit('order-updated', {
        orderId: result.order.id, source: 'guest_qr',
        tableCode: result.guestOrder.table_code, merged: result.merged,
      });
      realtime.emit('guest-order-confirmed', {
        guestOrderId: result.guestOrder.id, status: 'confirmed',
      });
      realtime.broadcastOrdersChanged({ reason: 'guest_confirmed', order_id: result.order.id });
      realtime.broadcastTablesChanged({ reason: 'guest_confirmed', table_code: result.guestOrder.table_code });

      // ★ Push tới khách qua table room — thay thế polling hoàn toàn
      realtime.emitToTable(result.guestOrder.table_code, 'order:confirmed', {
        guestOrderId: result.guestOrder.id,
        status: 'confirmed',
        message: 'Đơn của bạn đã được xác nhận!',
      });
    } catch (_) { /* ignore */ }

    return ok(res, {
      orderId: result.order.id,
      guestOrderId: result.guestOrder.id,
      code: result.order.code,
      merged: result.merged,
    }, { message: result.merged ? 'Đã xác nhận và ghép vào order đang mở của bàn.' : 'Đã xác nhận đơn.' });
  }),

  reject: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body || {};

    const row = await db.transaction(async (client) => {
      const { rows: [go] } = await client.query(
        'SELECT * FROM guest_orders WHERE id=$1 FOR UPDATE', [id]);
      if (!go) throw ApiError.notFound('Đơn khách không tồn tại.');
      if (go.status !== 'pending_confirmation')
        throw ApiError.conflict(`Đơn đang '${go.status}', không thể từ chối.`);

      const noteSuffix = reason ? `\n[Staff từ chối: ${String(reason).slice(0, 200)}]` : '';
      const { rows: [updated] } = await client.query(`
        UPDATE guest_orders
           SET status='cancelled', confirmed_by=$1, confirmed_at=NOW(),
               notes=COALESCE(notes,'') || $2, updated_at=NOW()
         WHERE id=$3
         RETURNING id, status, table_code
      `, [req.user.id, noteSuffix, id]);
      return updated;
    });

    try {
      // → Staff dashboard
      realtime.emit('guest-order-rejected', { guestOrderId: row.id, status: 'cancelled' });

      // ★ Push tới khách qua table room
      realtime.emitToTable(row.table_code, 'order:rejected', {
        guestOrderId: row.id,
        status: 'cancelled',
        reason: reason || null,
        message: reason ? `Đơn bị từ chối: ${reason}` : 'Đơn của bạn đã bị từ chối.',
      });
    } catch (_) { /* ignore */ }

    return ok(res, { guestOrderId: row.id }, { message: 'Đã từ chối đơn.' });
  }),
};

// ─── 2. Staff Calls ─────────────────────────────────────────────────────────

exports.staffCall = {
  listPending: asyncHandler(async (_req, res) => {
    const rows = await db.query(`
      SELECT id, table_session_id, table_code, reason, created_at
        FROM staff_calls
       WHERE status='pending'
       ORDER BY created_at ASC
    `);
    return ok(res, rows);
  }),

  acknowledge: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    const row = await db.transaction(async (client) => {
      const { rows: [call] } = await client.query(
        'SELECT * FROM staff_calls WHERE id=$1 FOR UPDATE', [id]);
      if (!call) throw ApiError.notFound('Yêu cầu không tồn tại.');
      if (call.status !== 'pending')
        throw ApiError.conflict(`Yêu cầu đang '${call.status}', không thể acknowledge lại.`);

      const { rows: [updated] } = await client.query(`
        UPDATE staff_calls
           SET status='acknowledged', acknowledged_by=$1, acknowledged_at=NOW()
         WHERE id=$2
         RETURNING id, status, table_code
      `, [userId, id]);
      return updated;
    });

    try { realtime.emit('staff-call-acknowledged', { callId: row.id, tableCode: row.table_code }); }
    catch (_) { /* ignore */ }

    return ok(res, row, { message: 'Đã tiếp nhận yêu cầu.' });
  }),

  markDone: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const row = await db.queryOne(`
      UPDATE staff_calls SET status='done'
       WHERE id=$1 AND status IN ('pending','acknowledged')
       RETURNING id, status, table_code
    `, [id]);
    if (!row) throw ApiError.notFound('Yêu cầu không tồn tại hoặc đã done.');
    return ok(res, row, { message: 'Hoàn tất yêu cầu.' });
  }),
};

// ─── 3. Đồng bộ trạng thái orders → guest_orders ───────────────────────────

// Trạng thái order trên POS → trạng thái guest_order khách thấy
const GUEST_STATUS_FROM_ORDER = {
  serving:   { to: 'served',    from: ['confirmed', 'preparing'] },
  completed: { to: 'served',    from: ['confirmed', 'preparing'] },
  cancelled: { to: 'cancelled', from: ['confirmed', 'preparing', 'served'] },
};

/**
 * Gọi sau khi order (POS) đổi trạng thái: cập nhật các guest_order đã ghép vào
 * order đó và push tới khách qua table room. Không throw — lỗi chỉ log để
 * không làm hỏng response của POS (order đã đổi trạng thái thành công).
 */
exports.syncGuestOrdersFromOrder = async (orderId, orderStatus) => {
  const rule = GUEST_STATUS_FROM_ORDER[orderStatus];
  if (!rule) return [];
  try {
    const rows = await db.query(`
      UPDATE guest_orders
         SET status=$2, updated_at=NOW()
       WHERE order_id=$1 AND status = ANY($3::text[])
       RETURNING id, table_code, status
    `, [orderId, rule.to, rule.from]);

    for (const row of rows) {
      realtime.emitToTable(row.table_code, 'order:status', {
        guestOrderId: row.id,
        status: row.status,
      });
    }
    return rows;
  } catch (err) {
    console.error('[qr-sync] Không đồng bộ được guest_orders cho order', orderId, err.message);
    return [];
  }
};
