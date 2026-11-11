// =============================================================================
//  MODULE dining · INTERFACE — REST /api/tables
// -----------------------------------------------------------------------------
//  Lưu ý thiết kế: thao tác "dọn bàn" (huỷ đơn đang mở) KHÔNG nằm ở đây mà ở
//  module `ordering` (POST /api/orders/clear-table/:tableId), vì bản chất nó
//  thay đổi dữ liệu đơn hàng — tài sản của ordering. Endpoint được đặt theo
//  QUYỀN SỞ HỮU DỮ LIỆU, không theo cách gom nhóm của giao diện.
// =============================================================================
const express = require('express');
const service = require('../application/table-service');
const identity = require('../../identity/contract');
const { ok, created, asyncHandler } = require('../../../shared/http');
const { validateBody, validateParams } = require('../../../shared/validation');

const router = express.Router();
const idParam = validateParams({ id: { required: true, type: 'uuid' } });

router.use(identity.requireAuth);

// ─── Khu vực ────────────────────────────────────────────────────────────────
router.get('/zones', asyncHandler(async (_req, res) => ok(res, await service.listZones())));

// ─── Sơ đồ bàn ──────────────────────────────────────────────────────────────
router.get('/', identity.requirePermission('table.read'), asyncHandler(async (req, res) => {
  const tables = await service.listTables({
    zone: req.query.zone,
    withStatus: req.query.with_status === 'true',
  });
  return ok(res, tables, { meta: { total: tables.length } });
}));

router.get('/:id', identity.requirePermission('table.read'), idParam, asyncHandler(async (req, res) =>
  ok(res, await service.getTable(req.params.id))
));

/** Dữ liệu để in mã QR của một bàn. */
router.get('/:id/qr', identity.requirePermission('table.read'), idParam, asyncHandler(async (req, res) =>
  ok(res, service.qrDescriptorFor(await service.getTable(req.params.id)))
));

// ─── Quản trị ───────────────────────────────────────────────────────────────
router.post('/',
  identity.requirePermission('table.write'),
  validateBody({
    code:     { required: true, type: 'string', minLength: 2, maxLength: 16 },
    zone:     { required: true, type: 'string', minLength: 1, maxLength: 32 },
    capacity: { required: true, type: 'integer', min: 1, max: 20 },
    note:     { type: 'string', maxLength: 255 },
  }),
  asyncHandler(async (req, res) =>
    created(res, await service.createTable(req.body, req.user), 'Tạo bàn thành công')
  )
);

router.put('/:id',
  identity.requirePermission('table.write'), idParam,
  validateBody({
    code:      { type: 'string', minLength: 2, maxLength: 16 },
    zone:      { type: 'string', minLength: 1, maxLength: 32 },
    capacity:  { type: 'integer', min: 1, max: 20 },
    note:      { type: 'string', maxLength: 255 },
    is_active: { type: 'boolean' },
  }),
  asyncHandler(async (req, res) =>
    ok(res, await service.updateTable(req.params.id, req.body, req.user), { message: 'Cập nhật bàn thành công' })
  )
);

/** Bật/tắt bàn — thu ngân cũng được phép (bàn hỏng cần tắt ngay trong ca). */
router.patch('/:id/active',
  identity.requirePermission('table.operate'), idParam,
  validateBody({ is_active: { required: true, type: 'boolean' } }),
  asyncHandler(async (req, res) => {
    const t = await service.setActive(req.params.id, req.body.is_active, req.user);
    return ok(res, t, { message: req.body.is_active ? `Đã mở lại bàn ${t.code}` : `Đã tạm ngưng bàn ${t.code}` });
  })
);

/** Cấp mã QR mới cho bàn (mã cũ lập tức vô hiệu). */
router.post('/:id/rotate-qr',
  identity.requirePermission('table.write'), idParam,
  asyncHandler(async (req, res) => {
    const t = await service.rotateQr(req.params.id, req.user);
    return ok(res, service.qrDescriptorFor(t), { message: `Đã cấp mã QR mới cho bàn ${t.code}` });
  })
);

router.delete('/:id', identity.requirePermission('table.write'), idParam, asyncHandler(async (req, res) =>
  ok(res, await service.removeTable(req.params.id, req.user), { message: 'Đã xoá bàn' })
));

module.exports = router;
