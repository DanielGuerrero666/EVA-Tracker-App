const shifts = require('../services/shifts.service');

async function getStatus(req, res) {
  res.json(await shifts.getStatus(req.user.id));
}

async function clockIn(req, res) {
  res.json(await shifts.clockIn(req.user.id));
}

async function clockOut(req, res) {
  res.json(await shifts.clockOut(req.user.id));
}

async function getShifts(req, res) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
  res.json(await shifts.getShifts(req.user.id, limit));
}

async function getBreakStatus(req, res) {
  res.json(await shifts.getBreakStatus(req.user.id));
}

async function startBreak(req, res) {
  res.json(await shifts.startBreak(req.user.id));
}

async function endBreak(req, res) {
  res.json(await shifts.endBreak(req.user.id));
}

module.exports = {
  getStatus,
  clockIn,
  clockOut,
  getShifts,
  getBreakStatus,
  startBreak,
  endBreak,
};
