-- =============================================================================
--  MODULE: catalog — Thực đơn
--  Sở hữu: menu_categories, menu_items
--  Phụ thuộc: không (bảng độc lập; ordering chỉ tham chiếu menu_items.id)
-- =============================================================================
CREATE TABLE IF NOT EXISTS menu_categories (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    code       TEXT        UNIQUE NOT NULL,
    name       TEXT        NOT NULL,
    sort_order INTEGER     NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS menu_items (
    id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT          NOT NULL UNIQUE,
    description TEXT,
    price       NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    category_id UUID          REFERENCES menu_categories(id) ON DELETE SET NULL,
    emoji       TEXT,
    image_url   TEXT,                       -- URL hiển thị (public hoặc đã ký)
    image_key   TEXT,                       -- khoá đối tượng trong bucket S3/R2/MinIO
    is_active   BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Thực đơn luôn được lọc theo "đang bán" + sắp theo danh mục
CREATE INDEX IF NOT EXISTS menu_items_active_idx   ON menu_items (is_active);
CREATE INDEX IF NOT EXISTS menu_items_category_idx ON menu_items (category_id);

-- Danh mục chuẩn
INSERT INTO menu_categories (code, name, sort_order) VALUES
  ('starter','Khai vị',1),
  ('main','Món chính',2),
  ('drink','Đồ uống',3),
  ('dessert','Tráng miệng',4)
ON CONFLICT (code) DO NOTHING;

COMMENT ON TABLE  menu_items           IS 'Món ăn trong thực đơn (module catalog)';
COMMENT ON COLUMN menu_items.image_key IS 'Khoá đối tượng trong kho S3-compatible; dùng để xoá ảnh cũ khi cập nhật';
COMMENT ON COLUMN menu_items.is_active IS 'FALSE = ngừng bán, không hiện trên thực đơn khách';
