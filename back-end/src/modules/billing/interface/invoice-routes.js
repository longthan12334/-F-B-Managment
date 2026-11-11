// =============================================================================
//  MODULE billing · INTERFACE — REST /api/invoices
// =============================================================================
const express = require('express');
const service = require('../application/checkout-service');
const identity = require('../../identity/contract');
const { ok, created, paged, paginateArray, asyncHandler } = require('../../../shared/http');
const { validateBody, validateParams } = require('../../../shared/validation');
const { PAYMENT_METHODS } = require('../domain/invoice');

const router = express.Router();
const idParam = validateParams({ id: { required: true, type: 'uuid' } });

router.use(identity.requireAuth);

const checkoutSchema = {
  order_id:       { required: true, type: 'uuid' },
  cashier_name:   { type: 'string', maxLength: 128 },
  discount:       { type: 'number', min: 0 },
  discount_note:  { type: 'string', maxLength: 255 },
  vat_rate:       { type: 'number', min: 0, max: 100 },
  payment_method: { enum: PAYMENT_METHODS },
  paid_amount:    { type: 'number', min: 0 },
};

/** Lập hoá đơn & thu tiền cho một đơn đang mở. */
router.post('/',
  identity.requirePermission('invoice.checkout'),
  validateBody(checkoutSchema),
  asyncHandler(async (req, res) =>
    created(res, await service.checkout(req.body.order_id, req.body, req.user), 'Thanh toán thành công')
  )
);

router.get('/', identity.requirePermission('invoice.read'), asyncHandler(async (req, res) => {
  const all = await service.listInvoices({
    table_code: req.query.table_code,
    cashier_name: req.query.cashier_name,
    cashier_id: req.query.cashier_id,
    payment_method: req.query.payment_method,
    from: req.query.from,
    to: req.query.to,
  });
  const r = paginateArray(all, req.query);
  return paged(res, { ...r, message: `Danh sách hoá đơn (${r.total})` });
}));

router.get('/:id', identity.requirePermission('invoice.read'), idParam, asyncHandler(async (req, res) =>
  ok(res, await service.getInvoice(req.params.id))
));

module.exports = router;
