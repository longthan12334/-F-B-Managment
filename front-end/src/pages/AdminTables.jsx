// =============================================================================
//  AdminTables — CRUD bàn theo khu vực (indoor / outdoor / vip)
//  + mã QR gọi món cho từng bàn (Scan-to-Order): xem, sao chép link, in
// =============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Edit2, Trash2, QrCode, Printer, Copy, ExternalLink } from 'lucide-react';
import QRCode from 'qrcode';
import { Api } from '../api/client';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';
import { useSocket } from '../hooks/useSocket';
import Modal from '../components/Modal';

const ZONE_LABEL = { indoor: 'Trong nhà', outdoor: 'Sân vườn', vip: 'VIP' };

const EMPTY = { id: null, code: '', zone: 'indoor', capacity: 4, is_active: true };

export default function AdminTables() {
  const [tables, setTables] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [qrTable, setQrTable] = useState(null);   // bàn đang mở modal QR
  const toast = useToast();
  const confirm = useConfirm();

  const load = useCallback(async () => {
    try { setTables(await Api.listTables() || []); }
    catch (e) { toast.err('Không tải được danh sách bàn', e.message); }
    finally   { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  useSocket({ 'tables:changed': load });

  const openCreate = () => setEditing({ ...EMPTY });
  const openEdit   = (t) => setEditing({
    id: t.id, code: t.code, zone: t.zone, capacity: t.capacity, is_active: !!t.is_active,
  });

  const onSave = async () => {
    const f = editing;
    if (!f.code?.trim()) {
      toast.err('Thiếu mã bàn', 'Cần đặt mã (vd: T1-07).');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        code: f.code.trim().toUpperCase(),
        zone: f.zone,
        capacity: parseInt(f.capacity, 10) || 4,
        is_active: !!f.is_active,
      };
      if (f.id) await Api.updateTable(f.id, payload);
      else      await Api.createTable(payload);
      setEditing(null);
      toast.ok('Đã lưu');
      load();
    } catch (e) {
      toast.err('Lưu thất bại', e.message);
    } finally { setSaving(false); }
  };

  const onDelete = async (t) => {
    const ok = await confirm({
      title: 'Xoá bàn?',
      message: `Sẽ xoá bàn "${t.code}".`,
      okText: 'Xoá', danger: true,
    });
    if (!ok) return;
    try {
      await Api.deleteTable(t.id);
      toast.ok('Đã xoá');
      load();
    } catch (e) { toast.err('Xoá thất bại', e.message); }
  };

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6 gap-3">
        <div>
          <h1 className="text-2xl font-bold text-on-surface">Bàn</h1>
          <p className="text-sm text-muted">Cấu hình bàn theo khu vực.</p>
        </div>
        <button onClick={openCreate} className="btn-primary text-sm py-2">
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">Thêm bàn</span>
        </button>
      </div>

      {loading ? (
        <div className="text-center text-muted py-12">Đang tải…</div>
      ) : tables.length === 0 ? (
        <div className="text-center text-muted py-12">Chưa có bàn nào.</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {tables.map(t => (
            <div key={t.id} className="card p-4 text-center">
              <div className="text-xs text-muted uppercase">{ZONE_LABEL[t.zone] || t.zone}</div>
              <div className="text-2xl font-bold text-on-surface mt-1">{t.code}</div>
              <div className="text-xs text-muted mt-1">Sức chứa: {t.capacity}</div>
              <div className={
                'mt-2 text-xs ' + (t.is_active ? 'text-success' : 'text-danger')
              }>{t.is_active ? 'Đang dùng' : 'Tạm ngừng'}</div>
              <div className="flex gap-1 mt-3 pt-3 border-t border-border-soft">
                <button
                  onClick={() => openEdit(t)}
                  className="btn-ghost text-xs py-1.5 flex-1"
                ><Edit2 className="w-3.5 h-3.5" /></button>
                <button
                  onClick={() => setQrTable(t)}
                  className="btn-ghost text-xs py-1.5"
                  title="Mã QR gọi món"
                  aria-label={`Mã QR bàn ${t.code}`}
                ><QrCode className="w-3.5 h-3.5" /></button>
                <button
                  onClick={() => onDelete(t)}
                  className="btn-ghost text-xs py-1.5 text-danger"
                ><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={!!editing}
        title={editing?.id ? 'Sửa bàn' : 'Thêm bàn'}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button className="btn-ghost text-sm py-2" onClick={() => setEditing(null)}>Huỷ</button>
            <button className="btn-primary text-sm py-2" onClick={onSave} disabled={saving}>
              {saving ? 'Đang lưu…' : 'Lưu'}
            </button>
          </>
        }
      >
        {editing && (
          <div className="space-y-3">
            <label className="block">
              <span className="text-xs text-muted">Mã bàn</span>
              <input
                value={editing.code}
                onChange={(e) => setEditing(s => ({ ...s, code: e.target.value }))}
                placeholder="VD: T1-07"
                className="field mt-1 py-2"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Khu vực</span>
              <select
                value={editing.zone}
                onChange={(e) => setEditing(s => ({ ...s, zone: e.target.value }))}
                className="field mt-1 py-2"
              >
                <option value="indoor">Trong nhà</option>
                <option value="outdoor">Sân vườn</option>
                <option value="vip">VIP</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-muted">Sức chứa</span>
              <input
                type="number" min="1" max="6"
                value={editing.capacity}
                onChange={(e) => {
                  let v = parseInt(e.target.value, 10);
                  if (isNaN(v)) v = '';
                  else if (v > 6) v = 6;
                  else if (v < 1) v = 1;
                  setEditing(s => ({ ...s, capacity: v }));
                }}
                className="field mt-1 py-2"
              />
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={editing.is_active}
                onChange={(e) => setEditing(s => ({ ...s, is_active: e.target.checked }))}
              />
              <span className="text-sm">Đang sử dụng</span>
            </label>
          </div>
        )}
      </Modal>

      <QrModal table={qrTable} onClose={() => setQrTable(null)} />
    </div>
  );
}

// ─── Modal mã QR gọi món (Scan-to-Order) cho 1 bàn ────────────────────────
function QrModal({ table, onClose }) {
  const toast = useToast();
  const [svg, setSvg] = useState('');
  // Dùng qr_slug (chuỗi ngẫu nhiên) thay vì mã bàn.
  // Nếu URL là /order/T1-02 thì khách ở bàn T1-01 chỉ cần sửa một ký tự là gọi
  // món sang bàn khác. qr_slug không đoán được nên không có lỗ hổng đó.
  // Bàn cũ chưa có qr_slug thì lùi về mã bàn để mã QR đã in vẫn dùng được.
  const qrKey = table ? (table.qr_slug || table.code) : '';
  const url = table ? `${window.location.origin}/order/${encodeURIComponent(qrKey)}` : '';
  // Mở trang quản trị bằng localhost thì điện thoại của khách không mở được link
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    setSvg('');
    QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then(s => { if (alive) setSvg(s); })
      .catch(() => { if (alive) toast.err('Không tạo được mã QR'); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const onPrint = () => {
    if (!printQr(table, svg, url)) toast.err('Trình duyệt chặn cửa sổ in', 'Hãy cho phép popup rồi thử lại.');
  };
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.ok('Đã sao chép link');
    } catch {
      toast.err('Không sao chép được', 'Hãy chép link thủ công.');
    }
  };

  return (
    <Modal
      open={!!table}
      title={table ? `Mã QR gọi món — Bàn ${table.code}` : ''}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost text-sm py-2" onClick={onCopy}>
            <Copy className="w-4 h-4" /> Sao chép link
          </button>
          <button className="btn-primary text-sm py-2" onClick={onPrint} disabled={!svg}>
            <Printer className="w-4 h-4" /> In mã QR
          </button>
        </>
      }
    >
      {table && (
        <div className="text-center">
          <div className="w-60 h-60 mx-auto flex items-center justify-center">
            {svg
              ? <img src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)}
                  alt={`Mã QR bàn ${table.code}`} className="w-full h-full" />
              : <span className="text-sm text-muted">Đang tạo mã…</span>}
          </div>
          <p className="text-sm text-on-surface mt-3">
            Khách quét mã để xem thực đơn và tự gọi món cho bàn này.
          </p>
          <a href={url} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 mt-2 text-xs text-primary break-all hover:underline">
            {url} <ExternalLink className="w-3 h-3 shrink-0" />
          </a>
          {!table.is_active && (
            <p className="mt-3 text-xs text-danger">
              Bàn đang tạm ngừng: khách quét mã sẽ thấy thông báo bàn tạm ngưng phục vụ.
            </p>
          )}
          {isLocal && (
            <p className="mt-3 text-xs text-warning bg-amber-50 rounded-lg px-3 py-2 text-left">
              Bạn đang mở trang quản trị bằng {window.location.hostname}, điện thoại của khách sẽ không mở được link này.
              Hãy mở trang bằng địa chỉ IP LAN hoặc tên miền của máy chủ trước khi in mã.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

// In mã QR: mở cửa sổ mới, tự gọi window.print (cùng cách in hoá đơn ở AdminInvoices)
function printQr(table, svg, url) {
  const w = window.open('', '_blank', 'width=480,height=640');
  if (!w) return false;
  const html = `<!doctype html><html><head><meta charset="utf-8"/>
<title>QR bàn ${escapeHtml(table.code)}</title>
<style>
body{font-family:Arial,sans-serif;margin:0;padding:32px;color:#111;text-align:center}
.card{border:2px solid #0d5c63;border-radius:16px;padding:24px;max-width:360px;margin:0 auto}
.brand{font-size:14px;color:#0d5c63;font-weight:bold;letter-spacing:1px;text-transform:uppercase}
.table{font-size:40px;font-weight:bold;margin:8px 0 16px}
.qr svg{width:260px;height:260px}
.hint{font-size:16px;margin-top:12px}
.url{font-size:11px;color:#666;margin-top:8px;word-break:break-all}
</style></head><body>
<div class="card">
<div class="brand">RestoManager</div>
<div class="table">Bàn ${escapeHtml(table.code)}</div>
<div class="qr">${svg}</div>
<div class="hint">Quét mã để xem thực đơn và gọi món</div>
<div class="url">${escapeHtml(url)}</div>
</div>
<scr` + `ipt>window.onload=()=>setTimeout(()=>window.print(),250);</scr` + `ipt>
</body></html>`;
  w.document.open(); w.document.write(html); w.document.close(); w.focus();
  return true;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
