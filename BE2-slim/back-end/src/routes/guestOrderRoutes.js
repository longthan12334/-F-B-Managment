const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/guestOrderController');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

router.get ('/pending',       ctrl.listPending);
router.post('/:id/confirm',   requireRole('waiter', 'cashier', 'admin'), ctrl.confirm);
router.post('/:id/reject',    requireRole('waiter', 'cashier', 'admin'), ctrl.reject);

module.exports = router;
