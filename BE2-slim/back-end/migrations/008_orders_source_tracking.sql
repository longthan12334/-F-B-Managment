-- =============================================================================
--  Migration 008 — Trace đơn đến từ nguồn nào (BE-2)
--  Khi staff confirm 1 guest_order qua QR, snapshot sang bảng `orders` cũ
--  với source='guest_qr' + guest_order_id để trace ngược.
-- =============================================================================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT
    NOT NULL DEFAULT 'staff'
    CHECK (source IN ('staff','guest_qr'));

ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_order_id UUID
    REFERENCES guest_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_guest_order_id
    ON orders(guest_order_id) WHERE guest_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_source_created
    ON orders(source, created_at DESC);
