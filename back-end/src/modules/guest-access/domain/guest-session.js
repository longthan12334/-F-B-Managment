// =============================================================================
//  MODULE guest-access · DOMAIN — Phiên khách & token
// -----------------------------------------------------------------------------
//  Guest token KHÔNG phải JWT nhân viên. Nó là chuỗi ký HMAC gọn nhẹ:
//      <session_id>.<expires_unix>.<chữ ký HMAC-SHA256>
//
//  Vì sao không dùng JWT?
//    • Token này nằm trong localStorage của trình duyệt khách lạ, nên càng ít
//      thông tin càng tốt — JWT mặc định chứa payload đọc được.
//    • Không cần thư viện, không cần thuật toán cấu hình được ⇒ bề mặt tấn
//      công nhỏ hơn (không có bẫy `alg: none`).
//    • Mọi lời gọi đều tra CSDL để xác minh phiên còn sống, nên không cần
//      token tự chứa trạng thái.
// =============================================================================
const crypto = require('crypto');
const { AppError } = require('../../../shared/errors');
const { config } = require('../../../shared/config');

const TOKEN_RE = /^([0-9a-f-]{36})\.(\d{10,13})\.([A-Za-z0-9_-]{20,})$/;

const sign = (data) =>
  crypto.createHmac('sha256', config.guest.secret).update(data).digest('base64url');

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Sinh token cho một phiên. */
function issueToken(sessionId, expiresAt) {
  const exp = Math.floor(new Date(expiresAt).getTime() / 1000);
  const body = `${sessionId}.${exp}`;
  return `${body}.${sign(body)}`;
}

/**
 * Giải mã & kiểm tra chữ ký + hạn của token (chưa tra CSDL).
 * @returns {{ sid: string, exp: number }}
 */
function parseToken(token) {
  const m = TOKEN_RE.exec(String(token || '').trim());
  if (!m) throw AppError.unauthorized('Phiên không hợp lệ, vui lòng quét lại mã QR', 'GUEST_TOKEN_INVALID');

  const [, sid, expStr, signature] = m;
  const expected = sign(`${sid}.${expStr}`);

  // So sánh thời gian hằng định để tránh timing attack
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw AppError.unauthorized('Phiên không hợp lệ, vui lòng quét lại mã QR', 'GUEST_TOKEN_INVALID');
  }

  const exp = Number(expStr);
  if (exp * 1000 < Date.now()) {
    throw AppError.unauthorized('Phiên đã hết hạn, vui lòng quét lại mã QR', 'GUEST_SESSION_EXPIRED');
  }
  return { sid, exp };
}

/** Thời điểm hết hạn của phiên mới. */
const computeExpiry = () =>
  new Date(Date.now() + config.guest.sessionTtlHours * 3600 * 1000);

/** Tên hiển thị: cắt ngắn, loại ký tự điều khiển (khách tự nhập). */
function sanitizeDisplayName(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\u0000-\u001F\u007F<>]/g, '').trim();
  if (!cleaned) return null;
  if (cleaned.length > 40) return cleaned.slice(0, 40);
  return cleaned;
}

/** Số điện thoại Việt Nam (tuỳ chọn). */
function sanitizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (!/^(\+?84|0)\d{8,10}$/.test(digits)) {
    throw AppError.validation('Số điện thoại không hợp lệ', ['phone: ví dụ 0901234567']);
  }
  return digits;
}

function assertSessionUsable(session) {
  if (!session) throw AppError.unauthorized('Phiên không tồn tại, vui lòng quét lại mã QR', 'GUEST_SESSION_INVALID');
  if (session.status === 'blocked') {
    throw AppError.forbidden('Phiên đã bị tạm khoá do gửi quá nhiều yêu cầu. Vui lòng gọi nhân viên.');
  }
  if (session.status !== 'active') {
    throw AppError.unauthorized('Phiên đã kết thúc, vui lòng quét lại mã QR', 'GUEST_SESSION_CLOSED');
  }
  if (new Date(session.expires_at).getTime() < Date.now()) {
    throw AppError.unauthorized('Phiên đã hết hạn, vui lòng quét lại mã QR', 'GUEST_SESSION_EXPIRED');
  }
}

/** Góc nhìn phiên trả cho khách — không lộ token_hash, ip hay user_agent. */
function toGuestView(session) {
  if (!session) return null;
  return {
    session_id: session.id,
    table_code: session.table_code,
    display_name: session.display_name,
    status: session.status,
    started_at: session.started_at,
    expires_at: session.expires_at,
    request_count: session.request_count,
    total_items_count: session.total_items_count,
    total_amount: Number(session.total_amount || 0),
  };
}

/** Góc nhìn cho nhân viên — thêm dấu vết kỹ thuật phục vụ xử lý sự cố. */
function toStaffView(session) {
  if (!session) return null;
  return {
    ...toGuestView(session),
    id: session.id,
    table_id: session.table_id,
    phone: session.phone,
    ip: session.ip,
    user_agent: session.user_agent,
    last_seen_at: session.last_seen_at,
  };
}

module.exports = {
  issueToken, parseToken, hashToken, computeExpiry,
  sanitizeDisplayName, sanitizePhone, assertSessionUsable,
  toGuestView, toStaffView,
};
