-- =============================================================================
--  Migration 006 — QR Ordering (BE-1)
--  Thêm 5 bảng cho hệ thống gọi món qua QR của customer-api (.NET).
--  Không động vào bảng cũ (users, menu_items, menu_categories, tables, orders,
--  order_items, invoices, invoice_items, activity_logs).
--
--  Chạy sau 005_table_management.sql.
--  Node.js backend không cần biết đến các bảng này, nhưng share chung database.
-- =============================================================================

-- ─── 1. table_qr_configs — Cấu hình QR cho mỗi bàn ───────────────────────────
CREATE TABLE IF NOT EXISTS table_qr_configs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_id    UUID NOT NULL UNIQUE REFERENCES tables(id) ON DELETE CASCADE,
    table_code  TEXT NOT NULL,                            -- cache code bàn
    qr_secret   TEXT NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_table_qr_configs_table_code ON table_qr_configs(table_code);

-- ─── 2. guest_table_sessions — Phiên bàn (lượt khách) ────────────────────────
CREATE TABLE IF NOT EXISTS guest_table_sessions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_id      UUID NOT NULL REFERENCES tables(id),
    table_code    TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','completed','expired')),
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at  TIMESTAMPTZ,
    expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '3 hours'),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_guest_table_sessions_table    ON guest_table_sessions(table_id);
CREATE INDEX IF NOT EXISTS idx_guest_table_sessions_status   ON guest_table_sessions(status);
CREATE INDEX IF NOT EXISTS idx_guest_table_sessions_expires  ON guest_table_sessions(expires_at)
    WHERE status = 'active';  -- partial index: cleanup job chỉ scan phần active

-- ─── 3. guest_device_sessions — Phiên thiết bị khách ─────────────────────────
CREATE TABLE IF NOT EXISTS guest_device_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_session_id    UUID NOT NULL REFERENCES guest_table_sessions(id) ON DELETE CASCADE,
    session_token       TEXT NOT NULL UNIQUE,  -- 64-char hex, do app sinh (không dùng default DB)
    device_fingerprint  TEXT,
    ip_address          INET,
    user_agent          TEXT,
    last_active_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_guest_device_sessions_token         ON guest_device_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_guest_device_sessions_table_session ON guest_device_sessions(table_session_id);

-- ─── 4. guest_orders — Đơn hàng từ khách qua QR ──────────────────────────────
CREATE TABLE IF NOT EXISTS guest_orders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                TEXT UNIQUE NOT NULL,  -- GST-YYMMDDHHMMSS-xxxx, app sinh
    table_session_id    UUID NOT NULL REFERENCES guest_table_sessions(id),
    device_session_id   UUID NOT NULL REFERENCES guest_device_sessions(id),
    table_code          TEXT NOT NULL,          -- snapshot
    status              TEXT NOT NULL DEFAULT 'pending_confirmation'
                           CHECK (status IN (
                               'pending_confirmation',
                               'confirmed',
                               'preparing',
                               'served',
                               'cancelled'
                           )),
    total_amount        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    notes               TEXT,
    confirmed_by        UUID REFERENCES users(id),      -- staff id, nullable
    confirmed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_guest_orders_table_session ON guest_orders(table_session_id);
CREATE INDEX IF NOT EXISTS idx_guest_orders_status        ON guest_orders(status);
CREATE INDEX IF NOT EXISTS idx_guest_orders_created       ON guest_orders(created_at DESC);

-- ─── 5. guest_order_items — Chi tiết đơn hàng khách ──────────────────────────
CREATE TABLE IF NOT EXISTS guest_order_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guest_order_id  UUID NOT NULL REFERENCES guest_orders(id) ON DELETE CASCADE,
    menu_item_id    UUID NOT NULL REFERENCES menu_items(id),
    item_name       TEXT NOT NULL,                                  -- snapshot
    quantity        INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 99),
    price           NUMERIC(12,2) NOT NULL CHECK (price >= 0),       -- snapshot
    total_price     NUMERIC(12,2) NOT NULL CHECK (total_price >= 0),
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_guest_order_items_guest_order ON guest_order_items(guest_order_id);

-- ─── 6. Trigger auto cập nhật updated_at ─────────────────────────────────────
-- Dùng hàm set_updated_at() nếu đã có từ migration cũ. Nếu chưa thì tạo mới.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_table_qr_configs_updated_at ON table_qr_configs;
CREATE TRIGGER trg_table_qr_configs_updated_at
    BEFORE UPDATE ON table_qr_configs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_guest_orders_updated_at ON guest_orders;
CREATE TRIGGER trg_guest_orders_updated_at
    BEFORE UPDATE ON guest_orders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 7. Seed: tạo table_qr_configs cho mọi bàn hiện có ───────────────────────
-- Để staff không phải tạo tay QR cho từng bàn, mỗi bàn trong hệ thống có sẵn 1 config.
INSERT INTO table_qr_configs (table_id, table_code)
SELECT t.id, t.code
  FROM tables t
  LEFT JOIN table_qr_configs c ON c.table_id = t.id
 WHERE c.id IS NULL;
