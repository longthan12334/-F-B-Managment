// =============================================================================
//  MODULE identity · INTERFACE — REST /api/users (chỉ quản trị viên)
// =============================================================================
const express = require('express');
const userService = require('../application/user-service');
const { requireAuth, requirePermission } = require('./auth-middleware');
const { ok, created, paged, paginateArray, asyncHandler } = require('../../../shared/http');
const { validateBody, validateParams } = require('../../../shared/validation');
const { ALL_ROLES } = require('../domain/roles');

const router = express.Router();

router.use(requireAuth);

const idParam = validateParams({ id: { required: true, type: 'uuid' } });

router.get('/', requirePermission('user.read'), asyncHandler(async (req, res) => {
  const all = await userService.list({ role: req.query.role });
  const r = paginateArray(all, req.query);
  return paged(res, { ...r, message: `Danh sách nhân viên (${r.total})` });
}));

router.post(
  '/',
  requirePermission('user.write'),
  validateBody({
    username:  { required: true, type: 'string', minLength: 3, maxLength: 32 },
    password:  { required: true, type: 'string', minLength: 1 },
    full_name: { required: true, type: 'string', minLength: 2, maxLength: 128 },
    role:      { required: true, enum: ALL_ROLES },
    email:     { type: 'string', maxLength: 128 },
    phone:     { type: 'string', maxLength: 32 },
  }),
  asyncHandler(async (req, res) =>
    created(res, await userService.create(req.body, req.user), 'Tạo nhân viên thành công')
  )
);

router.put(
  '/:id',
  requirePermission('user.write'),
  idParam,
  validateBody({
    full_name: { type: 'string', minLength: 2, maxLength: 128 },
    role:      { enum: ALL_ROLES },
    email:     { type: 'string', maxLength: 128 },
    phone:     { type: 'string', maxLength: 32 },
    is_active: { type: 'boolean' },
  }),
  asyncHandler(async (req, res) =>
    ok(res, await userService.update(req.params.id, req.body, req.user), { message: 'Cập nhật thành công' })
  )
);

router.put(
  '/:id/password',
  requirePermission('user.write'),
  idParam,
  validateBody({ password: { required: true, type: 'string', minLength: 1 } }),
  asyncHandler(async (req, res) =>
    ok(res, await userService.resetPassword(req.params.id, req.body.password, req.user),
      { message: 'Đã đặt lại mật khẩu' })
  )
);

router.delete('/:id', requirePermission('user.write'), idParam, asyncHandler(async (req, res) =>
  ok(res, await userService.remove(req.params.id, req.user), { message: 'Đã xoá nhân viên' })
));

module.exports = router;
