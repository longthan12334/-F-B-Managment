// =============================================================================
//  MODULE catalog · INTERFACE — REST /api/menu
// =============================================================================
const express = require('express');
const multer = require('multer');
const service = require('../application/menu-service');
const identity = require('../../identity/contract');   // ← dùng CONTRACT của module khác
const { ok, created, paged, paginateArray, asyncHandler } = require('../../../shared/http');
const { validateParams } = require('../../../shared/validation');
const { config } = require('../../../shared/config');
const { ALLOWED_IMAGE_TYPES } = require('../domain/menu-item');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.storage.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) =>
    ALLOWED_IMAGE_TYPES.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error(`Chỉ chấp nhận ảnh ${ALLOWED_IMAGE_TYPES.join(', ')}`)),
});

const idParam = validateParams({ id: { required: true, type: 'uuid' } });

// ─── Đọc: mọi nhân viên đã đăng nhập ─────────────────────────────────────────
router.get('/categories', identity.requireAuth, asyncHandler(async (_req, res) =>
  ok(res, await service.listCategories())
));

router.get('/', identity.requireAuth, asyncHandler(async (req, res) => {
  const { active, category, search, page, limit } = req.query;
  const filters = { search };
  if (active === 'true') filters.is_active = true;
  if (active === 'false') filters.is_active = false;
  if (category && category !== 'all') filters.category_code = category;

  const all = await service.listItems(filters);
  const r = paginateArray(all, { page, limit });
  return paged(res, { ...r, message: `Thực đơn (${r.total} món)` });
}));

router.get('/:id', identity.requireAuth, idParam, asyncHandler(async (req, res) =>
  ok(res, await service.getItem(req.params.id))
));

// ─── Ghi: chỉ quản trị viên ─────────────────────────────────────────────────
router.post('/',
  identity.requireAuth, identity.requirePermission('menu.write'),
  upload.single('image'),
  asyncHandler(async (req, res) =>
    created(res, await service.createItem(req.body, req.file, req.user), 'Thêm món thành công')
  )
);

router.put('/:id',
  identity.requireAuth, identity.requirePermission('menu.write'),
  idParam, upload.single('image'),
  asyncHandler(async (req, res) =>
    ok(res, await service.updateItem(req.params.id, req.body, req.file, req.user),
      { message: 'Cập nhật món thành công' })
  )
);

router.delete('/:id',
  identity.requireAuth, identity.requirePermission('menu.write'), idParam,
  asyncHandler(async (req, res) =>
    ok(res, await service.removeItem(req.params.id, req.user), { message: 'Đã xoá món' })
  )
);

module.exports = router;
