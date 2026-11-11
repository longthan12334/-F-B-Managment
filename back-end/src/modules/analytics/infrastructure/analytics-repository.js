// =============================================================================
//  MODULE analytics · INFRASTRUCTURE — Đọc/ghi hình chiếu báo cáo
// =============================================================================
const db = require('../../../platform/database/pool');
const { config } = require('../../../shared/config');

const TZ = config.business.timezone;

class AnalyticsRepository {
  /** Cộng dồn một hoá đơn vào ô (ngày, giờ) tương ứng. */
  async applyInvoice({ created_at, total_amount, discount, vat_amount, final_amount, payment_method }, client) {
    const r = db.runner(client);
    return r.queryOne(
      `INSERT INTO analytics_revenue_hourly AS a
         (bucket_day, bucket_hour, invoice_count, gross_amount, discount_total, vat_total, net_revenue, by_method)
       VALUES (
         ($1::timestamptz AT TIME ZONE $8)::date,
         EXTRACT(HOUR FROM $1::timestamptz AT TIME ZONE $8)::smallint,
         1, $2, $3, $4, $5, jsonb_build_object($6::text, $7::numeric)
       )
       ON CONFLICT (bucket_day, bucket_hour) DO UPDATE SET
         invoice_count  = a.invoice_count  + 1,
         gross_amount   = a.gross_amount   + EXCLUDED.gross_amount,
         discount_total = a.discount_total + EXCLUDED.discount_total,
         vat_total      = a.vat_total      + EXCLUDED.vat_total,
         net_revenue    = a.net_revenue    + EXCLUDED.net_revenue,
         by_method      = a.by_method ||
           jsonb_build_object($6::text,
             COALESCE((a.by_method ->> $6::text)::numeric, 0) + $7::numeric),
         updated_at     = NOW()
       RETURNING *`,
      [created_at, total_amount, discount, vat_amount, final_amount, payment_method, final_amount, TZ]
    );
  }

  /** Cộng dồn các dòng món của hoá đơn vào bảng xếp hạng. */
  async applyItems(created_at, items, client) {
    const r = db.runner(client);
    for (const it of items) {
      await r.query(
        `INSERT INTO analytics_item_sales AS s (bucket_day, item_name, quantity, revenue, last_price)
         VALUES (($1::timestamptz AT TIME ZONE $5)::date, $2, $3, $4, $6)
         ON CONFLICT (bucket_day, item_name) DO UPDATE SET
           quantity   = s.quantity + EXCLUDED.quantity,
           revenue    = s.revenue  + EXCLUDED.revenue,
           last_price = EXCLUDED.last_price,
           updated_at = NOW()`,
        [created_at, it.item_name, it.quantity, it.total_price, TZ, it.price]
      );
    }
  }

  async revenueBetween(from, to) {
    return db.queryOne(
      `SELECT COALESCE(SUM(invoice_count),0)::int        AS invoice_count,
              COALESCE(SUM(gross_amount),0)::numeric     AS gross_amount,
              COALESCE(SUM(discount_total),0)::numeric   AS discount_total,
              COALESCE(SUM(vat_total),0)::numeric        AS vat_total,
              COALESCE(SUM(net_revenue),0)::numeric      AS net_revenue
       FROM analytics_revenue_hourly
       WHERE bucket_day BETWEEN ($1::timestamptz AT TIME ZONE $3)::date
                            AND ($2::timestamptz AT TIME ZONE $3)::date`,
      [from, to, TZ]
    );
  }

  async hourlyForDay(day) {
    return db.query(
      `SELECT bucket_hour AS hour, invoice_count::int AS count, net_revenue::numeric AS revenue
       FROM analytics_revenue_hourly
       WHERE bucket_day = ($1::timestamptz AT TIME ZONE $2)::date
       ORDER BY bucket_hour`,
      [day, TZ]
    );
  }

  async dailySeries(days = 14) {
    return db.query(
      `SELECT bucket_day AS day,
              SUM(invoice_count)::int      AS invoice_count,
              SUM(net_revenue)::numeric    AS revenue
       FROM analytics_revenue_hourly
       WHERE bucket_day >= (NOW() AT TIME ZONE $2)::date - ($1::int - 1)
       GROUP BY bucket_day ORDER BY bucket_day`,
      [days, TZ]
    );
  }

  async paymentBreakdown(from, to) {
    return db.query(
      `SELECT key AS payment_method, SUM(value::numeric)::numeric AS revenue
       FROM analytics_revenue_hourly, jsonb_each_text(by_method)
       WHERE bucket_day BETWEEN ($1::timestamptz AT TIME ZONE $3)::date
                            AND ($2::timestamptz AT TIME ZONE $3)::date
       GROUP BY key ORDER BY revenue DESC`,
      [from, to, TZ]
    );
  }

  async topItems(from, to, limit = 5) {
    return db.query(
      `SELECT item_name AS name, SUM(quantity)::int AS qty,
              SUM(revenue)::numeric AS revenue, MAX(last_price)::numeric AS price
       FROM analytics_item_sales
       WHERE bucket_day BETWEEN ($1::timestamptz AT TIME ZONE $4)::date
                            AND ($2::timestamptz AT TIME ZONE $4)::date
       GROUP BY item_name ORDER BY qty DESC LIMIT $3`,
      [from, to, limit, TZ]
    );
  }

  async isEmpty() {
    const row = await db.queryOne('SELECT COUNT(*)::int AS count FROM analytics_revenue_hourly');
    return (row?.count ?? 0) === 0;
  }

  async truncate() {
    await db.query('TRUNCATE analytics_revenue_hourly');
    await db.query('TRUNCATE analytics_item_sales');
  }
}

module.exports = new AnalyticsRepository();
