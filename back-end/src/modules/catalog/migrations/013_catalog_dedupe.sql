-- =============================================================================
--  MODULE: catalog — Dọn món trùng tên & khoá ràng buộc UNIQUE
--  (Chuyển từ migration 002_dedupe_menu.sql của phiên bản trước)
--  Idempotent: chạy lại nhiều lần không gây lỗi.
-- =============================================================================

-- Gộp các món trùng tên: giữ bản ghi cũ nhất, chuyển order_items về bản đó
DO $$
DECLARE
  rec RECORD;
  keep_id UUID;
BEGIN
  IF to_regclass('public.order_items') IS NULL THEN
    RETURN; -- CSDL mới, chưa có bảng order_items thì không cần gộp
  END IF;

  FOR rec IN SELECT name FROM menu_items GROUP BY name HAVING COUNT(*) > 1 LOOP
    SELECT id INTO keep_id FROM menu_items WHERE name = rec.name ORDER BY created_at ASC LIMIT 1;

    UPDATE order_items SET menu_item_id = keep_id
     WHERE menu_item_id IN (SELECT id FROM menu_items WHERE name = rec.name AND id <> keep_id);

    DELETE FROM menu_items WHERE name = rec.name AND id <> keep_id;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_items_name_key') THEN
    ALTER TABLE menu_items ADD CONSTRAINT menu_items_name_key UNIQUE (name);
  END IF;
END $$;
