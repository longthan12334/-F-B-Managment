// =============================================================================
//  MODULE guest-access · INTERFACE — REST /api/guest-requests (cho nhân viên)
// -----------------------------------------------------------------------------
//  Màn hình "Yêu cầu khách gọi" của thu ngân/phục vụ: xem hàng đợi, xem lịch
//  sử theo bàn, xem phiên đang mở. Thao tác DUYỆT/TỪ CHỐI nằm ở module
//  ordering (vì nó ghi vào order_items) — xem POST /api/orders/guest-requests/
//  :requestId/review.
// =============================================================================
const express = require('express');
const orderService = require('../application/guest-order-service');
const sessionService = require('../application/guest-session-service');
const identity = require('../../identity/contract');
const { ok, asyncHandler } = require('../../../shared/http');
const { validateParams } = require('../../../shared/validation');

const router = express.Router();

router.use(identity.requireAuth, identity.requirePermission('guest_session.read'));

/** Hàng đợi yêu cầu đang chờ duyệt của toàn nhà hàng. */
router.get('/pending', asyncHandler(async (req, res) => {
  const items = await orderService.listPendingRequests({ table_code: req.query.table_code });
  return ok(res, items, { meta: { total: items.length } });
}));

/** Lịch sử yêu cầu của một bàn. */
router.get('/by-table/:tableId',
  validateParams({ tableId: { required: true, type: 'uuid' } }),
  asyncHandler(async (req, res) => ok(res, await orderService.listRequestsForTable(req.params.tableId)))
);

/** Phiên khách của một bàn (để nhân viên biết có mấy máy đang gọi món). */
router.get('/sessions/by-table/:tableId',
  validateParams({ tableId: { required: true, type: 'uuid' } }),
  asyncHandler(async (req, res) => ok(res, await sessionService.listSessionsForTable(req.params.tableId)))
);

module.exports = router;
