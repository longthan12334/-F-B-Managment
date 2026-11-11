// =============================================================================
//  Màn hình "Duyệt món khách gọi" — /cashier/guest-requests
// -----------------------------------------------------------------------------
//  Hàng đợi các lượt khách quét QR gửi món. Nhân viên (thu ngân / phục vụ /
//  quản trị) xem và:
//    • Xác nhận cả lượt   → mọi món vào đơn, tính tiền
//    • Từ chối cả lượt    → kèm lý do, khách thấy ngay trên điện thoại
//    • Từ chối từng món   → khi chỉ hết đúng một món trong lượt gọi
//
//  Màn hình tự cập nhật qua Socket.IO: có yêu cầu mới là hiện ngay, không cần
//  bấm làm mới. Thời gian chờ được tô màu để nhân viên ưu tiên đúng bàn.
// =============================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BellRing, CheckCircle2, XCircle, Clock3, RefreshCw, Inbox, AlertCircle,
} from 'lucide-react';
import { Api, fmt } from '../api/client';
import { useSocket } from '../hooks/useSocket';
import { useToast } from '../components/Toast';

/** Tô màu theo thời gian chờ — quá 5 phút là khách bắt đầu sốt ruột. */
function waitTone(minutes) {
  if (minutes >= 10) return 'bg-red-100 text-red-700';
  if (minutes >= 5) return 'bg-amber-100 text-amber-800';
  return 'bg-surface-container text-on-surface-variant';
}

function RejectDialog({ open, onClose, onConfirm, title }) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  if (!open) return null;

  const presets = ['Hết món', 'Hết nguyên liệu', 'Ngoài giờ phục vụ', 'Khách gọi nhầm'];

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-sm p-5 animate-pop-in">
        <h3 className="font-bold text-on-surface">{title}</h3>
        <p className="mt-1 text-xs text-muted">
          Lý do sẽ hiện trên điện thoại của khách, hãy viết ngắn gọn và lịch sự.
        </p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button
              key={p}
              onClick={() => setReason(p)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                reason === p ? 'bg-primary text-white' : 'bg-surface-container text-on-surface-variant'
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={255}
          placeholder="Hoặc nhập lý do khác…"
          className="mt-3 w-full rounded-xl border border-border px-3 py-2.5 text-sm outline-none focus:border-primary"
        />

        <div className="mt-4 flex gap-2">
          <button onClick={onClose} className="btn-ghost flex-1">Huỷ</button>
          <button
            onClick={() => onConfirm(reason.trim() || 'Hết món')}
            className="btn-danger flex-1"
          >
            Từ chối
          </button>
        </div>
      </div>
    </div>
  );
}

