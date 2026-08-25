const express = require('express');
const controller = require('../controllers/auth.controller');
const { validate } = require('../utils/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { loginSchema, refreshSchema, changePasswordSchema } = require('../validators/auth.schema');
const { loginLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/login', loginLimiter, validate(loginSchema), asyncHandler(controller.login));
router.post('/refresh', validate(refreshSchema), asyncHandler(controller.refresh));
router.post('/logout', validate(refreshSchema), asyncHandler(controller.logout));
router.post(
  '/change-password',
  requireAuth,
  validate(changePasswordSchema),
  asyncHandler(controller.changePassword)
);

module.exports = router;
