const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/staffCallController');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

router.get ('/pending',          ctrl.listPending);
router.post('/:id/acknowledge',  requireRole('waiter', 'cashier', 'admin'), ctrl.acknowledge);
router.post('/:id/done',         requireRole('waiter', 'cashier', 'admin'), ctrl.markDone);

module.exports = router;
