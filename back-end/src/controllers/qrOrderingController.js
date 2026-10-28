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

      const { rows: [tbl] } = await client.query(
        'SELECT id FROM tables WHERE code=$1', [go.table_code]);
      if (!tbl) throw ApiError.notFound(`Bàn ${go.table_code} không tồn tại.`);

      await client.query(`
        UPDATE guest_orders
           SET status='confirmed', confirmed_by=$1, confirmed_at=NOW(), updated_at=NOW()
         WHERE id=$2
      `, [userId, id]);

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

      await client.query(`
        INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, price, total_price, notes)
        SELECT $1, menu_item_id, item_name, quantity, price, total_price, notes
          FROM guest_order_items WHERE guest_order_id=$2
      `, [newOrder.id, go.id]);

      return { newOrder, guestOrder: go };
    });

    try {
      // → Staff dashboard (authenticated room)
      realtime.emit('order-updated', {
        orderId: result.newOrder.id, source: 'guest_qr',
        tableCode: result.guestOrder.table_code,
      });
      realtime.emit('guest-order-confirmed', {
        guestOrderId: result.guestOrder.id, status: 'confirmed',
      });

      // ★ Push tới khách qua table room — thay thế polling hoàn toàn
      realtime.emitToTable(result.guestOrder.table_code, 'order:confirmed', {
        guestOrderId: result.guestOrder.id,
        orderId: result.newOrder.id,
        status: 'confirmed',
        message: 'Đơn của bạn đã được xác nhận!',
      });
    } catch (_) { /* ignore */ }

    return ok(res, {
      orderId: result.newOrder.id,
      guestOrderId: result.guestOrder.id,
      code: result.newOrder.code,
    }, { message: 'Đã xác nhận đơn.' });
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
