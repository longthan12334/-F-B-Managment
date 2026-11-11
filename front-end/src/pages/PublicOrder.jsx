// =============================================================================
//  Trang khách quét mã QR — /order/:qrKey
// -----------------------------------------------------------------------------
//  Ba màn hình trong một trang, chuyển bằng tab dưới cùng (giống app di động):
//
//    1. THỰC ĐƠN  — chọn món, thêm vào giỏ
//    2. GIỎ HÀNG  — xem lại, ghi chú, gửi cho nhà hàng
//    3. ĐƠN CỦA TÔI — LỊCH SỬ ĐẶT MÓN kèm trạng thái xác nhận từng món
//                     (đây là phần giảng viên nhận xét còn thiếu)
//
//  Luồng phiên:
//    Mở trang → có token cũ còn hiệu lực? → dùng lại, hiện ngay lịch sử
//                                        → không: hiện màn hình chào, khách
//                                          bấm "Bắt đầu gọi món" để mở phiên
//
//  Thời gian thực: khách kết nối Socket.IO bằng guest token, vào phòng riêng
//  `guest:<sid>`. Khi nhân viên duyệt/từ chối, trạng thái tự đổi không cần
//  tải lại trang.
// =============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import {
  UtensilsCrossed, ShoppingCart, ReceiptText, Plus, Minus, Search,
  CheckCircle2, XCircle, Clock3, Send, RefreshCw, AlertTriangle, ChefHat, QrCode,
} from 'lucide-react';
import { GuestApi, guestSession, isSessionDead, fmtVnd } from '../api/public';

// ─── Nhãn trạng thái từng món ───────────────────────────────────────────────
const ITEM_STATUS = {
  pending_confirm: { label: 'Chờ xác nhận', cls: 'bg-amber-100 text-amber-800',    Icon: Clock3 },
  confirmed:       { label: 'Đã xác nhận',  cls: 'bg-emerald-100 text-emerald-800', Icon: CheckCircle2 },
  served:          { label: 'Đã phục vụ',   cls: 'bg-teal-100 text-teal-800',       Icon: ChefHat },
  rejected:        { label: 'Hết món',      cls: 'bg-red-100 text-red-700',         Icon: XCircle },
  cancelled:       { label: 'Đã huỷ',       cls: 'bg-slate-200 text-slate-600',     Icon: XCircle },
};

const REQUEST_STATUS = {
  pending:             'bg-amber-100 text-amber-800',
  confirmed:           'bg-emerald-100 text-emerald-800',
  partially_confirmed: 'bg-sky-100 text-sky-800',
  rejected:            'bg-red-100 text-red-700',
  cancelled:           'bg-slate-200 text-slate-600',
};

// ─── Thành phần nhỏ ─────────────────────────────────────────────────────────
function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(onClose, toast.type === 'error' ? 5000 : 3000);
    return () => clearTimeout(t);
  }, [toast, onClose]);

  if (!toast) return null;
  const tone = toast.type === 'error'
    ? 'bg-danger text-white'
    : toast.type === 'warn' ? 'bg-amber-500 text-white' : 'bg-primary text-white';
  return (
    <div className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-3 pointer-events-none">
      <div className={`${tone} max-w-md w-full rounded-xl px-4 py-3 shadow-card text-sm font-medium animate-pop-in`}>
        {toast.message}
      </div>
    </div>
  );
}

