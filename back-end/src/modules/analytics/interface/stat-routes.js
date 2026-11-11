// =============================================================================
//  MODULE analytics · INTERFACE — REST /api/stats
// =============================================================================
const express = require('express');
const service = require('../application/analytics-service');
const identity = require('../../identity/contract');
const { ok, asyncHandler } = require('../../../shared/http');
const { validateQuery } = require('../../../shared/validation');

const router = express.Router();

router.use(identity.requireAuth, identity.requirePermission('stats.read'));

router.get('/overview',
  validateQuery({ from: { type: 'iso-date' }, to: { type: 'iso-date' } }),
  asyncHandler(async (req, res) => {
    const data = await service.overview(req.query);
    return ok(res, data, { meta: data.meta });
  })
);

router.get('/daily',
  validateQuery({ days: { type: 'integer', min: 1, max: 90 } }),
  asyncHandler(async (req, res) => ok(res, await service.daily(req.query)))
);

/** Dựng lại hình chiếu báo cáo (chỉ quản trị viên). */
router.post('/rebuild',
  identity.requireRole('admin'),
  asyncHandler(async (req, res) =>
    ok(res, await service.rebuild({ since: req.body?.since }), { message: 'Đã dựng lại dữ liệu báo cáo' })
  )
);

module.exports = router;
