-- =============================================================================
--  Migration 009 — Liên kết guest_orders → orders (BE-2)
--  Nhiều guest_order có thể ghép vào CÙNG 1 order đang mở của bàn,
--  nên orders.guest_order_id (1-1) không đủ để trace. Thêm guest_orders.order_id
--  để đồng bộ trạng thái 2 chiều (orders → guest_orders).
-- =============================================================================

ALTER TABLE guest_orders ADD COLUMN IF NOT EXISTS order_id UUID
    REFERENCES orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_guest_orders_order_id
    ON guest_orders(order_id) WHERE order_id IS NOT NULL;

-- Backfill cho các đơn đã confirm trước migration này
UPDATE guest_orders g
   SET order_id = o.id
  FROM orders o
 WHERE o.guest_order_id = g.id
   AND g.order_id IS NULL;
