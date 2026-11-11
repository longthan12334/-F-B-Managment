// =============================================================================
//  MODULE identity · INTERFACE — REST /api/auth
// =============================================================================
const express = require('express');
const authService = require('../application/auth-service');
const { requireAuth } = require('./auth-middleware');
const { ok, asyncHandler } = require('../../../shared/http');
const { validateBody } = require('../../../shared/validation');
const { authLimiter } = require('../../../platform/http/rate-limit');

const router = express.Router();

const requestMeta = (req) => ({
  ip: req.clientIp || req.ip,
  userAgent: req.headers['user-agent'],
  requestId: req.id,
});

router.post(
  '/login',
  authLimiter,
  validateBody({
    username: { required: true, type: 'string', minLength: 1, maxLength: 64 },
    password: { required: true, type: 'string', minLength: 1, maxLength: 128 },
  }),
  asyncHandler(async (req, res) => {
    const data = await authService.login(req.body, requestMeta(req));
    return ok(res, data, { message: 'Đăng nhập thành công' });
  })
);

router.post(
  '/refresh',
  authLimiter,
  validateBody({ refresh_token: { required: true, type: 'string', minLength: 1 } }),
  asyncHandler(async (req, res) => {
    const data = await authService.refresh(req.body, requestMeta(req));
    return ok(res, data, { message: 'Đã làm mới phiên đăng nhập' });
  })
);

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    const r = await authService.logout(req.body || {}, req.user);
    return ok(res, null, { message: r.all ? 'Đã đăng xuất mọi thiết bị' : 'Đã đăng xuất' });
  })
);

router.get('/me', requireAuth, asyncHandler(async (req, res) =>
  ok(res, await authService.me(req.user.id))
));

router.get('/sessions', requireAuth, asyncHandler(async (req, res) =>
  ok(res, await authService.listMySessions(req.user.id))
));

router.put(
  '/password',
  requireAuth,
  validateBody({
    current_password: { required: true, type: 'string', minLength: 1 },
    new_password:     { required: true, type: 'string', minLength: 1 },
  }),
  asyncHandler(async (req, res) => {
    await authService.changeOwnPassword(req.user.id, req.body);
    return ok(res, null, { message: 'Đã đổi mật khẩu. Vui lòng đăng nhập lại trên các thiết bị khác.' });
  })
);

module.exports = router;
