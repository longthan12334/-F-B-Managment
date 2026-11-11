-- =============================================================================
--  MODULE: dining — Hình chiếu trạng thái bàn (read model)
--  Sở hữu: dining_table_state
-- -----------------------------------------------------------------------------
--  VÌ SAO CẦN BẢNG NÀY?
--  Trạng thái "bàn đang có khách" sinh ra từ ĐƠN HÀNG — dữ liệu của module
--  `ordering`. Phiên bản trước, module bàn JOIN thẳng sang bảng `orders`, tạo
--  phụ thuộc hai chiều dining ↔ ordering: sửa lược đồ orders là màn hình sơ đồ
--  bàn hỏng theo.
--
--  Nay: `ordering` phát sự kiện (order.created / cancelled / completed / moved,
--  invoice.issued) → `dining` nghe và cập nhật bảng hình chiếu này. Màn hình sơ
--  đồ bàn chỉ đọc một bảng phẳng, không JOIN, phản hồi nhanh hơn và hai module
--  tách rời hoàn toàn (xem Mục 5.4 báo cáo — CQRS nhẹ).
-- =============================================================================
CREATE TABLE IF NOT EXISTS dining_table_state (
    table_id           UUID        PRIMARY KEY REFERENCES tables(id) ON DELETE CASCADE,
    table_code         TEXT        NOT NULL,
    state              TEXT        NOT NULL DEFAULT 'empty'
                                   CHECK (state IN ('empty','ordering','serving','awaiting_payment','inactive')),
    current_order_id   UUID,       -- KHÔNG đặt khoá ngoại: tránh ràng buộc cứng
    current_order_code TEXT,       -- vào lược đồ của module ordering
    current_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
    pending_guest_requests INTEGER NOT NULL DEFAULT 0,  -- số yêu cầu QR chờ duyệt
    occupied_since     TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dining_table_state_state_idx ON dining_table_state (state);

-- Khởi tạo bản ghi trạng thái cho mọi bàn hiện có
INSERT INTO dining_table_state (table_id, table_code, state)
SELECT t.id, t.code, CASE WHEN t.is_active THEN 'empty' ELSE 'inactive' END
  FROM tables t
ON CONFLICT (table_id) DO NOTHING;

COMMENT ON TABLE dining_table_state IS
  'Hình chiếu (read model) trạng thái bàn, cập nhật bằng sự kiện từ module ordering/billing';
COMMENT ON COLUMN dining_table_state.state IS
  'empty=trống | ordering=đang gọi món | serving=đang phục vụ | awaiting_payment=chờ thanh toán | inactive=tạm ngưng';
