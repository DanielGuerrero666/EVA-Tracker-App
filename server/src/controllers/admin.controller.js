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
// clock_in/clock_out (in Colombia local time — scheduled_clock_in/out are
// entered by the admin as Colombia wall-clock time) so it can be compared
// against a user's scheduled TIME columns regardless of which calendar day
// the shift landed on. Using the server's own local time here would be wrong
// whenever the VPS isn't itself set to America/Bogota.
const bogotaTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Bogota',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function bogotaTimeOfDay(date) {
  return bogotaTimeFormatter.format(new Date(date));
}

function isLate(firstClockIn, scheduledClockIn) {
  if (!firstClockIn || !scheduledClockIn) return false;
  return bogotaTimeOfDay(firstClockIn) > scheduledClockIn;
}

function leftLate(lastClockOut, scheduledClockOut) {
  if (!lastClockOut || !scheduledClockOut) return false;
  return bogotaTimeOfDay(lastClockOut) > scheduledClockOut;
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

const bogotaFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Bogota',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

// sv-SE gives "YYYY-MM-DD HH:mm:ss" directly (no AM/PM, no reordering needed),
// so all we do is swap its locale comma for a space.
function formatBogota(date) {
  return bogotaFormatter.format(date).replace(',', '');
}

// Bogotá stays at UTC-5 year-round (no DST), so its calendar date can be read
// straight off an Intl formatter and its midnight is always 05:00 UTC that
// same date — no timezone library needed for the range math below.
function bogotaDateString(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(date);
}

function bogotaMidnightUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 5, 0, 0, 0));
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Resolves the ?range=... query into a [from, to) UTC instant window plus a
// human label for the CSV summary and, when the range isn't the default
// "today", a filename fragment (the default filename uses the export
// timestamp instead — see buildExportFilename).
function computeExportRange(query) {
  const todayStr = bogotaDateString(new Date());

  switch (query.range) {
    case 'yesterday': {
      const day = addDays(todayStr, -1);
      return { from: bogotaMidnightUtc(day), to: bogotaMidnightUtc(todayStr), label: `Ayer (${day})`, filenamePart: day };
    }
    case '7d': {
      const start = addDays(todayStr, -6);
      return {
        from: bogotaMidnightUtc(start),
        to: bogotaMidnightUtc(addDays(todayStr, 1)),
        label: `Últimos 7 días (${start} a ${todayStr})`,
        filenamePart: `${start} a ${todayStr}`,
      };
    }
    case '30d': {
      const start = addDays(todayStr, -29);
      return {
        from: bogotaMidnightUtc(start),
        to: bogotaMidnightUtc(addDays(todayStr, 1)),
        label: `Último mes (${start} a ${todayStr})`,
        filenamePart: `${start} a ${todayStr}`,
      };
    }
    case 'custom': {
      return {
        from: bogotaMidnightUtc(query.from),
        to: bogotaMidnightUtc(addDays(query.to, 1)),
        label: `${query.from} a ${query.to}`,
        filenamePart: `${query.from} a ${query.to}`,
      };
    }
    case 'today':
    default: {
      return {
        from: bogotaMidnightUtc(todayStr),
        to: bogotaMidnightUtc(addDays(todayStr, 1)),
        label: `Hoy (${todayStr})`,
        filenamePart: null,
      };
    }
  }
}

function buildExportFilename(range) {
  if (range.filenamePart) {
    return `shifts ${range.filenamePart}.csv`;
  }
  return `shifts ${formatBogota(new Date()).replace(/:/g, '-')}.csv`;
}

function formatHoursMinutes(totalMinutes) {
  const sign = totalMinutes < 0 ? '-' : '';
  const abs = Math.round(Math.abs(totalMinutes));
  return `${sign}${Math.floor(abs / 60)}h ${abs % 60}m`;
}

