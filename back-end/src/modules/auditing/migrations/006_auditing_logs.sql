-- =============================================================================
--  MODULE: auditing — Nhật ký hoạt động
--  Sở hữu: activity_logs
-- -----------------------------------------------------------------------------
--  Module này KHÔNG được module nào gọi tới. Nó chỉ lắng nghe sự kiện trên
--  event bus bằng mẫu đại diện ('*') và ghi lại. Đó là lý do có thể thêm mới
--  hoặc gỡ bỏ auditing mà không cần sửa một dòng nào ở các module khác — minh
--  hoạ rõ nhất cho nguyên tắc "tách rời bằng sự kiện".
-- =============================================================================
CREATE TABLE IF NOT EXISTS activity_logs (
    id          BIGSERIAL   PRIMARY KEY,
    event       TEXT,                    -- tên sự kiện: ordering.order.created
    module      TEXT,                    -- module phát sự kiện: ordering
    action      TEXT        NOT NULL,    -- nhãn ngắn hiển thị: CREATE_ORDER
    entity      TEXT,                    -- ORDER | INVOICE | USER | TABLE | MENU_ITEM
    entity_id   TEXT,
    user_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
    user_name   TEXT,
    details     JSONB,
    ip          TEXT,
    request_id  TEXT,                    -- lần ngược toàn bộ chuỗi xử lý
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS event      TEXT;
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS module     TEXT;
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS request_id TEXT;

CREATE INDEX IF NOT EXISTS logs_created_idx ON activity_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS logs_action_idx  ON activity_logs (action);
CREATE INDEX IF NOT EXISTS logs_module_idx  ON activity_logs (module);
CREATE INDEX IF NOT EXISTS logs_entity_idx  ON activity_logs (entity, entity_id);

COMMENT ON TABLE  activity_logs        IS 'Nhật ký hoạt động, ghi tự động từ event bus (module auditing)';
COMMENT ON COLUMN activity_logs.request_id IS 'Mã request sinh ra sự kiện — nối toàn bộ chuỗi xử lý bất đồng bộ';
