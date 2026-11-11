-- =============================================================================
--  MODULE: billing — Hoá đơn & thanh toán
--  Sở hữu: invoices, invoice_items
--  Phụ thuộc: orders (ordering), users (identity)
-- -----------------------------------------------------------------------------
--  VÌ SAO SAO CHÉP DÒNG MÓN SANG invoice_items THAY VÌ THAM CHIẾU order_items?
--  Hoá đơn là CHỨNG TỪ TÀI CHÍNH: nội dung phải bất biến. Nếu chỉ tham chiếu,
--  một lần sửa tên hay giá món trong thực đơn sẽ làm hoá đơn đã in tháng trước
--  hiển thị khác đi. Sao chép ("snapshot") đảm bảo hoá đơn luôn phản ánh đúng
--  thời điểm phát hành — đây là yêu cầu kế toán, không phải dư thừa dữ liệu.
-- =============================================================================
CREATE TABLE IF NOT EXISTS invoices (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    code            TEXT          UNIQUE NOT NULL
                                  DEFAULT ('INV-' || to_char(NOW(),'YYMMDDHH24MISS') || '-' || substr(md5(random()::text),1,4)),
    order_id        UUID          NOT NULL UNIQUE REFERENCES orders(id),
    table_code      TEXT          NOT NULL,
    waiter_name     TEXT          NOT NULL,
    cashier_id      UUID          REFERENCES users(id),
    cashier_name    TEXT          NOT NULL,
    total_amount    NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),
    discount        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
    discount_note   TEXT,
    vat_rate        NUMERIC(5,2)  NOT NULL DEFAULT 8  CHECK (vat_rate >= 0 AND vat_rate <= 100),
    vat_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
    final_amount    NUMERIC(12,2) NOT NULL CHECK (final_amount >= 0),
    paid_amount     NUMERIC(12,2),
    change_amount   NUMERIC(12,2),
    check_in_time   TIMESTAMPTZ   NOT NULL,
    check_out_time  TIMESTAMPTZ   NOT NULL,
    payment_method  TEXT          NOT NULL DEFAULT 'cash',
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_amount   NUMERIC(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS change_amount NUMERIC(12,2);
UPDATE invoices SET paid_amount   = final_amount WHERE paid_amount   IS NULL;
UPDATE invoices SET change_amount = 0            WHERE change_amount IS NULL;

-- Danh sách phương thức thanh toán: mở rộng dần mà không phá dữ liệu cũ
DO $$
DECLARE cname TEXT;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'invoices'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%payment_method%';
  IF cname IS NOT NULL THEN EXECUTE format('ALTER TABLE invoices DROP CONSTRAINT %I', cname); END IF;
END $$;

ALTER TABLE invoices ADD CONSTRAINT invoices_payment_method_check
  CHECK (payment_method IN ('cash','card','transfer','online','grab','vnpay','banking','momo','zalopay'));

-- Báo cáo doanh thu luôn lọc theo khoảng thời gian
CREATE INDEX IF NOT EXISTS invoices_created_idx  ON invoices (created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_cashier_idx  ON invoices (cashier_id);
CREATE INDEX IF NOT EXISTS invoices_method_idx   ON invoices (payment_method);

CREATE TABLE IF NOT EXISTS invoice_items (
    id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id    UUID          NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    order_item_id UUID,                      -- chỉ để truy vết, KHÔNG đặt khoá ngoại
    item_name     TEXT          NOT NULL,    -- bản sao tại thời điểm xuất hoá đơn
    quantity      INTEGER       NOT NULL CHECK (quantity > 0),
    price         NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    total_price   NUMERIC(12,2) NOT NULL CHECK (total_price >= 0),
    notes         TEXT
);

CREATE INDEX IF NOT EXISTS invoice_items_invoice_idx ON invoice_items (invoice_id);
CREATE INDEX IF NOT EXISTS invoice_items_name_idx    ON invoice_items (item_name);

COMMENT ON TABLE  invoices            IS 'Hoá đơn đã phát hành (module billing) — nội dung bất biến';
COMMENT ON COLUMN invoices.order_id   IS 'UNIQUE: mỗi đơn chỉ được xuất đúng một hoá đơn';
COMMENT ON COLUMN invoice_items.item_name IS 'Bản sao tên món lúc xuất hoá đơn, không đổi theo thực đơn';
