import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCustomer } from '../CustomerContext';
import { CustomerApi } from '../api/customerApi';

export default function CustomerCart() {
  const { session, cart, setCart, count, total } = useCustomer();
  const navigate = useNavigate();
  const lock = useRef(false);
  const attempt = useRef(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  function editCart(update) {
    attempt.current = null;
    setError('');
    setCart(update);
  }
  function changeQuantity(id, delta) {
    editCart(current => current.map(item => item.menu_item_id === id
      ? { ...item, quantity: item.quantity + delta } : item)
      .filter(item => item.quantity > 0));
  }
  async function send() {
    if (lock.current || !cart.length || !session) return;
    lock.current = true;
    setSending(true);
    setError('');
    try {
      // Giữ mã khi thử lại cùng yêu cầu, kể cả trên HTTP LAN không có randomUUID.
      if (!attempt.current) {
        attempt.current = {
          request_id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
            : Date.now().toString(36) + '-' + Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(36)).join('-'),
          items: cart.map(item => ({ ...item })),
        };
      }
      await CustomerApi.submitOrder(session, attempt.current);
      setCart([]);
      navigate('/customer/orders', { replace: true });
    } catch (err) {
      setError(err.message || 'Gửi thất bại. Giỏ món vẫn được giữ lại.');
    } finally {
      lock.current = false;
      setSending(false);
    }
  }
  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-bold">Giỏ món — Bàn {session?.table_code}</h2>
      <p className="text-sm text-gray-500">Gửi demo chỉ lưu trên trình duyệt này, chưa chuyển đến nhân viên hoặc bếp.</p>
      {cart.length === 0 && <p>Giỏ chưa có món. <Link className="text-primary underline" to="/customer">Chọn món</Link></p>}
      <fieldset disabled={sending} className="space-y-4 disabled:opacity-60">
        {cart.map(item => (
          <article key={item.menu_item_id} className="border rounded-xl p-4 space-y-3">
            <h3 className="font-bold">{item.name}</h3>
            <div className="flex items-center gap-4">
              <button type="button" className="px-3 py-2 border rounded" aria-label={'Giảm ' + item.name}
                onClick={() => changeQuantity(item.menu_item_id, -1)}>−</button>
              <span>{item.quantity}</span>
              <button type="button" className="px-3 py-2 border rounded" aria-label={'Tăng ' + item.name}
                onClick={() => changeQuantity(item.menu_item_id, 1)}>+</button>
              <button type="button" className="text-red-600 underline" onClick={() => editCart(current => current.filter(row => row.menu_item_id !== item.menu_item_id))}>Xóa</button>
            </div>
            <label className="block text-sm">Ghi chú món
              <input className="mt-1 w-full p-2 border rounded" maxLength={300}
                placeholder="Ví dụ: ít đá, không hành" value={item.notes || ''}
                onChange={event => { const notes = event.target.value;
                  editCart(current => current.map(row => row.menu_item_id === item.menu_item_id ? { ...row, notes } : row)); }} />
            </label>
            <p>{(item.price * item.quantity).toLocaleString('vi-VN')}đ</p>
          </article>
        ))}
      </fieldset>
      <p>Số lượng: {count}</p>
      <p className="font-bold">Tạm tính: {total.toLocaleString('vi-VN')}đ</p>
      {error && <p role="alert" className="text-red-600">{error}</p>}
      <button type="button" className="btn-primary w-full disabled:opacity-50" disabled={sending || !cart.length} onClick={send}>
        {sending ? 'Đang gửi…' : 'Gửi gọi món (demo)'}
      </button>
    </div>
  );
}
