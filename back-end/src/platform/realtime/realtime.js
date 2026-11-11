// =============================================================================
//  PLATFORM — Lớp thời gian thực (Socket.IO)
// -----------------------------------------------------------------------------
//  Đây là hạ tầng, KHÔNG phải module nghiệp vụ: nó không biết "đơn hàng" hay
//  "hoá đơn" là gì, chỉ biết phát gói tin tới đúng phòng (room).
//
//  Phân vùng phòng:
//    staff            — mọi nhân viên đã đăng nhập (đơn hàng, bàn, hoá đơn)
//    role:<role>      — riêng theo vai trò (admin / cashier / waiter)
//    guest:<sid>      — RIÊNG cho một phiên khách quét QR; khách chỉ nhận
//                       thông tin đơn của chính bàn mình, không thấy doanh thu
//                       hay đơn của bàn khác.
//
//  Khách KHÔNG có JWT nhân viên: họ xác thực bằng guest token (chữ ký HMAC do
//  module guest-access phát hành). Hàm xác thực được tiêm vào từ ngoài để
//  platform không phụ thuộc ngược vào module nghiệp vụ.
// =============================================================================
const { Server } = require('socket.io');
const { config } = require('../../shared/config');
const log = require('../../shared/logger').child('realtime');

let io = null;
/** @type {{verifyStaffToken?:Function, verifyGuestToken?:Function}} */
let verifiers = {};

/**
 * Cùng quy tắc với HTTP (xem platform/http/security.js): danh sách trắng,
 * cộng thêm request cùng nguồn — để ứng dụng chạy được cả khi truy cập bằng
 * IP hay tên máy khác với tên đã khai báo.
 */
function isOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                        // app native, server-to-server

  const list = config.http.allowedOrigins;
  if (list.includes(origin)) return true;

  // Cùng nguồn với chính máy chủ đang phục vụ → luôn cho phép
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (host) {
    try {
      if (new URL(origin).host.toLowerCase() === String(host).toLowerCase()) return true;
    } catch { /* origin không phải URL hợp lệ */ }
  }

  if (list.length === 0) return !config.isProd;    // chưa cấu hình: chỉ chấp nhận ngoài production
  return false;
}

/**
 * @param {import('http').Server} httpServer
 * @param {{verifyStaffToken:Function, verifyGuestToken:Function}} tokenVerifiers
 */
function init(httpServer, tokenVerifiers = {}) {
  if (io) return io;
  verifiers = tokenVerifiers;

  io = new Server(httpServer, {
    // `origin: true` phản chiếu lại Origin của request; chính sách thật nằm ở
    // `allowRequest` bên dưới — nơi duy nhất nhìn thấy đầy đủ request.
    cors: { origin: true, credentials: true },
    allowRequest: (req, cb) => {
      if (isOriginAllowed(req)) return cb(null, true);
      log.warn(`Từ chối kết nối WebSocket từ origin: ${req.headers.origin}`);
      return cb('CORS_FORBIDDEN', false);
    },
    transports: ['websocket', 'polling'],
    path: '/socket.io',
    pingTimeout: 25000,
  });

  io.use((socket, next) => {
    const auth = socket.handshake.auth || {};
    const q = socket.handshake.query || {};

    // 1) Khách quét QR
    const guestToken = auth.guestToken || q.guestToken;
    if (guestToken) {
      try {
        const session = verifiers.verifyGuestToken?.(guestToken);
        if (!session) return next(new Error('UNAUTHORIZED: guest token không hợp lệ'));
        socket.data.kind = 'guest';
        socket.data.guestSessionId = session.sid;
        socket.data.tableCode = session.table_code;
        return next();
      } catch (err) {
        return next(new Error(`UNAUTHORIZED: ${err.message}`));
      }
    }

    // 2) Nhân viên
    const token = auth.token || q.token;
    if (!token) return next(new Error('UNAUTHORIZED: thiếu token'));
    try {
      const user = verifiers.verifyStaffToken?.(token);
      if (!user || !user.role) return next(new Error('UNAUTHORIZED: token không hợp lệ'));
      socket.data.kind = 'staff';
      socket.data.user = user;
      return next();
    } catch (err) {
      return next(new Error(`UNAUTHORIZED: ${err.message}`));
    }
  });

  io.on('connection', (socket) => {
    if (socket.data.kind === 'guest') {
      socket.join(`guest:${socket.data.guestSessionId}`);
      socket.emit('hello', { kind: 'guest', table_code: socket.data.tableCode, at: new Date().toISOString() });
    } else {
      const u = socket.data.user;
      socket.join('staff');
      socket.join(`role:${u.role}`);
      socket.emit('hello', { kind: 'staff', user: { id: u.id, role: u.role }, at: new Date().toISOString() });
    }

    socket.on('ping:rt', () => socket.emit('pong:rt', { at: Date.now() }));

    if (!config.isProd) {
      log.debug(`kết nối ${socket.id} (${socket.data.kind})`);
      socket.on('disconnect', (reason) => log.debug(`ngắt ${socket.id}: ${reason}`));
    }
  });

  log.info('Socket.IO đã khởi động trên /socket.io');
  return io;
}

const stamp = (payload) => ({ ...(payload || {}), at: new Date().toISOString() });

/** Phát tới toàn bộ nhân viên đã đăng nhập. */
function toStaff(event, payload) {
  io?.to('staff').emit(event, stamp(payload));
}

/** Phát tới một vai trò cụ thể. */
function toRole(role, event, payload) {
  io?.to(`role:${role}`).emit(event, stamp(payload));
}

/** Phát riêng cho một phiên khách quét QR. */
function toGuest(sessionId, event, payload) {
  if (!sessionId) return;
  io?.to(`guest:${sessionId}`).emit(event, stamp(payload));
}

function stats() {
  if (!io) return { connected: 0 };
  return {
    connected: io.engine?.clientsCount ?? 0,
    rooms: io.sockets.adapter.rooms.size,
  };
}

async function close() {
  if (!io) return;
  await new Promise((resolve) => io.close(resolve));
  io = null;
}

module.exports = { init, toStaff, toRole, toGuest, stats, close, getIO: () => io };
