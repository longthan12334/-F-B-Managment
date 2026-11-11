-- =============================================================================
--  MODULE: identity — Refresh token đã phát hành
--  Sở hữu: refresh_tokens
--  Mục đích: cho phép thu hồi phiên (logout, khoá tài khoản, đổi mật khẩu).
--  Chỉ lưu SHA-256 của token, không lưu token gốc — rò rỉ CSDL không đủ để
--  kẻ tấn công mạo danh người dùng.
-- =============================================================================
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT        NOT NULL UNIQUE,
    user_agent  TEXT,
    ip          TEXT,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    replaced_by TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx    ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_idx ON refresh_tokens (expires_at);

-- Cột mới cho CSDL đã tồn tại từ phiên bản trước
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS replaced_by TEXT;
ALTER TABLE users          ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

COMMENT ON TABLE  refresh_tokens            IS 'Refresh token đã phát hành (module identity)';
COMMENT ON COLUMN refresh_tokens.token_hash IS 'SHA-256 của refresh token, KHÔNG lưu token gốc';
COMMENT ON COLUMN refresh_tokens.replaced_by IS 'Hash của token thay thế khi xoay vòng (rotation)';
