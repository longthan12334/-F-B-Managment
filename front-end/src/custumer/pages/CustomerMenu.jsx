import { useEffect, useState } from 'react';
import { CustomerApi } from '../api/customerApi';
import { useCustomer } from '../CustomerContext';

export default function CustomerMenu() {
  const { cart, setCart } = useCustomer();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    CustomerApi.getMenu()
      .then(data => { if (active) setItems(data.items); })
      .catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  function addItem(item) {
    setCart(current => current.some(row => row.menu_item_id === item.id)
      ? current.map(row => row.menu_item_id === item.id
        ? { ...row, quantity: row.quantity + 1 } : row)
      : [...current, { menu_item_id: item.id, name: item.name,
          price: Number(item.price), quantity: 1, notes: '' }]);
  }

  if (loading) return <p className="p-4">Đang tải thực đơn…</p>;
  if (error) return <p role="alert" className="p-4 text-red-600">{error}</p>;
  return (
    <div className="p-4 space-y-3">
      <p className="text-sm text-gray-500">Thực đơn từ nhà hàng. Gửi và theo dõi order hiện dùng bản demo trên trình duyệt.</p>
      <h2 className="text-xl font-bold">Thực đơn</h2>
      {items.filter(item => item.is_active).length === 0 && (
        <p>Hiện chưa có món đang bán.</p>
      )}
      {items.filter(item => item.is_active).map(item => (
        <article key={item.id} className="border rounded-xl p-4 space-y-2">
          <h3 className="font-bold">{item.name}</h3>
          <p>{item.description}</p>
          <p>{Number(item.price).toLocaleString('vi-VN')}đ</p>
          <button className="btn-primary" onClick={() => addItem(item)}>
            Thêm vào giỏ ({cart.find(row => row.menu_item_id === item.id)?.quantity || 0})
          </button>
        </article>
      ))}
    </div>
  );
}
