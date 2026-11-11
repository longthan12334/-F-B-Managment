// =============================================================================
//  MODULE guest-access · APPLICATION — Phiên khách quét QR
// =============================================================================
const db = require('../../../platform/database/pool');
const repo = require('../infrastructure/guest-repository');
const dining = require('../../dining/contract');
const domain = require('../domain/guest-session');
const { AppError } = require('../../../shared/errors');
const { config } = require('../../../shared/config');
const EVENTS = require('../../../platform/events/event-names');
const bus = require('../../../platform/events/event-bus');

/** Tra bàn từ tham số trên URL mã QR và kiểm tra bàn còn nhận khách. */
async function resolveTableFromQr(qrKey) {
  const key = String(qrKey || '').trim();
  if (!key || key.length > 64) throw AppError.notFound('Mã QR không hợp lệ');

  const table = await dining.findByQrKey(key);
  if (!table) throw AppError.notFound('Không tìm thấy bàn tương ứng với mã QR này');
  if (table.is_active === false) {
    throw new AppError(`Bàn ${table.code} đang tạm ngưng phục vụ, vui lòng gọi nhân viên`, {
      status: 409, code: 'TABLE_INACTIVE',
    });
  }
  return table;
}

/**
 * Bắt đầu (hoặc tiếp tục) một phiên khách.
 *
 * Quy tắc "một thiết bị – một phiên": nếu khách gửi kèm token cũ còn hiệu lực
 * và đúng bàn thì DÙNG LẠI phiên đó để lịch sử không bị chia nhỏ khi họ tải
 * lại trang. Chỉ cấp phiên mới khi không có token hoặc token đã hết hiệu lực.
 */
async function startSession({ qrKey, existingToken, displayName, phone, meta = {} }) {
  const table = await resolveTableFromQr(qrKey);

  if (existingToken) {
    const resumed = await tryResume(existingToken, table.id);
    if (resumed) return { ...resumed, resumed: true, table };
  }

  const display_name = domain.sanitizeDisplayName(displayName);
  const sanitizedPhone = phone ? domain.sanitizePhone(phone) : null;
  const expires_at = domain.computeExpiry();

  // Token được sinh TỪ id của phiên, mà id chỉ có sau khi INSERT.
  // Giải pháp: chèn với hash tạm, lấy id, ký token thật rồi cập nhật hash —
  // tất cả trong một transaction nên không bao giờ tồn tại phiên hash tạm.
  const { session, token } = await db.transaction(async (client) => {
    const placeholder = domain.hashToken(`pending:${Date.now()}:${Math.random()}`);
    const row = await repo.createSession({
      table_id: table.id,
      table_code: table.code,
      token_hash: placeholder,
      display_name,
      phone: sanitizedPhone,
      user_agent: meta.userAgent,
      ip: meta.ip,
      expires_at,
    }, client);

    const issued = domain.issueToken(row.id, expires_at);
    const updated = await client.query(
      'UPDATE guest_sessions SET token_hash = $2 WHERE id = $1 RETURNING *',
      [row.id, domain.hashToken(issued)]
    );
    return { session: updated.rows[0], token: issued };
  });

  bus.publish(EVENTS.GUEST_SESSION_STARTED, {
    session_id: session.id,
    table_id: table.id,
    table_code: table.code,
    display_name: session.display_name,
  });

  return {
    token,
    session: domain.toGuestView(session),
    table: { code: table.code, zone: table.zone, zone_name: table.zone_name },
    expires_in: config.guest.sessionTtlHours * 3600,
    resumed: false,
  };
}

/** Thử tiếp tục phiên cũ; trả null nếu không dùng lại được. */
async function tryResume(token, expectedTableId = null) {
  let parsed;
  try {
    parsed = domain.parseToken(token);
  } catch {
    return null;
  }
  const session = await repo.findSessionByTokenHash(domain.hashToken(token));
  if (!session || session.id !== parsed.sid) return null;
  if (session.status !== 'active' || new Date(session.expires_at).getTime() < Date.now()) return null;
  if (expectedTableId && session.table_id !== expectedTableId) return null;

  await repo.touchSession(session.id);
  return {
    token,
    session: domain.toGuestView(session),
    table: { code: session.table_code },
    expires_in: Math.max(0, Math.floor((new Date(session.expires_at).getTime() - Date.now()) / 1000)),
  };
}

/**
 * Xác thực guest token cho mọi lời gọi tiếp theo.
 * Hai lớp kiểm tra: chữ ký HMAC (rẻ, chặn token giả) → tra CSDL (chắc chắn,
 * bắt được phiên đã bị đóng hoặc chặn).
 */
async function authenticate(token) {
  const parsed = domain.parseToken(token);
  const session = await repo.findSessionByTokenHash(domain.hashToken(token));
  if (!session || session.id !== parsed.sid) {
    throw AppError.unauthorized('Phiên không hợp lệ, vui lòng quét lại mã QR', 'GUEST_SESSION_INVALID');
  }
  domain.assertSessionUsable(session);
  repo.touchSession(session.id).catch(() => {});
  return session;
}

/** Xác minh đồng bộ cho WebSocket (chỉ chữ ký, không tra CSDL). */
function verifyTokenForSocket(token) {
  const parsed = domain.parseToken(token);
  return { sid: parsed.sid };
}

async function updateProfile(session, { display_name, phone }) {
  const updated = await repo.updateSessionProfile(session.id, {
    display_name: domain.sanitizeDisplayName(display_name),
    phone: phone ? domain.sanitizePhone(phone) : null,
  });
  return domain.toGuestView(updated);
}

async function closeSession(session, reason = 'GUEST_CLOSED') {
  const closed = await repo.closeSession(session.id, { reason });
  if (closed) {
    bus.publish(EVENTS.GUEST_SESSION_CLOSED, {
      session_id: session.id, table_id: session.table_id, table_code: session.table_code, reason,
    });
  }
  return domain.toGuestView(closed || session);
}

/** Đóng mọi phiên của một bàn — gọi khi thanh toán xong hoặc dọn bàn. */
async function closeSessionsForTable(tableId, reason) {
  const closed = await repo.closeSessionsForTable(tableId, reason);
  for (const s of closed) {
    bus.publish(EVENTS.GUEST_SESSION_CLOSED, {
      session_id: s.id, table_id: tableId, table_code: s.table_code, reason,
    });
  }
  return closed.length;
}

/** Danh sách phiên đang mở của một bàn — cho màn hình nhân viên. */
async function listSessionsForTable(tableId) {
  const rows = await repo.listSessionsForTable(tableId, { activeOnly: false });
  return rows.map(domain.toStaffView);
}

module.exports = {
  resolveTableFromQr, startSession, tryResume, authenticate, verifyTokenForSocket,
  updateProfile, closeSession, closeSessionsForTable, listSessionsForTable,
};
