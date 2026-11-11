-- =============================================================================
--  MODULE: identity — Bảng tài khoản nhân viên
--  Sở hữu: users
--  Phụ thuộc: không (module nền — các module khác tham chiếu users.id)
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    username      TEXT        UNIQUE NOT NULL,
    password_hash TEXT        NOT NULL,
    full_name     TEXT        NOT NULL,
    role          TEXT        NOT NULL CHECK (role IN ('admin','cashier','waiter')),
    email         TEXT,
    phone         TEXT,
    avatar_url    TEXT,
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tra cứu khi đăng nhập (username đã UNIQUE nên đã có index);
-- index phụ cho màn hình quản trị lọc theo vai trò + trạng thái.
CREATE INDEX IF NOT EXISTS users_role_active_idx ON users (role, is_active);

COMMENT ON TABLE  users          IS 'Tài khoản nhân viên (module identity)';
COMMENT ON COLUMN users.role     IS 'admin | cashier | waiter';
COMMENT ON COLUMN users.is_active IS 'FALSE = khoá tài khoản, không đăng nhập được';
