// =============================================================================
//  MODULE billing · INTERFACE — Route tương thích ngược
// -----------------------------------------------------------------------------
//  Phiên bản 2 đặt thanh toán ở `POST /api/orders/:id/checkout`. Theo nguyên
//  tắc "endpoint thuộc về module sở hữu dữ liệu", từ v3 endpoint chính là
//  `POST /api/invoices`. Route dưới đây giữ cho ứng dụng di động bản cũ còn
//  chạy được trong giai đoạn chuyển tiếp; nó ghi cảnh báo mỗi lần được gọi để
//  theo dõi còn client nào chưa cập nhật.
//
//  Kế hoạch gỡ bỏ: khi nhật ký không còn cảnh báo trong 30 ngày.
// =============================================================================
const express = require('express');
const service = require('../application/checkout-service');
const identity = require('../../identity/contract');
const { created, asyncHandler } = require('../../../shared/http');
const { validateParams } = require('../../../shared/validation');
const log = require('../../../shared/logger').child('billing:legacy');

const router = express.Router();

router.post('/:id/checkout',
  identity.requireAuth,
  identity.requirePermission('invoice.checkout'),
  validateParams({ id: { required: true, type: 'uuid' } }),
  asyncHandler(async (req, res) => {
    log.warn('Endpoint cũ POST /api/orders/:id/checkout được gọi — hãy chuyển sang POST /api/invoices', {
      userAgent: req.headers['user-agent'], requestId: req.id,
    });
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', '</api/invoices>; rel="successor-version"');
    const invoice = await service.checkout(req.params.id, req.body || {}, req.user);
    return created(res, invoice, 'Thanh toán thành công');
  })
);

module.exports = router;
