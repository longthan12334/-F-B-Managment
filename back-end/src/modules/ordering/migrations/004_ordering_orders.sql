-- =============================================================================
--  MODULE: ordering — Đơn hàng tại bàn
--  Sở hữu: orders, order_items
--  Phụ thuộc: tables (dining), users (identity), menu_items (catalog)
-- =============================================================================
CREATE TABLE IF NOT EXISTS orders (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    code            TEXT          UNIQUE NOT NULL
                                  DEFAULT ('ORD-' || to_char(NOW(),'YYMMDDHH24MISS') || '-' || substr(md5(random()::text),1,4)),
    table_id        UUID          REFERENCES tables(id),
    table_code      TEXT          NOT NULL,
    waiter_id       UUID          REFERENCES users(id),
    waiter_name     TEXT          NOT NULL,
    status          TEXT          NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','serving','completed','cancelled')),
    source          TEXT          NOT NULL DEFAULT 'staff'
                                  CHECK (source IN ('staff','qr')),
    total_amount    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    check_in_time   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    check_out_time  TIMESTAMPTZ,
    cancelled_reason TEXT,
    notes           TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Cột bổ sung cho CSDL nâng cấp từ phiên bản trước
ALTER TABLE orders ADD COLUMN IF NOT EXISTS source           TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_reason TEXT;
UPDATE orders SET source = 'staff' WHERE source IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_source_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_source_check CHECK (source IN ('staff','qr'));
  END IF;
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS orders_status_idx     ON orders (status);
CREATE INDEX IF NOT EXISTS orders_table_idx      ON orders (table_id);
CREATE INDEX IF NOT EXISTS orders_created_idx    ON orders (created_at DESC);
-- Truy vấn nóng nhất của POS: "các đơn đang mở"
CREATE INDEX IF NOT EXISTS orders_open_idx       ON orders (table_id, created_at DESC)
  WHERE status IN ('pending','serving');

-- BẤT BIẾN QUAN TRỌNG: mỗi bàn chỉ có tối đa MỘT đơn đang mở.
-- Đặt ở tầng CSDL (không chỉ ở tầng ứng dụng) để hai request đồng thời không
-- thể cùng tạo đơn cho một bàn — request thua sẽ nhận lỗi 23505.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_order_per_table
  ON orders (table_id) WHERE status IN ('pending','serving');

-- ─── Dòng món trong đơn ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
    id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id     UUID          NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id UUID          REFERENCES menu_items(id),
    item_name    TEXT          NOT NULL,
    quantity     INTEGER       NOT NULL CHECK (quantity > 0),
    price        NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    total_price  NUMERIC(12,2) NOT NULL CHECK (total_price >= 0),
    notes        TEXT,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);

COMMENT ON TABLE  orders        IS 'Đơn hàng tại bàn (module ordering)';
COMMENT ON COLUMN orders.source IS 'staff = nhân viên tạo | qr = khách tự gọi bằng mã QR';
COMMENT ON COLUMN orders.status IS 'pending → serving → completed; hoặc → cancelled';
