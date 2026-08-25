const express = require('express');
const controller = require('../controllers/time.controller');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

router.use(requireAuth);

router.get('/status', asyncHandler(controller.getStatus));
router.post('/clock-in', asyncHandler(controller.clockIn));
router.post('/clock-out', asyncHandler(controller.clockOut));
router.get('/shifts', asyncHandler(controller.getShifts));

module.exports = router;
