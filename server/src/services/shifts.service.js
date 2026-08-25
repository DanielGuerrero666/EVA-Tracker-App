const pool = require('../db/pool');

function conflict(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

async function findOpenShift(userId) {
  const { rows } = await pool.query(
    'SELECT id, clock_in, break_time_seconds, break_started_at FROM shifts WHERE user_id = $1 AND clock_out IS NULL',
    [userId]
  );
  return rows[0] || null;
}

async function getStatus(userId) {
  const open = await findOpenShift(userId);
  return open ? { clockedIn: true, since: open.clock_in } : { clockedIn: false, since: null };
}

async function getBreakStatus(userId) {
  const open = await findOpenShift(userId);
  if (!open) return { onBreak: false, since: null, usedMs: 0 };
  return {
    onBreak: Boolean(open.break_started_at),
    since: open.break_started_at,
    usedMs: open.break_time_seconds * 1000,
  };
}

async function clockIn(userId) {
  if (await findOpenShift(userId)) throw conflict('Already clocked in');
  try {
    await pool.query('INSERT INTO shifts (user_id) VALUES ($1)', [userId]);
  } catch (err) {
    // Race with another clock-in for the same user — the unique partial
    // index (one open shift per user) caught it instead of our own check.
    if (err.code === '23505') throw conflict('Already clocked in');
    throw err;
  }
  return getStatus(userId);
}

async function clockOut(userId) {
  const open = await findOpenShift(userId);
  if (!open) throw conflict('Already clocked out');

  if (open.break_started_at) {
    await pool.query(
      `UPDATE shifts
       SET break_time_seconds = break_time_seconds + EXTRACT(EPOCH FROM (now() - break_started_at))::INTEGER,
           break_started_at = NULL
       WHERE id = $1`,
      [open.id]
    );
  }

  await pool.query('UPDATE shifts SET clock_out = now() WHERE id = $1', [open.id]);
  return getStatus(userId);
}

async function startBreak(userId) {
  const open = await findOpenShift(userId);
  if (!open) throw conflict('Clock in before starting a break');
  if (open.break_started_at) throw conflict('Already on break');

  await pool.query('UPDATE shifts SET break_started_at = now() WHERE id = $1', [open.id]);
  return getBreakStatus(userId);
}

async function endBreak(userId) {
  const open = await findOpenShift(userId);
  if (!open || !open.break_started_at) throw conflict('Not currently on break');

  await pool.query(
    `UPDATE shifts
     SET break_time_seconds = break_time_seconds + EXTRACT(EPOCH FROM (now() - break_started_at))::INTEGER,
         break_started_at = NULL
     WHERE id = $1`,
    [open.id]
  );
  return getBreakStatus(userId);
}

async function getShifts(userId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT clock_in, clock_out FROM shifts
     WHERE user_id = $1 AND clock_out IS NOT NULL
     ORDER BY clock_in DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows.map((r) => ({ clockIn: r.clock_in, clockOut: r.clock_out }));
}

module.exports = {
  getStatus,
  getBreakStatus,
  clockIn,
  clockOut,
  startBreak,
  endBreak,
  getShifts,
};