export default function GuestRequests() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [tick, setTick] = useState(0); // ép tính lại thời gian chờ mỗi 30 giây
  const toast = useToast();

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setRequests(await Api.listGuestRequests());
    } catch (err) {
      if (!silent) toast.err('Lỗi', err.message || 'Không tải được danh sách yêu cầu');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // Có yêu cầu mới hoặc vừa được người khác xử lý → tải lại
  useSocket({
    'guest:request-pending': (p) => { load(true); toast.info('Khách vừa gọi món', `Bàn ${p?.table_code || ''}`); },
    'order:item-confirmed': () => load(true),
    'order:item-rejected': () => load(true),
    'orders:changed': () => load(true),
  });

  async function review(req, approve, reason) {
    setBusyId(req.request_id);
    try {
      await Api.reviewGuestRequest(req.request_id, approve, reason);
      toast.ok(approve ? 'Đã xác nhận' : 'Đã từ chối',
        approve ? `${req.items_count} món cho bàn ${req.table_code}`
                : `Yêu cầu của bàn ${req.table_code}`);
      setRequests((list) => list.filter((r) => r.request_id !== req.request_id));
    } catch (err) {
      toast.err('Không xử lý được', err.message);
      load(true);
    } finally {
      setBusyId(null);
      setRejecting(null);
    }
  }

  async function rejectOneItem(req, item) {
    setBusyId(req.request_id);
    try {
      await Api.rejectOrderItem(req.order_id, item.id, 'Hết món');
      toast.ok('Đã từ chối món', item.item_name);
      load(true);
    } catch (err) {
      toast.err('Không từ chối được món', err.message);
    } finally {
      setBusyId(null);
    }
  }

  const totalPending = useMemo(
    () => requests.reduce((s, r) => s + Number(r.amount || 0), 0),
    [requests]
  );

  return (
    <div className="p-4 max-w-3xl mx-auto">
      <header className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-on-surface flex items-center gap-2">
            <BellRing size={20} className="text-primary" />
            Khách gọi món qua QR
          </h1>
          <p className="text-sm text-muted mt-0.5">
            {requests.length === 0
              ? 'Không có yêu cầu nào đang chờ'
              : `${requests.length} yêu cầu đang chờ · ${fmt(totalPending)}`}
          </p>
        </div>
        <button onClick={() => load()} className="btn-ghost px-3 py-2" aria-label="Làm mới">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>

      {loading && requests.length === 0 && (
        <div className="py-16 text-center text-muted">
          <RefreshCw size={28} className="mx-auto animate-spin" />
          <p className="mt-3 text-sm">Đang tải…</p>
        </div>
      )}

      {!loading && requests.length === 0 && (
        <div className="card py-16 text-center">
          <Inbox size={44} className="mx-auto text-border" />
          <p className="mt-3 font-semibold text-on-surface">Tất cả đã được xử lý</p>
          <p className="mt-1 text-sm text-muted">
            Yêu cầu mới của khách sẽ tự hiện ở đây.
          </p>
        </div>
      )}

      <ul className="space-y-3">
        {requests.map((req) => {
          const busy = busyId === req.request_id;
          return (
            <li key={req.request_id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-base font-bold text-on-surface">Bàn {req.table_code}</span>
                    {req.guest_name && (
                      <span className="text-sm text-muted truncate">· {req.guest_name}</span>
                    )}
                  </div>
                  <p className="text-xs text-muted mt-0.5">
                    {new Date(req.submitted_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                    {req.order_code ? ` · đơn ${req.order_code}` : ''}
                  </p>
                </div>
                <span
                  key={tick}
                  className={`${waitTone(req.waiting_minutes)} shrink-0 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold`}
                >
                  <Clock3 size={12} />
                  {req.waiting_minutes < 1 ? 'vừa gửi' : `chờ ${req.waiting_minutes}′`}
                </span>
              </div>

              <ul className="mt-3 divide-y divide-border-soft">
                {req.items.map((item, idx) => (
                  <li key={item.id || idx} className="flex items-center gap-2 py-2">
                    <span className="w-8 text-sm font-bold text-primary">{item.quantity}×</span>
                    <span className="flex-1 min-w-0 truncate text-sm">{item.item_name}</span>
                    <span className="text-sm font-semibold">{fmt(item.total_price)}</span>
                    {item.id && (
                      <button
                        onClick={() => rejectOneItem(req, item)}
                        disabled={busy}
                        title="Từ chối riêng món này"
                        className="ml-1 w-7 h-7 rounded-full text-muted hover:text-danger hover:bg-red-50 flex items-center justify-center transition"
                      >
                        <XCircle size={16} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>

              {req.guest_note && (
                <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <AlertCircle size={14} className="shrink-0 mt-px" />
                  <span>Ghi chú của khách: {req.guest_note}</span>
                </p>
              )}

              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="font-bold text-primary">{fmt(req.amount)}</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setRejecting(req)}
                    disabled={busy}
                    className="btn-ghost px-3 py-2 text-sm"
                  >
                    <XCircle size={15} /> Từ chối
                  </button>
                  <button
                    onClick={() => review(req, true)}
                    disabled={busy}
                    className="btn-primary px-4 py-2 text-sm"
                  >
                    <CheckCircle2 size={15} /> {busy ? 'Đang xử lý…' : 'Xác nhận'}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <RejectDialog
        open={Boolean(rejecting)}
        title={rejecting ? `Từ chối yêu cầu của bàn ${rejecting.table_code}` : ''}
        onClose={() => setRejecting(null)}
        onConfirm={(reason) => review(rejecting, false, reason)}
      />
    </div>
  );
}
