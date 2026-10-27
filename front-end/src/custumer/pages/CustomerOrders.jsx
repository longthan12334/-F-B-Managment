import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCustomer } from '../CustomerContext';
import { CustomerApi } from '../api/customerApi';

const labels = {
  awaiting_confirmation: 'Chờ nhân viên xác nhận', confirmed: 'Đã xác nhận',
  preparing: 'Đang chuẩn bị', served: 'Đã phục vụ', rejected: 'Đã từ chối',
};
const nextLabels = {
  awaiting_confirmation: 'Giả lập nhân viên xác nhận',
  confirmed: 'Giả lập bếp bắt đầu làm', preparing: 'Giả lập đã phục vụ',
};
const time = value => new Date(value).toLocaleString('vi-VN');

export default function CustomerOrders() {
  const { session } = useCustomer();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sessionId = session?.session_id;
  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      setOrders(await CustomerApi.getOrders(sessionId));
      setError('');
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [sessionId]);

  useEffect(() => {
    load();
    function onStorage(event) {
      if (event.key === 'customer-orders:' + sessionId || event.key === null) load();
    }
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', load);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', load);
    };
  }, [load, sessionId]);

  async function advance(id, reject = false) {
    if (busy) return;
    setBusy(true);
    try {
      await CustomerApi.advanceDemoOrder(sessionId, id, reject);
      await load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-bold">Đơn đã gửi — Bàn {session?.table_code}</h2>
      <p className="text-sm text-gray-500">Theo dõi demo theo từng yêu cầu. Dữ liệu chỉ có trên trình duyệt này; các nút giả lập bên dưới không phải xác nhận thật của nhà hàng.</p>
      <div className="flex justify-between items-center">
        <Link className="text-primary underline" to="/customer">Gọi thêm món</Link>
        <button className="px-3 py-2 border rounded" disabled={busy} onClick={load}>Làm mới</button>
      </div>
      {error && <p role="alert" className="text-red-600">{error}</p>}
      {loading ? <p>Đang tải yêu cầu…</p> : !error && orders.length === 0 && <p>Chưa có yêu cầu nào. Hãy chọn món và gửi từ giỏ.</p>}
      {orders.map(order => (
        <article key={order.id} className="border rounded-xl p-4 space-y-3">
          <h3 className="font-bold">{order.code}</h3>
          <p className="font-semibold text-primary" aria-live="polite">{labels[order.status] || order.status}</p>
          <p className="text-sm text-gray-500">Gửi lúc: {time(order.created_at)}</p>
          <ul className="space-y-2">
            {order.items.map((item, index) => (
              <li key={index}>
                <div className="flex justify-between gap-3"><span>{item.quantity} × {item.item_name}</span><span>{(item.price * item.quantity).toLocaleString('vi-VN')}đ</span></div>
                {item.notes && <p className="text-sm text-gray-500">Ghi chú: {item.notes}</p>}
              </li>
            ))}
          </ul>
          <p className="font-bold">Tạm tính: {order.total_amount.toLocaleString('vi-VN')}đ</p>
          <details>
            <summary className="cursor-pointer">Lịch sử trạng thái</summary>
            <ul className="mt-2 space-y-1 text-sm">{order.history.map((entry, index) => <li key={index}>{time(entry.at)} — {labels[entry.status] || entry.status}</li>)}</ul>
          </details>
          {nextLabels[order.status] && (
            <div className="border-t pt-3 space-y-2">
              <p className="text-xs text-gray-500">Công cụ thử trạng thái của bản demo</p>
              <button className="btn-primary w-full disabled:opacity-50" disabled={busy} onClick={() => advance(order.id)}>{nextLabels[order.status]}</button>
              {order.status === 'awaiting_confirmation' && <button className="w-full p-2 border rounded text-red-600" disabled={busy} onClick={() => advance(order.id, true)}>Giả lập từ chối</button>}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
