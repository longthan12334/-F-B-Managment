-- =============================================================================
--  MODULE: ordering — Quy trình XÁC NHẬN MÓN cho đơn khách tự gọi qua QR
-- -----------------------------------------------------------------------------
--  Nhận xét của giảng viên: "đã đặt được món, chưa xem lịch sử đặt ở bên khách
--  hàng (cần có xác nhận đơn)".
--
--  Thiết kế: mỗi DÒNG MÓN có vòng đời xác nhận riêng, không phải cả đơn. Lý do
--  thực tế: khách gọi 4 món, bếp hết 1 món → nhân viên chỉ từ chối đúng món đó,
--  3 món còn lại vẫn vào đơn. Nếu đặt trạng thái ở cấp đơn thì phải từ chối cả
--  lượt gọi, khách phải gọi lại — trải nghiệm kém.
--
--  Vòng đời: pending_confirm ──duyệt──→ confirmed ──┬──→ served
--                   │                               └──→ cancelled (huỷ sau khi duyệt)
--                   └──từ chối──→ rejected
--
--  QUY TẮC TIỀN: orders.total_amount CHỈ cộng các dòng ở trạng thái
--  confirmed/served. Món chờ duyệt và món bị từ chối KHÔNG tính tiền.
-- =============================================================================

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS status          TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS source          TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS guest_request_id UUID;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS reviewed_by     UUID REFERENCES users(id);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS reviewed_at     TIMESTAMPTZ;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS reject_reason   TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS served_at       TIMESTAMPTZ;

-- Dữ liệu cũ: mọi món đã tồn tại đều do nhân viên nhập ⇒ coi như đã xác nhận
UPDATE order_items SET status = 'confirmed' WHERE status IS NULL;
UPDATE order_items SET source = 'staff'     WHERE source IS NULL;

ALTER TABLE order_items ALTER COLUMN status SET DEFAULT 'confirmed';
ALTER TABLE order_items ALTER COLUMN status SET NOT NULL;
ALTER TABLE order_items ALTER COLUMN source SET DEFAULT 'staff';
ALTER TABLE order_items ALTER COLUMN source SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_status_check') THEN
    ALTER TABLE order_items ADD CONSTRAINT order_items_status_check
      CHECK (status IN ('pending_confirm','confirmed','rejected','served','cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_source_check') THEN
    ALTER TABLE order_items ADD CONSTRAINT order_items_source_check
      CHECK (source IN ('staff','qr'));
  END IF;
END $$;

-- Hàng đợi "món chờ duyệt" được tra liên tục ⇒ index riêng phần (partial index)
CREATE INDEX IF NOT EXISTS order_items_pending_idx
  ON order_items (order_id, created_at)
  WHERE status = 'pending_confirm';

CREATE INDEX IF NOT EXISTS order_items_guest_request_idx
  ON order_items (guest_request_id) WHERE guest_request_id IS NOT NULL;

COMMENT ON COLUMN order_items.status IS
  'pending_confirm=chờ nhân viên duyệt | confirmed=đã duyệt | rejected=từ chối | served=đã phục vụ | cancelled=huỷ sau duyệt';
COMMENT ON COLUMN order_items.source IS 'staff=nhân viên nhập | qr=khách tự gọi qua mã QR';
COMMENT ON COLUMN order_items.guest_request_id IS
  'Trỏ tới guest_order_requests.id — gom các món của cùng một lần khách bấm "Gửi"';
