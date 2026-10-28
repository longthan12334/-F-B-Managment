// =============================================================================
//  qrOrderingRoutes.js (BE-2)
//  Gộp routes cho /api/guest-orders và /api/staff-calls — cùng domain QR Ordering.
// =============================================================================

const express = require('express');
const ctrl    = require('../controllers/qrOrderingController');
const { requireAuth, requireRole } = require('../middleware/auth');

// ─── /api/guest-orders ──────────────────────────────────────────────────────
const guestOrderRouter = express.Router();
guestOrderRouter.use(requireAuth);
guestOrderRouter.get ('/pending',        ctrl.guestOrder.listPending);
guestOrderRouter.post('/:id/confirm',    requireRole('waiter', 'cashier', 'admin'), ctrl.guestOrder.confirm);
guestOrderRouter.post('/:id/reject',     requireRole('waiter', 'cashier', 'admin'), ctrl.guestOrder.reject);

// ─── /api/staff-calls ───────────────────────────────────────────────────────
const staffCallRouter = express.Router();
staffCallRouter.use(requireAuth);
staffCallRouter.get ('/pending',          ctrl.staffCall.listPending);
staffCallRouter.post('/:id/acknowledge',  requireRole('waiter', 'cashier', 'admin'), ctrl.staffCall.acknowledge);
staffCallRouter.post('/:id/done',         requireRole('waiter', 'cashier', 'admin'), ctrl.staffCall.markDone);

module.exports = { guestOrderRouter, staffCallRouter };
