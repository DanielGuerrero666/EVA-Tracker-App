const BREAK_DEFAULT_MS = 60 * 60 * 1000;

const timeDateEl = document.getElementById('time-date');
const timeValueEl = document.getElementById('time-value');
const clockLabelEl = document.getElementById('clock-label');
const toggleBtn = document.getElementById('toggle-btn');
const breakBtn = document.getElementById('break-btn');
const breakTimerEl = document.getElementById('break-timer');
const errorEl = document.getElementById('error');
const historyList = document.getElementById('history-list');
const logoutBtn = document.getElementById('logout-btn');

let currentStatus = { clockedIn: false, since: null };
let currentBreak = { onBreak: false, since: null, usedMs: 0 };
let tickInterval = null;

function msToClock(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function formatDuration(sinceIso) {
  return msToClock(Date.now() - new Date(sinceIso).getTime());
}

function formatWeekdayDate(date) {
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatShiftLength(clockIn, clockOut) {
  const totalMinutes = Math.max(
    0,
    Math.round((new Date(clockOut).getTime() - new Date(clockIn).getTime()) / 60000)
  );
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function renderDate() {
  timeDateEl.textContent = formatWeekdayDate(new Date());
}

function renderStatus() {
  timeValueEl.textContent = currentStatus.clockedIn ? formatDuration(currentStatus.since) : '00:00:00';

  if (currentStatus.clockedIn) {
    clockLabelEl.textContent = `Started at ${formatTime(currentStatus.since)}`;
    toggleBtn.textContent = 'Clock Out';
  } else {
    clockLabelEl.innerHTML = '&nbsp;';
    toggleBtn.textContent = 'Clock In';
  }
}

function renderBreak() {
  let usedMs = currentBreak.usedMs;
  if (currentBreak.onBreak) {
    usedMs += Date.now() - new Date(currentBreak.since).getTime();
  }
  const remainingMs = BREAK_DEFAULT_MS - usedMs;

  if (remainingMs >= 0) {
    breakTimerEl.textContent = msToClock(remainingMs);
    breakTimerEl.classList.remove('overtime');
  } else {
    breakTimerEl.textContent = `+${msToClock(-remainingMs)}`;
    breakTimerEl.classList.add('overtime');
  }

  breakBtn.textContent = currentBreak.onBreak ? 'End Break' : 'Start Break';
  breakBtn.disabled = !currentBreak.onBreak && !currentStatus.clockedIn;
}

function startTick() {
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(() => {
    renderDate();
    if (currentStatus.clockedIn) renderStatus();
    renderBreak();
  }, 1000);
}

function renderShifts(shifts) {
  historyList.innerHTML = '';

  if (!shifts.length) {
    const empty = document.createElement('li');
    empty.className = 'history-empty';
    empty.textContent = 'No completed shifts yet.';
    historyList.appendChild(empty);
    return;
  }

  for (const shift of shifts) {
    const li = document.createElement('li');
    li.className = 'shift-row';

    const top = document.createElement('div');
    top.className = 'shift-row-top';

    const date = document.createElement('span');
    date.className = 'shift-date';
    date.textContent = formatDate(shift.clockIn);

    const length = document.createElement('span');
    length.className = 'shift-length';
    length.textContent = formatShiftLength(shift.clockIn, shift.clockOut);

    top.appendChild(date);
    top.appendChild(length);

    const times = document.createElement('div');
    times.className = 'shift-times';
    times.textContent = `${formatTime(shift.clockIn)} – ${formatTime(shift.clockOut)}`;

    li.appendChild(top);
    li.appendChild(times);
    historyList.appendChild(li);
  }
}

async function refresh() {
  currentStatus = await window.eva.getStatus();
  currentBreak = await window.eva.getBreakStatus();
  renderDate();
  renderStatus();
  renderBreak();
  renderShifts(await window.eva.getShifts(20));
}

async function init() {
  const user = await window.eva.getUser();
  document.getElementById('user-name').textContent = user.name;
  document.getElementById('user-email').textContent = user.email;
  await refresh();
  startTick();
}

toggleBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  toggleBtn.disabled = true;
  try {
    if (currentStatus.clockedIn) {
      await window.eva.clockOut();
    } else {
      await window.eva.clockIn();
    }
    await refresh();
  } catch (err) {
    errorEl.textContent = err.message || 'Something went wrong.';
  } finally {
    toggleBtn.disabled = false;
  }
});

breakBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  breakBtn.disabled = true;
  try {
    if (currentBreak.onBreak) {
      await window.eva.endBreak();
    } else {
      await window.eva.startBreak();
    }
    await refresh();
  } catch (err) {
    errorEl.textContent = err.message || 'Something went wrong.';
  } finally {
    breakBtn.disabled = false;
  }
});

logoutBtn.addEventListener('click', () => {
  window.eva.logout();
});

init();
