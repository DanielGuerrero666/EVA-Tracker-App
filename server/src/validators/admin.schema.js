const { z } = require('zod');

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Expected HH:MM or HH:MM:SS');

const createEmployeeSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.enum(['employee', 'admin']).optional().default('employee'),
  scheduledClockIn: timeOfDay.optional(),
  scheduledClockOut: timeOfDay.optional(),
  breakAllowanceMinutes: z.number().int().positive().optional(),
});

const updateEmployeeSchema = z.object({
  name: z.string().min(1).optional(),
  scheduledClockIn: timeOfDay.optional(),
  scheduledClockOut: timeOfDay.optional(),
  breakAllowanceMinutes: z.number().int().positive().optional(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const exportShiftsQuerySchema = z
  .object({
    range: z.enum(['today', 'yesterday', '7d', '30d', 'custom']).optional().default('today'),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .refine((data) => data.range !== 'custom' || (data.from && data.to), {
    message: 'Custom range requires both from and to (YYYY-MM-DD)',
  });

module.exports = { createEmployeeSchema, updateEmployeeSchema, exportShiftsQuerySchema };
