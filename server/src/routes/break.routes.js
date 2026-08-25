const express = require('express');
const controller = require('../controllers/time.controller');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

router.use(requireAuth);

router.post('/start', asyncHandler(controller.startBreak));
router.post('/end', asyncHandler(controller.endBreak));
router.get('/status', asyncHandler(controller.getBreakStatus));

module.exports = router;
