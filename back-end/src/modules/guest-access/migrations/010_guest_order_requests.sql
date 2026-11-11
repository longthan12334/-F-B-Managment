-- =============================================================================
--  MODULE: guest-access — LỊCH SỬ YÊU CẦU GỌI MÓN CỦA KHÁCH
--  Sở hữu: guest_order_requests
--  Phụ thuộc: guest_sessions, orders (ordering), users (identity)
-- -----------------------------------------------------------------------------
--  TRẢ LỜI NHẬN XÉT: "đã đặt được món, chưa xem lịch sử đặt ở bên khách hàng
--  (cần có xác nhận đơn)".
--
--  ── Vì sao cần bảng RIÊNG, không dùng luôn order_items? ─────────────────────
--  Hai bên nhìn cùng sự việc theo hai cách khác nhau:
--
--    Nhà hàng nhìn theo ĐƠN CỦA BÀN:
--        Bàn T1-01 · Đơn ORD-xxx · 7 món · 540.000 ₫
--
--    Khách nhìn theo LẦN BẤM "GỬI" CỦA MÌNH:
--        14:02  Gửi 3 món · Đã xác nhận
--        14:25  Gửi 2 món · 1 món bị từ chối (hết cá chẽm)
--        14:50  Gửi 2 món · Đang chờ nhà hàng xác nhận
--
--  Nếu chỉ có order_items thì không tái hiện được "lần gửi": các dòng món của
--  nhiều lượt gửi nằm lẫn nhau, không biết lượt nào đã duyệt, lượt nào bị từ
--  chối vì lý do gì. Bảng này là ĐƠN VỊ GIAO TIẾP VỚI KHÁCH — mỗi bản ghi là
--  một lần khách bấm "Gửi".
--
--  ── Liên kết hai thế giới ───────────────────────────────────────────────────
--      guest_order_requests.id  ──→  order_items.guest_request_id
--  Một yêu cầu sinh ra N dòng món. Nhân viên duyệt/từ chối ở cấp dòng món;
--  trạng thái tổng hợp của yêu cầu được tính lại từ các dòng đó:
--      tất cả confirmed              → confirmed
--      tất cả rejected               → rejected
--      vừa confirmed vừa rejected    → partially_confirmed
--      còn ít nhất một pending       → pending
--
--  ── Vì sao lưu cả `items_snapshot` (JSONB)? ─────────────────────────────────
--  Khách phải xem được lịch sử của mình KỂ CẢ khi đơn đã thanh toán và dòng
--  món đã khoá. Ảnh chụp JSONB giữ đúng tên món, số lượng, giá tại thời điểm
--  gửi — độc lập với mọi thay đổi sau này của thực đơn.
-- =============================================================================
CREATE TABLE IF NOT EXISTS guest_order_requests (
    id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    code               TEXT          UNIQUE NOT NULL
                                     DEFAULT ('REQ-' || to_char(NOW(),'YYMMDDHH24MISS') || '-' || substr(md5(random()::text),1,4)),

    guest_session_id   UUID          NOT NULL REFERENCES guest_sessions(id) ON DELETE CASCADE,
    table_id           UUID          NOT NULL,
    table_code         TEXT          NOT NULL,

    -- Đơn mà yêu cầu này được ghép vào (do module ordering tạo/dùng lại).
    -- KHÔNG đặt khoá ngoại cứng: giữ ranh giới giữa hai module, và lịch sử của
    -- khách vẫn còn ngay cả khi đơn bị xoá khỏi hệ thống vận hành.
    order_id           UUID,
    order_code         TEXT,
    created_new_order  BOOLEAN       NOT NULL DEFAULT FALSE,

    status             TEXT          NOT NULL DEFAULT 'pending'
                                     CHECK (status IN ('pending','confirmed','partially_confirmed','rejected','cancelled')),

    items_count        INTEGER       NOT NULL DEFAULT 0,
    amount             NUMERIC(12,2) NOT NULL DEFAULT 0,  -- tổng tiền lúc gửi
    confirmed_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,  -- tổng tiền thực sự được duyệt

    -- Ảnh chụp nội dung lúc gửi: [{menu_item_id,name,quantity,price,total_price,notes}]
    items_snapshot     JSONB         NOT NULL DEFAULT '[]'::jsonb,

    guest_note         TEXT,                               -- ghi chú chung của khách
    reviewed_by        UUID          REFERENCES users(id), -- nhân viên duyệt
    reviewed_by_name   TEXT,
    reviewed_at        TIMESTAMPTZ,
    reject_reason      TEXT,

    client_ip          TEXT,
    submitted_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Khách mở trang → lấy lịch sử của phiên mình, mới nhất trước
CREATE INDEX IF NOT EXISTS guest_requests_session_idx
  ON guest_order_requests (guest_session_id, submitted_at DESC);

-- Nhân viên mở hàng đợi duyệt → chỉ lấy yêu cầu đang chờ
CREATE INDEX IF NOT EXISTS guest_requests_pending_idx
  ON guest_order_requests (submitted_at ASC) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS guest_requests_order_idx ON guest_order_requests (order_id);
CREATE INDEX IF NOT EXISTS guest_requests_table_idx ON guest_order_requests (table_id, submitted_at DESC);

COMMENT ON TABLE  guest_order_requests                IS 'Mỗi bản ghi = một lần khách bấm "Gửi" trên trang QR (module guest-access)';
COMMENT ON COLUMN guest_order_requests.items_snapshot IS 'Ảnh chụp món lúc gửi, giữ nguyên dù thực đơn đổi về sau';
COMMENT ON COLUMN guest_order_requests.status         IS 'pending | confirmed | partially_confirmed | rejected | cancelled';
COMMENT ON COLUMN guest_order_requests.order_id       IS 'Không đặt khoá ngoại — giữ ranh giới với module ordering';
