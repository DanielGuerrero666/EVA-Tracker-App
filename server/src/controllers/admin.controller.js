const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { generateTempPassword } = require('../utils/tempPassword');

async function listEmployees(req, res) {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, scheduled_clock_in, scheduled_clock_out,
            break_allowance_minutes, must_change_password, created_at
     FROM users ORDER BY name ASC`
  );
  res.json(rows);
}

// The admin never picks a password — a random temporary one is generated
// here and returned once in the response for the admin to relay to the new
// employee, who must change it (must_change_password) before using the app.
async function createEmployee(req, res) {
  const { name, email, role, scheduledClockIn, scheduledClockOut, breakAllowanceMinutes } = req.body;

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const temporaryPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(temporaryPassword, 12);
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, scheduled_clock_in, scheduled_clock_out, break_allowance_minutes, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 60), true)
     RETURNING id, name, email, role, scheduled_clock_in, scheduled_clock_out, break_allowance_minutes, created_at`,
    [name, email, passwordHash, role, scheduledClockIn || null, scheduledClockOut || null, breakAllowanceMinutes]
  );

  res.status(201).json({ employee: rows[0], temporaryPassword });
}

async function updateEmployee(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid employee id' });
  }

  const { name, scheduledClockIn, scheduledClockOut, breakAllowanceMinutes } = req.body;
  const { rows } = await pool.query(
    `UPDATE users SET
       name = COALESCE($1, name),
       scheduled_clock_in = COALESCE($2, scheduled_clock_in),
       scheduled_clock_out = COALESCE($3, scheduled_clock_out),
       break_allowance_minutes = COALESCE($4, break_allowance_minutes)
     WHERE id = $5
     RETURNING id, name, email, role, scheduled_clock_in, scheduled_clock_out, break_allowance_minutes, created_at`,
    [name ?? null, scheduledClockIn ?? null, scheduledClockOut ?? null, breakAllowanceMinutes ?? null, id]
  );

  if (!rows[0]) {
    return res.status(404).json({ error: 'Employee not found' });
  }

  res.json(rows[0]);
}

// A time-of-day-only comparison: pulls just the HH:MM:SS off each shift's
// clock_in/clock_out so it can be compared against a user's scheduled TIME
// columns regardless of which calendar day the shift landed on.
function isLate(firstClockIn, scheduledClockIn) {
  if (!firstClockIn || !scheduledClockIn) return false;
  return timeOfDay(firstClockIn) > scheduledClockIn;
}

function leftLate(lastClockOut, scheduledClockOut) {
  if (!lastClockOut || !scheduledClockOut) return false;
  return timeOfDay(lastClockOut) > scheduledClockOut;
}

function timeOfDay(date) {
  return new Date(date).toTimeString().slice(0, 8);
}

async function today(req, res) {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.scheduled_clock_in, u.scheduled_clock_out,
            MIN(s.clock_in) AS first_clock_in,
            MAX(s.clock_out) AS last_clock_out,
            BOOL_OR(s.clock_out IS NULL) AS clocked_in
     FROM users u
     LEFT JOIN shifts s ON s.user_id = u.id AND s.clock_in::date = CURRENT_DATE
     GROUP BY u.id, u.name, u.email, u.scheduled_clock_in, u.scheduled_clock_out
     ORDER BY u.name ASC`
  );

  const overview = rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    clockedIn: Boolean(r.clocked_in),
    firstClockIn: r.first_clock_in,
    lastClockOut: r.last_clock_out,
    late: isLate(r.first_clock_in, r.scheduled_clock_in),
    leftLate: leftLate(r.last_clock_out, r.scheduled_clock_out),
  }));

  res.json(overview);
}

function csvEscape(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

async function exportCsv(req, res) {
  const { rows } = await pool.query(
    `SELECT u.name, u.email, s.clock_in, s.clock_out, s.break_time_seconds
     FROM shifts s
     JOIN users u ON u.id = s.user_id
     ORDER BY s.clock_in DESC`
  );

  const header = 'name,email,clock_in,clock_out,break_time_seconds';
  const lines = rows.map((r) =>
    [
      r.name,
      r.email,
      r.clock_in.toISOString(),
      r.clock_out ? r.clock_out.toISOString() : '',
      r.break_time_seconds,
    ]
      .map(csvEscape)
      .join(',')
  );

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="shifts.csv"');
  res.send([header, ...lines].join('\n'));
}

module.exports = { listEmployees, createEmployee, updateEmployee, today, exportCsv };
