// Order demo chỉ lưu trong trình duyệt, không tạo đơn ở backend.
const statuses = ['awaiting_confirmation', 'confirmed', 'preparing', 'served'];
function key(sessionId) {
  if (!sessionId) throw new Error('Không tìm thấy phiên bàn.');
  return 'customer-orders:' + sessionId;
}
function read(sessionId) {
  const rows = JSON.parse(localStorage.getItem(key(sessionId)) || '[]');
  if (!Array.isArray(rows)) throw new Error('Dữ liệu yêu cầu đã lưu không hợp lệ.');
  return rows;
}
function save(sessionId, rows) {
  try { localStorage.setItem(key(sessionId), JSON.stringify(rows)); }
  catch { throw new Error('Không lưu được yêu cầu. Kiểm tra quyền lưu trữ của trình duyệt rồi thử lại.'); }
}
export const demoOrderApi = {
  async submitOrder(session, payload) {
    const rows = read(session.session_id);
    if (!payload.request_id) throw new Error('Thiếu mã chống gửi trùng.');
    const existing = rows.find(row => row.request_id === payload.request_id);
    if (existing) return existing;
    if (!Array.isArray(payload.items) || !payload.items.length) throw new Error('Giỏ chưa có món.');
    const items = payload.items.map(item => {
      if (!item.menu_item_id || !Number.isInteger(item.quantity) || item.quantity < 1 ||
          !Number.isFinite(Number(item.price)) || Number(item.price) < 0) {
        throw new Error('Món hoặc số lượng trong giỏ không hợp lệ.');
      }
      return { menu_item_id: item.menu_item_id, item_name: item.name,
        quantity: item.quantity, price: Number(item.price), notes: (item.notes || '').trim() };
    });
    const now = new Date().toISOString();
    const order = { id: payload.request_id, request_id: payload.request_id,
      code: 'DEMO-' + payload.request_id.slice(-8).toUpperCase(),
      table_code: session.table_code, items,
      total_amount: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
      status: statuses[0], created_at: now, updated_at: now,
      history: [{ status: statuses[0], at: now }] };
    save(session.session_id, [order, ...rows]);
    return order;
  },
  async getOrders(sessionId) { return read(sessionId); },
  async advanceDemoOrder(sessionId, orderId, reject = false) {
    const rows = read(sessionId);
    const order = rows.find(row => row.id === orderId);
    if (!order) throw new Error('Không tìm thấy yêu cầu.');
    if (order.status === 'rejected' || order.status === 'served') return order;
    if (reject && order.status !== statuses[0]) throw new Error('Chỉ từ chối yêu cầu đang chờ xác nhận.');
    const next = reject ? 'rejected' : statuses[statuses.indexOf(order.status) + 1];
    if (!next) throw new Error('Trạng thái không hợp lệ.');
    order.status = next;
    order.updated_at = new Date().toISOString();
    order.history.push({ status: next, at: order.updated_at });
    save(sessionId, rows);
    return order;
  },
};