function Spinner({ label = 'Đang tải…' }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted">
      <RefreshCw size={28} className="animate-spin" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

function ItemStatusChip({ status }) {
  const s = ITEM_STATUS[status] || ITEM_STATUS.pending_confirm;
  const { Icon } = s;
  return (
    <span className={`${s.cls} inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold`}>
      <Icon size={12} /> {s.label}
    </span>
  );
}

// =============================================================================
export default function PublicOrder() {
  const { tableCode, qrKey: qrKeyParam } = useParams();
  const qrKey = qrKeyParam || tableCode; // tương thích đường dẫn cũ /order/:tableCode

  const [token, setToken] = useState(() => guestSession.get(qrKey));
  const [table, setTable] = useState(null);
  const [session, setSession] = useState(null);
  const [menu, setMenu] = useState(null);
  const [history, setHistory] = useState(null);

  const [cart, setCart] = useState({});           // { menuItemId: quantity }
  const [note, setNote] = useState('');
  const [guestName, setGuestName] = useState('');
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');

  const [tab, setTab] = useState('menu');
  const [booting, setBooting] = useState(true);
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fatal, setFatal] = useState(null);
  const [toast, setToast] = useState(null);

  const socketRef = useRef(null);
  const notify = useCallback((message, type = 'info') => setToast({ message, type }), []);

  // ─── Xử lý phiên chết ─────────────────────────────────────────────────────
  const handleError = useCallback((err) => {
    if (isSessionDead(err)) {
      guestSession.clear(qrKey);
      setToken(null);
      setSession(null);
      setHistory(null);
      notify(err.message || 'Phiên đã kết thúc. Vui lòng quét lại mã QR.', 'warn');
      return;
    }
    notify(err.message || 'Có lỗi xảy ra, vui lòng thử lại', 'error');
  }, [qrKey, notify]);

  // ─── Khởi động: tra bàn + thử tiếp tục phiên cũ ──────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = await GuestApi.table(qrKey);
        if (cancelled) return;
        setTable(t);

        const saved = guestSession.get(qrKey);
        if (saved) {
          try {
            const resumed = await GuestApi.startSession(qrKey, { existingToken: saved });
            if (cancelled) return;
            guestSession.set(qrKey, resumed.token);
            setToken(resumed.token);
            setSession(resumed.session);
          } catch {
            guestSession.clear(qrKey);
            setToken(null);
          }
        }
      } catch (err) {
        if (!cancelled) setFatal(err.message || 'Không tìm thấy bàn tương ứng với mã QR này');
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => { cancelled = true; };
  }, [qrKey]);

  // ─── Nạp thực đơn & lịch sử khi đã có phiên ──────────────────────────────
  const loadHistory = useCallback(async (silent = false) => {
    if (!token) return;
    try {
      const data = await GuestApi.history(token);
      setHistory(data);
      if (data.session) setSession((prev) => ({ ...(prev || {}), ...data.session }));
    } catch (err) {
      if (!silent) handleError(err);
    }
  }, [token, handleError]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const [m] = await Promise.all([GuestApi.menu(token), loadHistory(true)]);
        if (!cancelled) setMenu(m);
      } catch (err) {
        if (!cancelled) handleError(err);
      }
    })();
    return () => { cancelled = true; };
  }, [token, loadHistory, handleError]);

  // ─── Thời gian thực: nghe kết quả duyệt món ──────────────────────────────
  useEffect(() => {
    if (!token) return undefined;
    const sock = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      auth: { guestToken: token },
      reconnectionDelay: 1500,
    });
    socketRef.current = sock;

    sock.on('guest:request-reviewed', (p) => {
      loadHistory(true);
      if (p.status === 'confirmed') notify('Nhà hàng đã xác nhận món của bạn 🎉');
      else if (p.status === 'rejected') notify(`Rất tiếc: ${p.reject_reason || 'nhà hàng không nhận được yêu cầu này'}`, 'warn');
      else if (p.status === 'partially_confirmed') notify('Một phần món của bạn đã được xác nhận', 'warn');
    });

    sock.on('guest:session-closed', () => {
      notify('Cảm ơn quý khách! Phiên gọi món đã kết thúc.', 'warn');
      loadHistory(true);
    });

    sock.on('invoice:paid', () => notify('Đã thanh toán xong. Hẹn gặp lại quý khách!'));

    return () => { try { sock.disconnect(); } catch { /* ignore */ } socketRef.current = null; };
  }, [token, loadHistory, notify]);

  // ─── Mở phiên mới ─────────────────────────────────────────────────────────
  async function startSession() {
    setStarting(true);
    try {
      const r = await GuestApi.startSession(qrKey, { displayName: guestName.trim() || undefined });
      guestSession.set(qrKey, r.token);
      setToken(r.token);
      setSession(r.session);
      notify(`Xin chào! Bạn đang gọi món tại bàn ${r.session?.table_code || table?.code}`);
    } catch (err) {
      handleError(err);
    } finally {
      setStarting(false);
    }
  }

  // ─── Giỏ hàng ─────────────────────────────────────────────────────────────
  const addToCart = (id) => setCart((c) => ({ ...c, [id]: Math.min((c[id] || 0) + 1, 50) }));
  const removeFromCart = (id) => setCart((c) => {
    const next = { ...c };
    if (!next[id]) return c;
    next[id] -= 1;
    if (next[id] <= 0) delete next[id];
    return next;
  });

  const itemsById = useMemo(() => {
    const map = new Map();
    (menu?.items || []).forEach((i) => map.set(i.id, i));
    return map;
  }, [menu]);

  const cartLines = useMemo(
    () => Object.entries(cart)
      .map(([id, quantity]) => ({ item: itemsById.get(id), quantity }))
      .filter((l) => l.item),
    [cart, itemsById]
  );

  const cartTotal = cartLines.reduce((s, l) => s + l.item.price * l.quantity, 0);
  const cartCount = cartLines.reduce((s, l) => s + l.quantity, 0);

  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (menu?.items || []).filter((i) => {
      if (activeCategory !== 'all' && i.category_code !== activeCategory) return false;
      if (!q) return true;
      return i.name.toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q);
    });
  }, [menu, activeCategory, search]);

  // ─── Gửi món ──────────────────────────────────────────────────────────────
  async function submitOrder() {
    if (!cartLines.length) return;
    setSubmitting(true);
    try {
      const items = cartLines.map((l) => ({ menu_item_id: l.item.id, quantity: l.quantity }));
      const r = await GuestApi.submitOrder(token, items, note.trim() || undefined);
      setCart({});
      setNote('');
      await loadHistory(true);
      setTab('history');
      notify(r.status === 'pending'
        ? 'Đã gửi! Nhà hàng sẽ xác nhận trong giây lát.'
        : 'Đã gửi món tới nhà hàng!');
    } catch (err) {
      if (err.code === 'ITEM_UNAVAILABLE') {
        const names = (err.details?.unavailable || [])
          .map((id) => itemsById.get(id)?.name).filter(Boolean);
        notify(names.length ? `Vừa hết: ${names.join(', ')}. Vui lòng chọn món khác.` : err.message, 'warn');
        GuestApi.menu(token).then(setMenu).catch(() => {});
        setCart((c) => {
          const next = { ...c };
          (err.details?.unavailable || []).forEach((id) => delete next[id]);
          return next;
        });
      } else {
        handleError(err);
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Các trạng thái đặc biệt ──────────────────────────────────────────────
  if (booting) return <div className="min-h-screen bg-surface"><Spinner label="Đang mở thực đơn…" /></div>;

  if (fatal) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center p-6">
        <div className="card max-w-sm w-full p-6 text-center">
          <AlertTriangle className="mx-auto text-danger" size={40} />
          <h1 className="mt-4 text-lg font-bold text-on-surface">Không mở được thực đơn</h1>
          <p className="mt-2 text-sm text-muted">{fatal}</p>
          <p className="mt-4 text-xs text-muted">
            Vui lòng gọi nhân viên để được hỗ trợ.
          </p>
        </div>
      </div>
    );
  }

  // ── Màn hình chào: chưa có phiên ──────────────────────────────────────────
  if (!token) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-primary to-primary-dark flex items-center justify-center p-6">
        <Toast toast={toast} onClose={() => setToast(null)} />
        <div className="bg-white rounded-3xl shadow-card max-w-sm w-full p-7 text-center">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-primary-container flex items-center justify-center">
            <QrCode className="text-primary" size={28} />
          </div>
          <h1 className="mt-5 text-xl font-bold text-on-surface">Bàn {table?.code}</h1>
          <p className="mt-1 text-sm text-muted">
            {table?.zone_name || table?.zone} · {table?.capacity} chỗ
          </p>

          <div className="mt-6 text-left">
            <label className="block text-xs font-semibold text-on-surface-variant mb-1.5">
              Tên của bạn <span className="font-normal text-muted">(không bắt buộc)</span>
            </label>
            <input
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              maxLength={40}
              placeholder="Ví dụ: Anh Minh"
              className="w-full rounded-xl border border-border px-3.5 py-2.5 text-sm outline-none focus:border-primary"
            />
            <p className="mt-1.5 text-[11px] text-muted">
              Chỉ dùng để nhân viên gọi đúng bàn. Bạn có thể bỏ trống.
            </p>
          </div>

          <button
            onClick={startSession}
            disabled={starting}
            className="btn-primary w-full mt-5 py-3"
          >
            {starting ? 'Đang mở…' : 'Bắt đầu gọi món'}
          </button>
        </div>
      </div>
    );
  }

  // ── Giao diện chính ───────────────────────────────────────────────────────
  const summary = history?.summary;

  return (
    <div className="min-h-screen bg-surface pb-24">
      <Toast toast={toast} onClose={() => setToast(null)} />

      {/* Thanh đầu trang */}
      <header className="sticky top-0 z-30 bg-primary text-white px-4 py-3 shadow-soft">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-white/70">Bàn</p>
            <h1 className="text-lg font-bold leading-tight">{session?.table_code || table?.code}</h1>
          </div>
          <div className="text-right">
            {summary?.has_pending ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-400 text-amber-950 px-2.5 py-1 text-[11px] font-bold">
                <Clock3 size={12} /> {fmtVnd(summary.pending_amount)} chờ duyệt
              </span>
            ) : (
              <>
                <p className="text-[11px] text-white/70">Tạm tính</p>
                <p className="text-base font-bold">{fmtVnd(summary?.confirmed_amount || 0)}</p>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-4">
        {/* ─── TAB: THỰC ĐƠN ─────────────────────────────────────────────── */}
        {tab === 'menu' && (
          !menu ? <Spinner /> : (
            <>
              <div className="relative mb-3">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Tìm món…"
                  className="w-full rounded-xl border border-border-soft bg-white pl-9 pr-3 py-2.5 text-sm outline-none focus:border-primary"
                />
              </div>

              <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
                {[{ code: 'all', name: 'Tất cả' }, ...(menu.categories || [])].map((c) => (
                  <button
                    key={c.code}
                    onClick={() => setActiveCategory(c.code)}
                    className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                      activeCategory === c.code
                        ? 'bg-primary text-white'
                        : 'bg-surface-container text-on-surface-variant'
                    }`}
                  >
                    {c.name}
                  </button>
                ))}
              </div>

              <ul className="mt-3 space-y-2">
                {visibleItems.map((item) => {
                  const qty = cart[item.id] || 0;
                  return (
                    <li key={item.id} className="card p-3 flex gap-3 items-center">
                      <div className="w-12 h-12 shrink-0 rounded-xl bg-surface-low flex items-center justify-center text-2xl overflow-hidden">
                        {item.image_url
                          ? <img src={item.image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                          : (item.emoji || '🍽️')}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm text-on-surface truncate">{item.name}</p>
                        {item.description && (
                          <p className="text-[11px] text-muted line-clamp-1">{item.description}</p>
                        )}
                        <p className="text-sm font-bold text-primary mt-0.5">{fmtVnd(item.price)}</p>
                      </div>
                      {qty === 0 ? (
                        <button
                          onClick={() => addToCart(item.id)}
                          aria-label={`Thêm ${item.name}`}
                          className="shrink-0 w-9 h-9 rounded-full bg-primary text-white flex items-center justify-center active:scale-95 transition"
                        >
                          <Plus size={18} />
                        </button>
                      ) : (
                        <div className="shrink-0 flex items-center gap-1.5">
                          <button
                            onClick={() => removeFromCart(item.id)}
                            aria-label="Bớt một"
                            className="w-8 h-8 rounded-full bg-surface-container flex items-center justify-center active:scale-95"
                          >
                            <Minus size={16} />
                          </button>
                          <span className="w-5 text-center font-bold text-sm">{qty}</span>
                          <button
                            onClick={() => addToCart(item.id)}
                            aria-label="Thêm một"
                            className="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center active:scale-95"
                          >
                            <Plus size={16} />
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
                {visibleItems.length === 0 && (
                  <li className="text-center text-sm text-muted py-10">Không tìm thấy món phù hợp</li>
                )}
              </ul>
            </>
          )
        )}

        {/* ─── TAB: GIỎ HÀNG ─────────────────────────────────────────────── */}
        {tab === 'cart' && (
          <>
            {cartLines.length === 0 ? (
              <div className="text-center py-16">
                <ShoppingCart size={40} className="mx-auto text-border" />
                <p className="mt-3 text-sm text-muted">Giỏ hàng đang trống</p>
                <button onClick={() => setTab('menu')} className="btn-ghost mt-4">Xem thực đơn</button>
              </div>
            ) : (
              <>
                <ul className="space-y-2">
                  {cartLines.map(({ item, quantity }) => (
                    <li key={item.id} className="card p-3 flex items-center gap-3">
                      <span className="text-xl">{item.emoji || '🍽️'}</span>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm truncate">{item.name}</p>
                        <p className="text-xs text-muted">{fmtVnd(item.price)} × {quantity}</p>
                      </div>
                      <p className="font-bold text-sm text-primary">{fmtVnd(item.price * quantity)}</p>
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => removeFromCart(item.id)} aria-label="Bớt một"
                          className="w-7 h-7 rounded-full bg-surface-container flex items-center justify-center">
                          <Minus size={14} />
                        </button>
                        <button onClick={() => addToCart(item.id)} aria-label="Thêm một"
                          className="w-7 h-7 rounded-full bg-primary text-white flex items-center justify-center">
                          <Plus size={14} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>

                <div className="card p-3 mt-3">
                  <label className="block text-xs font-semibold text-on-surface-variant mb-1.5">
                    Ghi chú cho nhà bếp
                  </label>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={300}
                    rows={2}
                    placeholder="Ví dụ: ít cay, không hành…"
                    className="w-full rounded-xl border border-border px-3 py-2 text-sm outline-none focus:border-primary resize-none"
                  />
                </div>

                <div className="card p-4 mt-3 flex items-center justify-between">
                  <span className="text-sm text-on-surface-variant">Tổng cộng</span>
                  <span className="text-lg font-bold text-primary">{fmtVnd(cartTotal)}</span>
                </div>

                <button onClick={submitOrder} disabled={submitting} className="btn-primary w-full mt-3 py-3">
                  <Send size={16} /> {submitting ? 'Đang gửi…' : 'Gửi cho nhà hàng'}
                </button>
                <p className="mt-2 text-center text-[11px] text-muted">
                  Nhân viên sẽ xác nhận món trước khi nhà bếp chế biến.
                </p>
              </>
            )}
          </>
        )}

        {/* ─── TAB: ĐƠN CỦA TÔI (lịch sử) ────────────────────────────────── */}
        {tab === 'history' && (
          !history ? <Spinner /> : (
            <>
              <div className="card p-4">
                <div className="flex items-center justify-between">
                  <h2 className="font-bold text-on-surface">Đơn của tôi</h2>
                  <button
                    onClick={() => loadHistory()}
                    className="text-xs text-primary font-semibold inline-flex items-center gap-1"
                  >
                    <RefreshCw size={12} /> Làm mới
                  </button>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-xl bg-emerald-50 p-3">
                    <dt className="text-[11px] text-emerald-700 font-semibold">Đã xác nhận</dt>
                    <dd className="text-base font-bold text-emerald-800">
                      {fmtVnd(summary?.confirmed_amount || 0)}
                    </dd>
                  </div>
                  <div className="rounded-xl bg-amber-50 p-3">
                    <dt className="text-[11px] text-amber-700 font-semibold">Chờ xác nhận</dt>
                    <dd className="text-base font-bold text-amber-800">
                      {fmtVnd(summary?.pending_amount || 0)}
                    </dd>
                  </div>
                </dl>
                <p className="mt-3 text-[11px] text-muted">
                  Số tiền này là tạm tính, chưa gồm VAT và khuyến mãi. Hoá đơn cuối cùng do thu ngân lập.
                </p>
              </div>

              <ul className="mt-3 space-y-3">
                {(history.requests || []).map((req) => (
                  <li key={req.request_id} className="card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs text-muted">
                          {new Date(req.submitted_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                          {' · '}{req.items_count} món
                        </p>
                        <p className="text-[11px] text-muted mt-0.5">Mã {req.code}</p>
                      </div>
                      <span className={`${REQUEST_STATUS[req.status] || ''} rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap`}>
                        {req.status_label}
                      </span>
                    </div>

                    <ul className="mt-3 space-y-1.5">
                      {req.items.map((it, idx) => (
                        <li key={idx} className="flex items-center justify-between gap-2 text-sm">
                          <span className={`flex-1 min-w-0 truncate ${it.status === 'rejected' ? 'line-through text-muted' : ''}`}>
                            {it.quantity}× {it.item_name}
                          </span>
                          <ItemStatusChip status={it.status} />
                          <span className={`w-20 text-right font-semibold ${it.status === 'rejected' ? 'text-muted line-through' : 'text-on-surface'}`}>
                            {fmtVnd(it.total_price)}
                          </span>
                        </li>
                      ))}
                    </ul>

                    {req.reject_reason && (
                      <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                        Lý do: {req.reject_reason}
                      </p>
                    )}
                    {req.guest_note && (
                      <p className="mt-2 text-[11px] text-muted">Ghi chú: {req.guest_note}</p>
                    )}
                  </li>
                ))}
                {(history.requests || []).length === 0 && (
                  <li className="text-center py-14">
                    <ReceiptText size={40} className="mx-auto text-border" />
                    <p className="mt-3 text-sm text-muted">Bạn chưa gọi món nào</p>
                    <button onClick={() => setTab('menu')} className="btn-ghost mt-4">Xem thực đơn</button>
                  </li>
                )}
              </ul>
            </>
          )
        )}
      </main>

      {/* Thanh điều hướng dưới */}
      <nav className="fixed bottom-0 inset-x-0 z-30 bg-white border-t border-border-soft">
        <div className="max-w-lg mx-auto grid grid-cols-3">
          {[
            { id: 'menu',    label: 'Thực đơn',    Icon: UtensilsCrossed },
            { id: 'cart',    label: 'Giỏ hàng',    Icon: ShoppingCart, badge: cartCount },
            { id: 'history', label: 'Đơn của tôi', Icon: ReceiptText,
              badge: summary?.has_pending ? '!' : 0 },
          ].map(({ id, label, Icon, badge }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`relative flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-semibold transition ${
                tab === id ? 'text-primary' : 'text-muted'
              }`}
            >
              <Icon size={20} />
              {label}
              {Boolean(badge) && (
                <span className="absolute top-1.5 right-[25%] min-w-[18px] h-[18px] rounded-full bg-danger text-white text-[10px] font-bold flex items-center justify-center px-1">
                  {badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </nav>

      {/* Nút gửi nổi khi có món trong giỏ và đang ở tab thực đơn */}
      {tab === 'menu' && cartCount > 0 && (
        <button
          onClick={() => setTab('cart')}
          className="fixed bottom-20 left-1/2 -translate-x-1/2 z-30 btn-primary shadow-card px-5 py-3 animate-pop-in"
        >
          <ShoppingCart size={16} /> {cartCount} món · {fmtVnd(cartTotal)}
        </button>
      )}
    </div>
  );
}
