-- =============================================================================
--  MODULE: analytics — Hình chiếu phục vụ báo cáo (CQRS read model)
--  Sở hữu: analytics_revenue_hourly, analytics_item_sales
-- -----------------------------------------------------------------------------
--  VÌ SAO KHÔNG TRUY VẤN THẲNG BẢNG invoices?
--
--  1. RANH GIỚI MODULE: `invoices` thuộc module billing. Nếu analytics viết SQL
--     lên bảng đó, mọi thay đổi lược đồ của billing sẽ làm hỏng báo cáo — đúng
--     thứ mà Modular Monolith muốn tránh.
--
--  2. HIỆU NĂNG: dashboard gọi liên tục. Quét toàn bộ invoices + invoice_items
--     rồi GROUP BY mỗi lần tải trang là lãng phí; sau một năm vận hành sẽ chậm
--     rõ rệt. Hình chiếu được cộng dồn sẵn theo giờ, truy vấn chỉ đọc vài dòng.
--
--  3. KHẢ NĂNG TÁI TẠO: hình chiếu luôn dựng lại được từ nguồn sự thật
--     (billing.listInvoices) — xem hàm rebuild() trong analytics-service.
--
--  Cập nhật: analytics nghe sự kiện `billing.invoice.issued` và cộng dồn.
-- =============================================================================

-- Doanh thu theo GIỜ: đủ mịn cho biểu đồ theo giờ trong ngày, đồng thời tổng
-- hợp lên ngày/tuần/tháng bằng một phép SUM.
CREATE TABLE IF NOT EXISTS analytics_revenue_hourly (
    bucket_day     DATE          NOT NULL,
    bucket_hour    SMALLINT      NOT NULL CHECK (bucket_hour BETWEEN 0 AND 23),
    invoice_count  INTEGER       NOT NULL DEFAULT 0,
    gross_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,  -- tiền món trước giảm giá
    discount_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    vat_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
    net_revenue    NUMERIC(14,2) NOT NULL DEFAULT 0,  -- số tiền thực thu
    by_method      JSONB         NOT NULL DEFAULT '{}'::jsonb,
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (bucket_day, bucket_hour)
);

CREATE INDEX IF NOT EXISTS analytics_revenue_day_idx ON analytics_revenue_hourly (bucket_day DESC);

-- Doanh số theo MÓN theo ngày: phục vụ bảng xếp hạng món bán chạy
CREATE TABLE IF NOT EXISTS analytics_item_sales (
    bucket_day   DATE          NOT NULL,
    item_name    TEXT          NOT NULL,
    quantity     INTEGER       NOT NULL DEFAULT 0,
    revenue      NUMERIC(14,2) NOT NULL DEFAULT 0,
    last_price   NUMERIC(12,2),
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (bucket_day, item_name)
);

CREATE INDEX IF NOT EXISTS analytics_item_sales_day_idx ON analytics_item_sales (bucket_day DESC, quantity DESC);

COMMENT ON TABLE analytics_revenue_hourly IS
  'Hình chiếu doanh thu theo giờ, cộng dồn từ sự kiện billing.invoice.issued (module analytics)';
COMMENT ON TABLE analytics_item_sales IS
  'Hình chiếu doanh số theo món theo ngày (module analytics)';