// H:MM:SS for shift-length durations (work/break time) — can span hours.
function formatDurationHMS(totalSeconds) {
  const sign = totalSeconds < 0 ? '-' : '';
  const abs = Math.round(Math.abs(totalSeconds));
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  return `${sign}${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// MM:SS for lateness/early-departure — always small (minutes, not hours),
// and "00:00" doubles as the not-late/not-early value so the column reads
// as a plain duration rather than needing a separate yes/no column.
function formatDurationMMSS(totalSeconds) {
  const abs = Math.round(Math.max(0, totalSeconds));
  return `${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function timeStringToSeconds(hhmmss) {
  const [h, m, s = 0] = hhmmss.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

// Per-shift lateness, in the same Colombia wall-clock terms as isLate/leftLate
// above, but down to the second and reporting *how much* — which the admin
// table doesn't need but the export does. "Left early" here means clocked
// out before the scheduled time (the opposite of leftLate's "stayed late").
function computeLateness(shift) {
  const result = { late: false, lateSeconds: 0, leftEarly: false, earlySeconds: 0 };

  if (shift.scheduled_clock_in) {
    const diff = timeStringToSeconds(bogotaTimeOfDay(shift.clock_in)) - timeStringToSeconds(shift.scheduled_clock_in);
    if (diff > 0) {
      result.late = true;
      result.lateSeconds = diff;
    }
  }

  if (shift.clock_out && shift.scheduled_clock_out) {
    const diff = timeStringToSeconds(shift.scheduled_clock_out) - timeStringToSeconds(bogotaTimeOfDay(shift.clock_out));
    if (diff > 0) {
      result.leftEarly = true;
      result.earlySeconds = diff;
    }
  }

  return result;
}

function buildSummary(shifts, range) {
  const completed = shifts.filter((r) => r.clock_out);
  const totalWorkedMinutes = completed.reduce((sum, r) => {
    const grossMinutes = (new Date(r.clock_out) - new Date(r.clock_in)) / 60000;
    return sum + Math.max(0, grossMinutes - r.break_time_seconds / 60);
  }, 0);
  const totalBreakMinutes = shifts.reduce((sum, r) => sum + r.break_time_seconds / 60, 0);
  const uniqueEmployees = new Set(shifts.map((r) => r.email)).size;
  const avgMinutesPerEmployee = uniqueEmployees ? totalWorkedMinutes / uniqueEmployees : 0;

  return [
    'Resumen del periodo',
    `Rango,${range.label}`,
    `Total de turnos,${shifts.length}`,
    `Turnos completados,${completed.length}`,
    `Empleados unicos,${uniqueEmployees}`,
    `Horas totales trabajadas,${formatHoursMinutes(totalWorkedMinutes)}`,
    `Horas totales de descanso,${formatHoursMinutes(totalBreakMinutes)}`,
    `Promedio de horas trabajadas por empleado,${formatHoursMinutes(avgMinutesPerEmployee)}`,
    `Llegadas tarde,${shifts.filter((r) => r.late).length}`,
    `Salidas tempranas,${shifts.filter((r) => r.leftEarly).length}`,
    '',
  ];
}

async function exportCsv(req, res) {
  const range = computeExportRange(req.query);

  const { rows } = await pool.query(
    `SELECT u.name, u.email, u.scheduled_clock_in, u.scheduled_clock_out,
            s.clock_in, s.clock_out, s.break_time_seconds
     FROM shifts s
     JOIN users u ON u.id = s.user_id
     WHERE s.clock_in >= $1 AND s.clock_in < $2
     ORDER BY s.clock_in DESC`,
    [range.from, range.to]
  );

  const shifts = rows.map((r) => ({ ...r, ...computeLateness(r) }));

  const header = [
    'name',
    'clock_in (Colombia, UTC-5)',
    'clock_out (Colombia, UTC-5)',
    'work_time (H:MM:SS)',
    'break_time (H:MM:SS)',
    'late_by (MM:SS)',
    'left_early_by (MM:SS)',
  ].join(',');

  const lines = shifts.map((r) => {
    const workTime = r.clock_out
      ? formatDurationHMS((new Date(r.clock_out) - new Date(r.clock_in)) / 1000 - r.break_time_seconds)
      : '';
    return [
      r.name,
      formatBogota(r.clock_in),
      r.clock_out ? formatBogota(r.clock_out) : '',
      workTime,
      formatDurationHMS(r.break_time_seconds),
      formatDurationMMSS(r.lateSeconds),
      formatDurationMMSS(r.earlySeconds),
    ]
      .map(csvEscape)
      .join(',');
  });

  const filename = buildExportFilename(range);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send([...buildSummary(shifts, range), header, ...lines].join('\n'));
}

module.exports = { listEmployees, createEmployee, updateEmployee, today, exportCsv };
