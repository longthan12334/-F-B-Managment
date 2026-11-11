// =============================================================================
//  PLATFORM — Factory chọn driver lưu trữ theo cấu hình
// -----------------------------------------------------------------------------
//  Module nghiệp vụ `require('platform/storage')` và nhận về một đối tượng
//  tuân thủ StoragePort. Việc chọn MinIO / S3 / R2 nằm gọn trong file này.
// =============================================================================
const { config } = require('../../shared/config');
const { S3CompatibleAdapter } = require('./s3-compatible-adapter');
const { StoragePort } = require('./storage-port');
const log = require('../../shared/logger').child('storage');

const SUPPORTED = ['minio', 's3', 'r2'];

function createStorage(settings = config.storage) {
  if (!SUPPORTED.includes(settings.driver)) {
    log.warn(`STORAGE_DRIVER='${settings.driver}' không hỗ trợ — dùng 'minio'. Hợp lệ: ${SUPPORTED.join(', ')}`);
  }
  // Cả ba nhà cung cấp đều nói giao thức S3 → dùng chung một adapter.
  return new S3CompatibleAdapter(settings);
}

const storage = createStorage();

module.exports = storage;
module.exports.createStorage = createStorage;
module.exports.StoragePort = StoragePort;
module.exports.SUPPORTED_DRIVERS = SUPPORTED;
