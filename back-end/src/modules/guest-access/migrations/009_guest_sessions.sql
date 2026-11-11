-- =============================================================================
--  MODULE: guest-access — PHIÊN KHÁCH QUÉT MÃ QR
--  Sở hữu: guest_sessions
--  Phụ thuộc: tables (dining)
-- -----------------------------------------------------------------------------
--  ĐÂY LÀ PHẦN TRẢ LỜI TRỰC TIẾP NHẬN XÉT CỦA GIẢNG VIÊN:
--  "chưa rõ được về việc lưu thông tin khi khách đặt qua QR (chưa nắm được
--   thiết kế bảng)".
--
--  ── Bài toán ────────────────────────────────────────────────────────────────
--  Khách quét QR KHÔNG có tài khoản. Nhưng hệ thống vẫn cần biết:
--    1. Ai đang gọi món ở bàn nào, để món vào đúng đơn.
--    2. Khi khách mở lại trang, phải thấy LẠI lịch sử món mình đã gọi
--       (không thấy món của bàn khác, cũng không thấy món của khách khác
--        ngồi cùng bàn nhưng quét bằng điện thoại khác nếu không cùng phiên).
--    3. Chống spam: một thiết bị không thể tạo vô hạn đơn ảo.
--    4. Phiên phải TỰ HẾT HẠN — mã QR dán cố định trên bàn, nếu phiên sống mãi
--       thì người đi ngang quét một lần có thể gọi món cho bàn đó mãi về sau.
--
--  ── Giải pháp: bảng guest_sessions ──────────────────────────────────────────
--  Khi khách quét QR, máy chủ tạo một PHIÊN KHÁCH và cấp một `guest token`
--  (chuỗi ký HMAC) lưu trong localStorage của trình duyệt khách. Mọi lời gọi
--  sau đó gửi kèm token này qua header `X-Guest-Token`.
--
--  ── Vì sao chỉ lưu HASH của token? ──────────────────────────────────────────
--  Giống mật khẩu: nếu CSDL bị lộ, kẻ tấn công không thể mạo danh phiên của
--  khách. Hash SHA-256, không lưu token gốc.
--
--  ── Vì sao các trường định danh đều cho phép NULL? ──────────────────────────
--  Nguyên tắc tối thiểu hoá dữ liệu cá nhân: khách KHÔNG bắt buộc nhập tên hay
--  số điện thoại mới gọi được món. Hai trường đó chỉ dùng khi khách tự nhập để
--  nhân viên gọi đúng người ("Anh Minh bàn 5"). Không thu thập thì không phải
--  bảo vệ, và cũng phù hợp Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân.
--
--  ── Vì sao lưu ip / user_agent? ─────────────────────────────────────────────
--  Chỉ phục vụ chống gian lận và điều tra sự cố (một thiết bị spam 50 đơn).
--  Có thời hạn xoá rõ ràng (xem tác vụ dọn phiên trong index.js).
-- =============================================================================
CREATE TABLE IF NOT EXISTS guest_sessions (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Bàn mà phiên này gắn với. Mã QR = bàn, nên một phiên chỉ phục vụ một bàn.
    table_id           UUID        NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    table_code         TEXT        NOT NULL,

    -- Xác thực phiên: chỉ lưu SHA-256 của guest token
    token_hash         TEXT        NOT NULL UNIQUE,

    -- Thông tin khách TỰ NGUYỆN cung cấp (đều cho phép NULL)
    display_name       TEXT,                 -- "Anh Minh", "Bàn 5 - nhóm 4 người"
    phone              TEXT,                 -- chỉ khi khách muốn nhận hoá đơn điện tử

    -- Dấu vết kỹ thuật phục vụ chống gian lận
    user_agent         TEXT,
    ip                 TEXT,

    -- Vòng đời phiên
    status             TEXT        NOT NULL DEFAULT 'active'
                                   CHECK (status IN ('active','closed','expired','blocked')),
    started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at         TIMESTAMPTZ NOT NULL,
    closed_at          TIMESTAMPTZ,
    close_reason       TEXT,

    -- Thống kê nhanh, tránh COUNT(*) mỗi lần khách mở trang
    request_count      INTEGER     NOT NULL DEFAULT 0,
    total_items_count  INTEGER     NOT NULL DEFAULT 0,
    total_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,

    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tra phiên còn sống của một bàn (khách cùng bàn quét lại thì dùng lại phiên)
CREATE INDEX IF NOT EXISTS guest_sessions_table_active_idx
  ON guest_sessions (table_id, status, expires_at DESC);
CREATE INDEX IF NOT EXISTS guest_sessions_expires_idx ON guest_sessions (expires_at);

COMMENT ON TABLE  guest_sessions              IS 'Phiên của khách quét mã QR tại bàn (module guest-access)';
COMMENT ON COLUMN guest_sessions.token_hash   IS 'SHA-256 của guest token; không lưu token gốc';
COMMENT ON COLUMN guest_sessions.display_name IS 'Tên khách TỰ NHẬP, không bắt buộc — tối thiểu hoá dữ liệu cá nhân';
COMMENT ON COLUMN guest_sessions.expires_at   IS 'Phiên tự hết hạn (mặc định 6 giờ) vì mã QR dán cố định trên bàn';
COMMENT ON COLUMN guest_sessions.status       IS 'active | closed (thanh toán xong) | expired (hết hạn) | blocked (chặn vì spam)';
