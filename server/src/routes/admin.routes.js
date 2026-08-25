const express = require('express');
const controller = require('../controllers/admin.controller');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { validate } = require('../utils/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const { createEmployeeSchema, updateEmployeeSchema } = require('../validators/admin.schema');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

router.get('/employees', asyncHandler(controller.listEmployees));
router.post('/employees', validate(createEmployeeSchema), asyncHandler(controller.createEmployee));
router.patch('/employees/:id', validate(updateEmployeeSchema), asyncHandler(controller.updateEmployee));
router.get('/today', asyncHandler(controller.today));
router.get('/export.csv', asyncHandler(controller.exportCsv));

module.exports = router;
