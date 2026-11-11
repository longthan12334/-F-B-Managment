// =============================================================================
//  MODULE catalog · INFRASTRUCTURE — Truy cập menu_categories / menu_items
// =============================================================================
const db = require('../../../platform/database/pool');

const SELECT_ITEM = `
  SELECT mi.*, mc.code AS category_code, mc.name AS category_name
  FROM menu_items mi
  LEFT JOIN menu_categories mc ON mc.id = mi.category_id`;

class MenuRepository {
  async listCategories() {
    return db.query('SELECT * FROM menu_categories ORDER BY sort_order, name');
  }

  async findCategoryByCode(code) {
    return db.queryOne('SELECT * FROM menu_categories WHERE code = $1', [code]);
  }

  async findItems({ is_active, category_code, search } = {}) {
    const conds = [];
    const params = [];
    if (is_active !== undefined) { params.push(is_active);     conds.push(`mi.is_active = $${params.length}`); }
    if (category_code)           { params.push(category_code); conds.push(`mc.code = $${params.length}`); }
    if (search)                  { params.push(`%${search}%`); conds.push(`mi.name ILIKE $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return db.query(`${SELECT_ITEM} ${where} ORDER BY mc.sort_order NULLS LAST, mi.name`, params);
  }

  async findItemById(id) {
    return db.queryOne(`${SELECT_ITEM} WHERE mi.id = $1`, [id]);
  }

  async findItemByName(name) {
    return db.queryOne('SELECT * FROM menu_items WHERE LOWER(name) = LOWER($1)', [name]);
  }

  /** Các món ĐANG BÁN theo danh sách id — dùng khi định giá đơn hàng. */
  async findActiveByIds(ids) {
    if (!ids?.length) return [];
    return db.query(
      `SELECT id, name, price, emoji, image_url
       FROM menu_items
       WHERE id = ANY($1::uuid[]) AND is_active = TRUE`,
      [ids]
    );
  }

  async createItem({ name, description, price, category_id, emoji, image_url, image_key }) {
    return db.queryOne(
      `INSERT INTO menu_items (name, description, price, category_id, emoji, image_url, image_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, description || null, price, category_id || null, emoji || null, image_url || null, image_key || null]
    );
  }

  async updateItem(id, patch) {
    return db.queryOne(
      `UPDATE menu_items SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         price       = COALESCE($3, price),
         category_id = COALESCE($4, category_id),
         emoji       = COALESCE($5, emoji),
         image_url   = COALESCE($6, image_url),
         image_key   = COALESCE($7, image_key),
         is_active   = COALESCE($8, is_active),
         updated_at  = NOW()
       WHERE id = $9 RETURNING *`,
      [
        patch.name ?? null, patch.description ?? null, patch.price ?? null,
        patch.category_id ?? null, patch.emoji ?? null,
        patch.image_url ?? null, patch.image_key ?? null,
        patch.is_active ?? null, id,
      ]
    );
  }

  async removeItem(id) {
    return db.queryOne('DELETE FROM menu_items WHERE id = $1 RETURNING id, image_key', [id]);
  }

  async countItems() {
    const row = await db.queryOne('SELECT COUNT(*)::int AS count FROM menu_items');
    return row?.count ?? 0;
  }

  /** Dữ liệu mẫu cho môi trường demo — chỉ chạy khi thực đơn còn trống. */
  async seedSampleItems() {
    await db.query(`
      INSERT INTO menu_items (name, description, price, emoji, category_id) VALUES
        ('Gỏi Cuốn Tôm Thịt','Tôm tươi, thịt ba chỉ, rau sống, nước chấm.',65000,'🌯',(SELECT id FROM menu_categories WHERE code='starter')),
        ('Chả Giò Hải Sản','Tôm, mực, cua, chiên vàng giòn rụm.',75000,'🥚',(SELECT id FROM menu_categories WHERE code='starter')),
        ('Phở Bò Kobe','Nước dùng ninh 24 giờ, thịt bò Kobe nhập khẩu.',250000,'🍜',(SELECT id FROM menu_categories WHERE code='main')),
        ('Bò Lúc Lắc Khoai Tây','Bò Úc xào lúc lắc, khoai tây chiên, rau thơm.',185000,'🥩',(SELECT id FROM menu_categories WHERE code='main')),
        ('Cá Chẽm Sốt Chanh Dây','Cá chẽm áp chảo, sốt chanh dây đặc trưng.',210000,'🐟',(SELECT id FROM menu_categories WHERE code='main')),
        ('Bò Bít Tết Sốt Tiêu Xanh','Thăn bò 300g, sốt tiêu xanh thơm đậm.',320000,'🥩',(SELECT id FROM menu_categories WHERE code='main')),
        ('Cơm Chiên Hải Sản','Tôm, mực, cua, hành lá, trứng.',130000,'🍚',(SELECT id FROM menu_categories WHERE code='main')),
        ('Trà Tắc Mật Ong','Tắc tươi, mật ong, đá viên.',45000,'🧃',(SELECT id FROM menu_categories WHERE code='drink')),
        ('Cà Phê Sữa Đá','Cà phê phin truyền thống, sữa đặc.',35000,'☕',(SELECT id FROM menu_categories WHERE code='drink')),
        ('Sinh Tố Bơ','Bơ sáp, sữa tươi, đường.',55000,'🥑',(SELECT id FROM menu_categories WHERE code='drink')),
        ('Trà Đào Cam Sả','Trà đào, cam, sả thơm mát.',50000,'🍵',(SELECT id FROM menu_categories WHERE code='drink')),
        ('Trà Đá','Trà đá truyền thống.',5000,'🧊',(SELECT id FROM menu_categories WHERE code='drink')),
        ('Chè Khúc Bạch','Khúc bạch phô mai, hạnh nhân, vải.',45000,'🍨',(SELECT id FROM menu_categories WHERE code='dessert')),
        ('Bánh Flan Caramel','Flan trứng mềm mịn, caramel đắng nhẹ.',35000,'🍮',(SELECT id FROM menu_categories WHERE code='dessert'))
      ON CONFLICT (name) DO NOTHING
    `);
  }
}

module.exports = new MenuRepository();
