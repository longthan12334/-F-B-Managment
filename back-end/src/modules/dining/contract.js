// =============================================================================
//  MODULE dining · CONTRACT — API công khai cho các module khác
// -----------------------------------------------------------------------------
//  `ordering` dùng contract này để kiểm tra bàn trước khi mở đơn; `guest-access`
//  dùng `findByQrKey` để tra bàn từ tham số trên mã QR.
//  Chiều phụ thuộc duy nhất: ordering → dining, guest-access → dining.
//  dining KHÔNG bao giờ gọi ngược lại — nó chỉ NGHE sự kiện.
// =============================================================================
const repo = require('./infrastructure/table-repository');
const stateRepo = require('./infrastructure/table-state-repository');
const service = require('./application/table-service');
const { TABLE_STATE } = require('./domain/table');

module.exports = {
  TABLE_STATE,

  /** Bàn theo id (kèm tên khu vực). */
  getTableById: (id) => repo.findById(id),

  /** Bàn theo mã hiển thị (T1-01). */
  getTableByCode: (code) => repo.findByCode(code),

  /** Bàn theo tham số trên URL mã QR (ưu tiên qr_slug, dự phòng mã bàn). */
  findByQrKey: (key) => repo.findByQrKey(key),

  /** Trạng thái hiện tại của một bàn trong hình chiếu. */
  getTableState: (tableId) => stateRepo.get(tableId),

  /** Thông tin in mã QR. */
  qrDescriptorFor: service.qrDescriptorFor,

  /**
   * Dựng lại hình chiếu trạng thái bàn từ danh sách đơn đang mở.
   * `ordering` gọi hàm này một lần lúc khởi động để tự chữa lành nếu có sự
   * kiện bị mất khi server dừng đột ngột.
   */
  rebuildOccupancy: (openOrders) => stateRepo.rebuild(openOrders),
};
