import {
  createContext,
  useContext,
  useEffect,
  useState,
} from 'react';
import { useLocation } from 'react-router-dom';
import { CustomerApi } from './api/customerApi';

const CustomerContext = createContext(null);
const QR_STORAGE_KEY = 'customer-demo-qr';

function readSavedQr() {
  try {
    return sessionStorage.getItem(QR_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readCart(sessionId) {
  try {
    const saved = JSON.parse(
      localStorage.getItem(`customer-cart:${sessionId}`) || '[]'
    );

    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

export function CustomerProvider({ children }) {
  const location = useLocation();

  const [session, setSession] = useState(null);
  const [cart, setCart] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      setLoading(true);
      setError('');

      const params = new URLSearchParams(location.search);

      // Nếu URL có qr thì ưu tiên mã trên URL.
      // Nếu không có, dùng mã đã lưu trong tab hiện tại.
      const qr = params.has('qr')
        ? params.get('qr')
        : readSavedQr();

      if (!qr) {
        if (!cancelled) {
          setSession(null);
          setCart([]);
          setError('Vui lòng quét mã QR tại bàn để bắt đầu.');
          setLoading(false);
        }
        return;
      }

      try {
        const nextSession = await CustomerApi.resolveSession(qr);

        if (cancelled) return;

        // Nạp đúng giỏ của phiên trước khi cho phép tự lưu.
        setCart(readCart(nextSession.session_id));
        setSession(nextSession);

        try {
          sessionStorage.setItem(QR_STORAGE_KEY, qr);
        } catch {
          // Vẫn dùng được trong lần mở hiện tại nếu không lưu được.
        }
      } catch (err) {
        if (cancelled) return;

        setSession(null);
        setCart([]);
        setError(err.message || 'Không thể mở phiên gọi món.');

        try {
          sessionStorage.removeItem(QR_STORAGE_KEY);
        } catch {
          // Không cần xử lý thêm.
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    initialize();

    return () => {
      cancelled = true;
    };
  }, [location.search]);

  useEffect(() => {
    // Không ghi giỏ rỗng đè lên giỏ cũ trong lúc đang nạp phiên.
    if (loading || !session) return;

    try {
      localStorage.setItem(
        `customer-cart:${session.session_id}`,
        JSON.stringify(cart)
      );
    } catch {
      // Giỏ vẫn hoạt động trong bộ nhớ nếu trình duyệt không cho lưu.
    }
  }, [cart, session, loading]);

  const count = cart.reduce(
    (sum, item) => sum + item.quantity,
    0
  );

  const total = cart.reduce(
    (sum, item) => sum + Number(item.price) * item.quantity,
    0
  );

  return (
    <CustomerContext.Provider
      value={{
        session,
        cart,
        setCart,
        count,
        total,
        loading,
        error,
      }}
    >
      {children}
    </CustomerContext.Provider>
  );
}

export function useCustomer() {
  const context = useContext(CustomerContext);

  if (!context) {
    throw new Error('useCustomer phải nằm trong CustomerProvider');
  }

  return context;
}
