// =============================================================================
//  staffCallController.js (BE-2)
//  Staff xem và tiếp nhận yêu cầu "gọi nhân viên" từ khách (bàn QR).
// =============================================================================

const { ok, ApiError, asyncHandler } = require('../utils/response');
const db = require('../database/db');
const realtime = require('../realtime/io');

exports.listPending = asyncHandler(async (_req, res) => {
  const rows = await db.query(`
    SELECT id, table_session_id, table_code, reason, created_at
      FROM staff_calls
     WHERE status='pending'
     ORDER BY created_at ASC
  `);
  return ok(res, rows);
});

exports.acknowledge = asyncHandler(async (req, res) => {
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
});

exports.markDone = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const row = await db.queryOne(`
    UPDATE staff_calls SET status='done'
     WHERE id=$1 AND status IN ('pending','acknowledged')
     RETURNING id, status, table_code
  `, [id]);
  if (!row) throw ApiError.notFound('Yêu cầu không tồn tại hoặc đã done.');
  return ok(res, row, { message: 'Hoàn tất yêu cầu.' });
});
