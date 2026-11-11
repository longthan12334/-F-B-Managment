// =============================================================================
//  GuestApi — API cho khách quét mã QR tại bàn
// -----------------------------------------------------------------------------
//  Khác hoàn toàn với api/client.js (dành cho nhân viên):
//    • Không có JWT, không refresh token.
//    • Dùng "guest token" lưu trong localStorage, gửi qua header X-Guest-Token.
//    • Token gắn với MỘT bàn và tự hết hạn (mặc định 6 giờ).
//
//  Vì sao lưu token theo từng bàn (khoá `rm_guest_<qrKey>`)?
//  Khách có thể quét bàn khác trong cùng chuyến (đổi bàn, đi cùng nhóm khác).
//  Lưu riêng từng bàn thì mở lại link bàn cũ vẫn thấy đúng lịch sử của bàn đó.
// =============================================================================
const BASE = '/api/public';

const keyFor = (qrKey) => `rm_guest_${qrKey}`;

export const guestSession = {
  get(qrKey) {
    try { return localStorage.getItem(keyFor(qrKey)); } catch { return null; }
  },
  set(qrKey, token) {
    try {
      if (token) localStorage.setItem(keyFor(qrKey), token);
      else localStorage.removeItem(keyFor(qrKey));
    } catch { /* trình duyệt chặn localStorage (chế độ riêng tư) */ }
  },
  clear(qrKey) { this.set(qrKey, null); },
};

async function call(path, { method = 'GET', body, token } = {}) {
  const opts = { method, headers: {} };
  if (token) opts.headers['X-Guest-Token'] = token;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  let res; let text;
  try {
    res = await fetch(BASE + path, opts);
    text = await res.text();
  } catch {
    const err = new Error('Không kết nối được máy chủ. Kiểm tra sóng Wi-Fi/4G rồi thử lại.');
    err.code = 'NETWORK_ERROR';
    throw err;
  }

  let json;
  try { json = text ? JSON.parse(text) : {}; }
  catch { json = { success: false, message: `HTTP ${res.status}` }; }

  if (!res.ok || json.success === false) {
    const err = new Error(json?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = json?.error?.code || `HTTP_${res.status}`;
    err.details = json?.error?.details;
    throw err;
  }
  return json.data;
}

/** Mã lỗi nghĩa là phiên không dùng được nữa → cần quét lại mã QR. */
export const SESSION_DEAD_CODES = [
  'GUEST_TOKEN_MISSING', 'GUEST_TOKEN_INVALID', 'GUEST_SESSION_INVALID',
  'GUEST_SESSION_EXPIRED', 'GUEST_SESSION_CLOSED',
];

export const isSessionDead = (err) => SESSION_DEAD_CODES.includes(err?.code);

export const GuestApi = {
  /** Thông tin bàn từ mã QR — gọi được trước khi mở phiên. */
  table: (qrKey) => call(`/table/${encodeURIComponent(qrKey)}`),

  /**
   * Mở phiên gọi món (hoặc tiếp tục phiên cũ nếu token còn hiệu lực).
   * @returns {Promise<{token:string, session:object, table:object, resumed:boolean}>}
   */
  startSession: (qrKey, { displayName, phone, existingToken } = {}) =>
    call(`/session/${encodeURIComponent(qrKey)}`, {
      method: 'POST',
      token: existingToken,
      body: { display_name: displayName, phone },
    }),

  /** Thực đơn (chỉ món đang bán). */
  menu: (token) => call('/menu', { token }),

  /** Gửi món. items = [{ menu_item_id, quantity, notes? }] */
  submitOrder: (token, items, note) =>
    call('/orders', { method: 'POST', token, body: { items, note } }),

  /** LỊCH SỬ ĐẶT MÓN — màn hình "Đơn của tôi". */
  history: (token) => call('/orders', { token }),

  /** Cập nhật tên hiển thị. */
  updateProfile: (token, { displayName, phone }) =>
    call('/session', { method: 'PUT', token, body: { display_name: displayName, phone } }),

  /** Khách chủ động kết thúc phiên. */
  closeSession: (token) => call('/session/close', { method: 'POST', token }),
};

export const fmtVnd = (n) =>
  `${new Intl.NumberFormat('vi-VN').format(Math.round(Number(n) || 0))}₫`;

// Tương thích ngược với mã cũ trong dự án
export const PublicApi = GuestApi;
