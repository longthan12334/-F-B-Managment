import { NavLink, Outlet } from "react-router-dom";
import { useCustomer } from "./CustomerContext";

export default function CustomerLayout() {
  const { session, count, loading, error } = useCustomer();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p>Đang kiểm tra mã QR…</p>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="max-w-lg mx-auto p-6">
        <h1 className="text-xl font-bold mb-3">Chưa thể mở thực đơn</h1>

        <p role="alert" className="text-red-600">
          {error || "Không tìm thấy phiên gọi món."}
        </p>

        <p className="mt-3 text-gray-500">
          Hãy dùng camera điện thoại quét lại mã QR tại bàn.
        </p>
      </div>
    );
  }

  const navClass = ({ isActive }) =>
    isActive ? "font-bold text-primary" : "text-gray-500";

  return (
    <div className="mx-auto max-w-lg min-h-screen pb-24">
      <header className="p-4 border-b bg-white">
        <h1 className="font-bold text-xl">RestoManager</h1>

        <p className="mt-1">
          Bàn <strong>{session.table_code}</strong>
        </p>

        <p className="text-sm text-gray-500 mt-1">Phiên QR demo — thực đơn từ nhà hàng</p>
      </header>

      <main>
        <Outlet />
      </main>

      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t p-4">
        <div className="mx-auto max-w-lg flex justify-around">
          <NavLink to="/customer" end className={navClass}>
            Thực đơn
          </NavLink>

          <NavLink to="/customer/cart" className={navClass}>
            Giỏ món ({count})
          </NavLink>

          <NavLink to="/customer/orders" className={navClass}>
            Đã gửi
          </NavLink>
        </div>
      </nav>
    </div>
  );
}
