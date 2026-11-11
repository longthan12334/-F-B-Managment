// =============================================================================
//  MODULE catalog · INTERFACE — REST /api/files (tải tệp lên kho đối tượng)
// -----------------------------------------------------------------------------
//  Endpoint dùng chung để tải ảnh/tệp lên MinIO · S3 · R2. Đặt trong catalog vì
//  đây là module duy nhất hiện có nhu cầu lưu tệp; nếu sau này nhiều module cần
//  thì tách thành module `media` riêng (chỉ phải di chuyển thư mục này).
// =============================================================================
const express = require('express');
const multer = require('multer');
const storage = require('../../../platform/storage');
const identity = require('../../identity/contract');
const { created, ok, asyncHandler } = require('../../../shared/http');
const { AppError } = require('../../../shared/errors');
const { config } = require('../../../shared/config');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.storage.maxUploadBytes, files: 1 },
});

router.post('/upload',
  identity.requireAuth, identity.requirePermission('menu.write'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw AppError.validation('Thiếu tệp', ['file: bắt buộc (multipart field "file")']);
    if (!storage.ready) {
      throw new AppError('Kho ảnh đang bảo trì, vui lòng thử lại sau', {
        status: 503, code: 'STORAGE_UNAVAILABLE',
      });
    }
    const result = await storage.upload(req.file.buffer, {
      originalName: req.file.originalname,
      contentType: req.file.mimetype,
      prefix: (req.body?.prefix || 'misc'),
    });
    return created(res, result, 'Tải tệp thành công');
  })
);

/** Trạng thái kho đối tượng — hữu ích khi chuyển MinIO → R2 và cần kiểm chứng. */
router.get('/storage-info',
  identity.requireAuth, identity.requireRole('admin'),
  asyncHandler(async (_req, res) => ok(res, {
    driver: storage.driverName,
    bucket: config.storage.bucket,
    public_url: config.storage.publicUrl,
    signed_urls: config.storage.signedUrls,
    health: await storage.healthCheck(),
  }))
);

module.exports = router;
