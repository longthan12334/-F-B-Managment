// =============================================================================
//  MODULE ordering · INTERFACE — REST /api/orders
// =============================================================================
const express = require('express');
const service = require('../application/order-service');
const guestItems = require('../application/guest-items-service');
const identity = require('../../identity/contract');
const { ok, created, paged, paginateArray, asyncHandler } = require('../../../shared/http');
const { validateBody, validateParams } = require('../../../shared/validation');
const { ORDER_STATUS } = require('../domain/order');

const router = express.Router();
const idParam = validateParams({ id: { required: true, type: 'uuid' } });

router.use(identity.requireAuth);

// ─── Đọc ────────────────────────────────────────────────────────────────────
router.get('/', identity.requirePermission('order.read'), asyncHandler(async (req, res) => {
  const all = await service.listOrders({
    status: req.query.status,
    table_code: req.query.table_code,
    waiter_id: req.query.waiter_id,
    source: req.query.source,
    from: req.query.from,
    to: req.query.to,
  });
  const r = paginateArray(all, req.query);
  return paged(res, { ...r, message: `Danh sách đơn (${r.total})` });
}));

/** Hàng đợi món khách gọi qua QR đang chờ nhân viên duyệt. */
router.get('/pending-items', identity.requirePermission('order.read'), asyncHandler(async (req, res) => {
  const items = await service.listPendingItems({ table_code: req.query.table_code });
  return ok(res, items, { meta: { total: items.length } });
}));

router.get('/by-table/:tableId',
  identity.requirePermission('order.read'),
  validateParams({ tableId: { required: true, type: 'uuid' } }),
  asyncHandler(async (req, res) => ok(res, await service.getOpenOrderForTable(req.params.tableId)))
);

router.get('/:id', identity.requirePermission('order.read'), idParam,
  asyncHandler(async (req, res) => ok(res, await service.getOrder(req.params.id)))
);

// ─── Tạo & sửa đơn ──────────────────────────────────────────────────────────
router.post('/',
  identity.requirePermission('order.create'),
  validateBody({
    table_id:    { type: 'uuid' },
    table_code:  { type: 'string', maxLength: 16 },
    waiter_name: { type: 'string', maxLength: 128 },
    items:       { required: true, type: 'array' },
    notes:       { type: 'string', maxLength: 500 },
  }),
  asyncHandler(async (req, res) =>
    created(res, await service.createOrder(req.body, req.user), 'Mở đơn thành công')
  )
);

router.put('/:id/status',
  identity.requirePermission('order.modify'), idParam,
  validateBody({ status: { required: true, enum: Object.values(ORDER_STATUS) } }),
  asyncHandler(async (req, res) =>
    ok(res, await service.updateStatus(req.params.id, req.body.status, req.user),
      { message: `Đã chuyển trạng thái đơn sang "${req.body.status}"` })
  )
);

router.delete('/:id', identity.requirePermission('order.modify'), idParam, asyncHandler(async (req, res) =>
  ok(res, await service.cancelOrder(req.params.id, req.body?.reason, req.user), { message: 'Đã huỷ đơn' })
));

router.post('/:id/move',
  identity.requirePermission('order.move'), idParam,
  validateBody({ to_table_id: { required: true, type: 'uuid' } }),
  asyncHandler(async (req, res) => {
    const order = await service.moveOrder(req.params.id, req.body.to_table_id, req.user);
    return ok(res, order, { message: `Đã chuyển đơn sang bàn ${order.table_code}` });
  })
);

/**
 * Dọn bàn — huỷ đơn đang mở của bàn, KHÔNG lập hoá đơn.
 * Đặt dưới /api/orders (không phải /api/tables) vì thao tác ghi vào bảng
 * `orders` do module ordering sở hữu.
 */
router.post('/clear-table/:tableId',
  identity.requirePermission('table.operate'),
  validateParams({ tableId: { required: true, type: 'uuid' } }),
  asyncHandler(async (req, res) => {
    const r = await service.clearTable(req.params.tableId, req.body?.reason, req.user);
    return ok(res, r, { message: r.message });
  })
);

// ─── Dòng món ───────────────────────────────────────────────────────────────
router.post('/:id/items',
  identity.requirePermission('order.modify'), idParam,
  validateBody({ items: { required: true, type: 'array' } }),
  asyncHandler(async (req, res) =>
    ok(res, await service.addItems(req.params.id, req.body.items, req.user), { message: 'Đã thêm món' })
  )
);

router.put('/:id/items/:itemId',
  identity.requirePermission('order.modify'),
  validateParams({ id: { required: true, type: 'uuid' }, itemId: { required: true, type: 'uuid' } }),
  validateBody({ quantity: { type: 'integer', min: 1, max: 99 }, notes: { type: 'string', maxLength: 255 } }),
  asyncHandler(async (req, res) =>
    ok(res, await service.updateItem(req.params.id, req.params.itemId, req.body, req.user),
      { message: 'Đã cập nhật món' })
  )
);

router.delete('/:id/items/:itemId',
  identity.requirePermission('order.modify'),
  validateParams({ id: { required: true, type: 'uuid' }, itemId: { required: true, type: 'uuid' } }),
  asyncHandler(async (req, res) =>
    ok(res, await service.removeItem(req.params.id, req.params.itemId, req.user), { message: 'Đã xoá món' })
  )
);

// ─── Duyệt món khách gọi qua QR ─────────────────────────────────────────────
router.post('/:id/items/:itemId/confirm',
  identity.requirePermission('order.confirm_guest'),
  validateParams({ id: { required: true, type: 'uuid' }, itemId: { required: true, type: 'uuid' } }),
  asyncHandler(async (req, res) =>
    ok(res, await guestItems.reviewSingleItem(req.params.id, req.params.itemId,
      { approve: true, reviewer: req.user }), { message: 'Đã xác nhận món' })
  )
);

router.post('/:id/items/:itemId/reject',
  identity.requirePermission('order.confirm_guest'),
  validateParams({ id: { required: true, type: 'uuid' }, itemId: { required: true, type: 'uuid' } }),
  validateBody({ reason: { type: 'string', maxLength: 255 } }),
  asyncHandler(async (req, res) =>
    ok(res, await guestItems.reviewSingleItem(req.params.id, req.params.itemId,
      { approve: false, reason: req.body?.reason, reviewer: req.user }), { message: 'Đã từ chối món' })
  )
);

router.post('/:id/items/:itemId/served',
  identity.requirePermission('order.modify'),
  validateParams({ id: { required: true, type: 'uuid' }, itemId: { required: true, type: 'uuid' } }),
  asyncHandler(async (req, res) =>
    ok(res, await guestItems.markItemServed(req.params.id, req.params.itemId, req.user),
      { message: 'Đã đánh dấu phục vụ' })
  )
);

/** Duyệt / từ chối cả lượt khách gửi (một guest_order_request). */
router.post('/guest-requests/:requestId/review',
  identity.requirePermission('order.confirm_guest'),
  validateParams({ requestId: { required: true, type: 'uuid' } }),
  validateBody({
    approve: { required: true, type: 'boolean' },
    reason:  { type: 'string', maxLength: 255 },
  }),
  asyncHandler(async (req, res) => {
    const r = await guestItems.reviewGuestRequest(req.params.requestId, {
      approve: req.body.approve === true || req.body.approve === 'true',
      reason: req.body.reason,
      reviewer: req.user,
    });
    return ok(res, r, { message: req.body.approve ? 'Đã xác nhận yêu cầu của khách' : 'Đã từ chối yêu cầu của khách' });
  })
);

module.exports = router;
