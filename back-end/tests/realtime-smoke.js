// Verify realtime end-to-end directly against the backend (no proxy in between)
const { io } = require('socket.io-client');
const API = 'http://127.0.0.1:3000';
const api = async (m, p, o = {}) => {
  const r = await fetch(API + p, { method: m,
    headers: { 'Content-Type': 'application/json',
      ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}),
      ...(o.guestToken ? { 'X-Guest-Token': o.guestToken } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, body: await r.json() };
};

(async () => {
  const results = [];
  const ok = (n, c) => { results.push([n, c]); console.log((c ? '  ✓ ' : '  ✗ ') + n); };

  const admin = (await api('POST', '/api/auth/login', { body: { username:'admin', password:'123' } })).body.data;
  const tables = (await api('GET', '/api/tables?with_status=true', { token: admin.token })).body.data;
  const free = tables.find(t => t.state === 'empty' && t.is_active);

  // Staff socket
  const staffEvents = [];
  const staffSock = io(API, { transports:['websocket'], auth:{ token: admin.token } });
  await new Promise((res, rej) => { staffSock.on('connect', res); staffSock.on('connect_error', rej); });
  ok('Nhân viên kết nối WebSocket bằng JWT', staffSock.connected);
  ['order:created','orders:changed','tables:changed','guest:request-pending','invoice:created','stats:changed']
    .forEach(e => staffSock.on(e, p => staffEvents.push([e, p])));

  // Guest session + socket
  const session = (await api('POST', `/api/public/session/${free.qr_slug}`, { body:{ display_name:'Chị Lan' } })).body.data;
  const guestEvents = [];
  const guestSock = io(API, { transports:['websocket'], auth:{ guestToken: session.token } });
  await new Promise((res, rej) => { guestSock.on('connect', res); guestSock.on('connect_error', rej); });
  ok('Khách kết nối WebSocket bằng guest token', guestSock.connected);
  ['guest:request-reviewed','guest:session-closed','invoice:paid']
    .forEach(e => guestSock.on(e, p => guestEvents.push([e, p])));

  // Reject unauthenticated socket
  const anon = io(API, { transports:['websocket'] });
  const anonErr = await new Promise(res => { anon.on('connect', () => res(null)); anon.on('connect_error', e => res(e.message)); });
  ok('Kết nối WebSocket không token bị từ chối', Boolean(anonErr));
  anon.close();

  // Guest orders
  const menu = (await api('GET', '/api/public/menu', { guestToken: session.token })).body.data;
  const sub = await api('POST', '/api/public/orders', { guestToken: session.token,
    body: { items: [{ menu_item_id: menu.items[0].id, quantity: 2 }] } });
  await new Promise(r => setTimeout(r, 700));
  ok('Nhân viên nhận sự kiện khách gọi món (guest:request-pending)',
      staffEvents.some(([e]) => e === 'guest:request-pending'));
  ok('Nhân viên nhận sự kiện bàn đổi trạng thái (tables:changed)',
      staffEvents.some(([e]) => e === 'tables:changed'));

  // Approve → guest must be notified
  await api('POST', `/api/orders/guest-requests/${sub.body.data.request_id}/review`,
    { token: admin.token, body: { approve: true } });
  await new Promise(r => setTimeout(r, 900));
  const reviewed = guestEvents.find(([e]) => e === 'guest:request-reviewed');
  ok('Khách nhận được kết quả duyệt theo thời gian thực', Boolean(reviewed));
  ok('Sự kiện mang đúng trạng thái "confirmed"', reviewed?.[1]?.status === 'confirmed');

  // Checkout → guest session closed event
  const order = (await api('GET', `/api/orders/by-table/${free.id}`, { token: admin.token })).body.data;
  await api('POST', '/api/invoices', { token: admin.token,
    body: { order_id: order.id, cashier_name:'Admin', payment_method:'cash' } });
  await new Promise(r => setTimeout(r, 1200));
  ok('Nhân viên nhận sự kiện hoá đơn mới', staffEvents.some(([e]) => e === 'invoice:created'));
  ok('Dashboard nhận sự kiện cập nhật thống kê', staffEvents.some(([e]) => e === 'stats:changed'));
  ok('Khách được báo phiên đã kết thúc', guestEvents.some(([e]) => e === 'guest:session-closed'));

  staffSock.close(); guestSock.close();
  const failed = results.filter(([, c]) => !c);
  console.log(failed.length ? `\n✗ ${failed.length} lỗi` : `\n✓ Tất cả ${results.length} kiểm thử realtime đạt`);
  process.exit(failed.length ? 1 : 0);
})();
