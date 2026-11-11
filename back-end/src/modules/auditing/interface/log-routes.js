// =============================================================================
//  MODULE auditing · INTERFACE — REST /api/logs (chỉ quản trị viên)
// =============================================================================
const express = require('express');
const service = require('../application/audit-service');
const identity = require('../../identity/contract');
const { ok, paged, paginateArray, asyncHandler } = require('../../../shared/http');

const router = express.Router();

router.use(identity.requireAuth, identity.requirePermission('log.read'));

router.get('/', asyncHandler(async (req, res) => {
  const rows = await service.list({
    from: req.query.from, to: req.query.to,
    action: req.query.action, module: req.query.module,
    entity: req.query.entity, user_name: req.query.user_name,
    limit: 1000,
  });
  const r = paginateArray(rows, { page: req.query.page, limit: req.query.limit, max: 500 });
  return paged(res, { ...r, message: `Nhật ký hoạt động (${r.total})` });
}));

/** Dòng thời gian đầy đủ của một thực thể — hữu ích khi điều tra khiếu nại. */
router.get('/timeline/:entity/:entityId', asyncHandler(async (req, res) =>
  ok(res, await service.timelineFor(req.params.entity.toUpperCase(), req.params.entityId))
));

module.exports = router;
