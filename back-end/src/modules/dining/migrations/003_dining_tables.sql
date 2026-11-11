-- =============================================================================
--  MODULE: dining — Khu vực & bàn ăn
--  Sở hữu: dining_zones, tables
--  Phụ thuộc: không
-- =============================================================================

-- ─── Khu vực ────────────────────────────────────────────────────────────────
-- Phiên bản trước nhúng cứng danh sách khu vực trong mã nguồn (['indoor',
-- 'outdoor','vip']) trong khi dữ liệu mẫu lại dùng 't1'/'garden' → thêm bàn
-- khu vực mới phải sửa code và deploy lại. Nay khu vực là DỮ LIỆU.
CREATE TABLE IF NOT EXISTS dining_zones (
    code       TEXT        PRIMARY KEY,
    name       TEXT        NOT NULL,
    sort_order INTEGER     NOT NULL DEFAULT 0,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO dining_zones (code, name, sort_order) VALUES
  ('indoor',  'Trong nhà', 1),
  ('outdoor', 'Sân vườn',  2),
  ('vip',     'Phòng VIP', 3)
ON CONFLICT (code) DO NOTHING;

-- ─── Bàn ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tables (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    code       TEXT        UNIQUE NOT NULL,          -- mã hiển thị: T1-01
    zone       TEXT        NOT NULL,                 -- FK thêm ở dưới (dữ liệu cũ cần chuẩn hoá trước)
    capacity   INTEGER     NOT NULL CHECK (capacity > 0 AND capacity <= 20),
    qr_slug    TEXT        UNIQUE,                   -- chuỗi ngẫu nhiên dùng trong URL mã QR
    note       TEXT,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tables ADD COLUMN IF NOT EXISTS qr_slug    TEXT;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS note       TEXT;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Chuẩn hoá dữ liệu khu vực cũ sang bộ mã mới
UPDATE tables SET zone = 'indoor'  WHERE zone IN ('t1', 'T1', 'tang1');
UPDATE tables SET zone = 'outdoor' WHERE zone IN ('garden', 'sv', 'SV');
-- Khu vực lạ còn sót lại → tạo bản ghi tương ứng để không mất dữ liệu
INSERT INTO dining_zones (code, name, sort_order)
SELECT DISTINCT t.zone, INITCAP(t.zone), 90
  FROM tables t
 WHERE NOT EXISTS (SELECT 1 FROM dining_zones z WHERE z.code = t.zone)
ON CONFLICT (code) DO NOTHING;

-- Giờ mới gắn khoá ngoại được (mọi giá trị zone đều đã tồn tại)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tables_zone_fkey') THEN
    ALTER TABLE tables
      ADD CONSTRAINT tables_zone_fkey FOREIGN KEY (zone)
      REFERENCES dining_zones(code) ON UPDATE CASCADE;
  END IF;
END $$;

-- Sinh qr_slug cho các bàn chưa có (8 ký tự hex, không đoán được)
UPDATE tables
   SET qr_slug = SUBSTR(ENCODE(gen_random_bytes(8), 'hex'), 1, 12)
 WHERE qr_slug IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tables_qr_slug_key') THEN
    ALTER TABLE tables ADD CONSTRAINT tables_qr_slug_key UNIQUE (qr_slug);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS tables_zone_idx ON tables (zone);

-- Bàn mẫu
INSERT INTO tables (code, zone, capacity) VALUES
  ('T1-01','indoor',4), ('T1-02','indoor',2), ('T1-03','indoor',4),
  ('T1-04','indoor',6), ('T1-05','indoor',2), ('T1-06','indoor',4),
  ('SV-01','outdoor',6),('SV-02','outdoor',6),
  ('SV-03','outdoor',8),('SV-04','outdoor',4),
  ('VIP-01','vip',10)
ON CONFLICT (code) DO NOTHING;

UPDATE tables SET qr_slug = SUBSTR(ENCODE(gen_random_bytes(8), 'hex'), 1, 12) WHERE qr_slug IS NULL;

COMMENT ON TABLE  tables         IS 'Bàn ăn — mỗi bàn ứng với đúng một mã QR (module dining)';
COMMENT ON COLUMN tables.qr_slug IS 'Chuỗi ngẫu nhiên trong URL mã QR; không dùng mã bàn để tránh đoán được link bàn khác';
COMMENT ON COLUMN tables.is_active IS 'FALSE = bàn tạm ngưng (sửa chữa), không nhận đơn mới';
