const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

// Local JSON-backed store for v1. The method signatures here (getUser,
// setUser, clockIn, clockOut, getStatus, getShifts) are the seam we'll
// swap to an HTTP client against the future Postgres-backed server —
// main.js and the renderer should never need to change when that happens.
class DataStore {
  constructor(filePath) {
    this.filePath = filePath || path.join(app.getPath('userData'), 'eva-tracker-data.json');
    this.data = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return { currentUser: null, entries: [] };
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  getUser() {
    return this.data.currentUser;
  }

  setUser({ name, email }) {
    this.data.currentUser = { name, email };
    this._save();
    return this.data.currentUser;
  }

  clearUser() {
    this.data.currentUser = null;
    this._save();
  }

  _entriesForCurrentUser(types) {
    const email = this.data.currentUser && this.data.currentUser.email;
    return this.data.entries.filter(
      (e) => e.userEmail === email && (!types || types.includes(e.type))
    );
  }

  getStatus() {
    const entries = this._entriesForCurrentUser(['in', 'out']);
    const last = entries[entries.length - 1];
    if (!last || last.type === 'out') {
      return { clockedIn: false, since: null };
    }
    return { clockedIn: true, since: last.timestamp };
  }

  // Break time accumulates against the current shift's allowance and only
  // resets on the next clock-in — ending a break freezes the used amount
  // rather than clearing it, so a second break in the same shift continues
  // eating into the same allowance instead of getting a fresh hour.
  getBreakStatus() {
    const entries = this._entriesForCurrentUser(['in', 'out', 'break_start', 'break_end']);
    let onBreak = false;
    let since = null;
    let usedMs = 0;
    let pendingBreakStart = null;

    for (const entry of entries) {
      if (entry.type === 'in' || entry.type === 'out') {
        onBreak = false;
        since = null;
        usedMs = 0;
        pendingBreakStart = null;
      } else if (entry.type === 'break_start') {
        onBreak = true;
        since = entry.timestamp;
        pendingBreakStart = entry.timestamp;
      } else if (entry.type === 'break_end') {
        if (pendingBreakStart) {
          usedMs += new Date(entry.timestamp).getTime() - new Date(pendingBreakStart).getTime();
        }
        onBreak = false;
        since = null;
        pendingBreakStart = null;
      }
    }

    return { onBreak, since, usedMs };
  }

  _addEntry(type) {
    const user = this.data.currentUser;
    if (!user) throw new Error('No user logged in');
    const entry = {
      id: crypto.randomUUID(),
      userEmail: user.email,
      userName: user.name,
      type,
      timestamp: new Date().toISOString(),
    };
    this.data.entries.push(entry);
    this._save();
    return entry;
  }

  clockIn() {
    if (this.getStatus().clockedIn) throw new Error('Already clocked in');
    this._addEntry('in');
    return this.getStatus();
  }

  clockOut() {
    if (!this.getStatus().clockedIn) throw new Error('Already clocked out');
    if (this.getBreakStatus().onBreak) this._addEntry('break_end');
    this._addEntry('out');
    return this.getStatus();
  }

  startBreak() {
    if (!this.getStatus().clockedIn) throw new Error('Clock in before starting a break');
    if (this.getBreakStatus().onBreak) throw new Error('Already on break');
    this._addEntry('break_start');
    return this.getBreakStatus();
  }

  endBreak() {
    if (!this.getBreakStatus().onBreak) throw new Error('Not currently on break');
    this._addEntry('break_end');
    return this.getBreakStatus();
  }

  getShifts(limit = 20) {
    const entries = this._entriesForCurrentUser(['in', 'out']);
    const shifts = [];
    let pendingIn = null;

    for (const entry of entries) {
      if (entry.type === 'in') {
        pendingIn = entry;
      } else if (entry.type === 'out' && pendingIn) {
        shifts.push({ clockIn: pendingIn.timestamp, clockOut: entry.timestamp });
        pendingIn = null;
      }
    }

    return shifts.reverse().slice(0, limit);
  }
}

module.exports = DataStore;
