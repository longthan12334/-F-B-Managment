// =============================================================================
//  PLATFORM — Cổng lưu trữ đối tượng (Port, theo Hexagonal Architecture)
// -----------------------------------------------------------------------------
//  Module nghiệp vụ (catalog, guest-access…) chỉ biết tới interface này, KHÔNG
//  biết phía sau là MinIO, AWS S3 hay Cloudflare R2. Đổi nhà cung cấp = đổi một
//  biến môi trường STORAGE_DRIVER, không sửa một dòng code nghiệp vụ nào.
// =============================================================================

/**
 * @typedef {Object} StoredObject
 * @property {string} key        Khoá đối tượng trong bucket (vd: menu/169...-ab12.jpg)
 * @property {string} url        URL truy cập (public hoặc đã ký)
 * @property {number} size       Kích thước byte
 * @property {string} contentType
 */

class StoragePort {
  /** Khởi tạo bucket, chính sách truy cập; chờ dịch vụ sẵn sàng. */
  async init() { throw new Error('not implemented'); }

  /**
   * Tải lên một buffer.
   * @returns {Promise<StoredObject>}
   */
  async upload(_buffer, _opts) { throw new Error('not implemented'); }

  /** Xoá một đối tượng (không ném lỗi nếu không tồn tại). */
  async remove(_key) { throw new Error('not implemented'); }

  /** URL truy cập đối tượng (public hoặc presigned tuỳ cấu hình). */
  async urlFor(_key) { throw new Error('not implemented'); }

  /** Kiểm tra sức khoẻ cho endpoint /api/health. */
  async healthCheck() { throw new Error('not implemented'); }

  /** Tên driver đang dùng — hiển thị ở /api/health. */
  get driverName() { return 'abstract'; }
}

module.exports = { StoragePort };
