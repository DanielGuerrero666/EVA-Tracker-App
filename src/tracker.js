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

const cardEl = document.querySelector('.card');
const adminToggleBtn = document.getElementById('admin-toggle-btn');
const trackerView = document.getElementById('tracker-view');
const adminView = document.getElementById('admin-view');
const adminErrorEl = document.getElementById('admin-error');
const adminTableBody = document.getElementById('admin-table-body');
const adminExportBtn = document.getElementById('admin-export-btn');
const exportRangeSelect = document.getElementById('export-range-select');
const exportCustomRangeEl = document.getElementById('export-custom-range');
const exportFromInput = document.getElementById('export-from');
const exportToInput = document.getElementById('export-to');
const addEmployeeForm = document.getElementById('add-employee-form');
const addEmployeeErrorEl = document.getElementById('add-employee-error');
const addEmployeeSuccessEl = document.getElementById('add-employee-success');

const editEmployeeTitleEl = document.getElementById('edit-employee-title');
const editEmployeeForm = document.getElementById('edit-employee-form');
const editEmployeeErrorEl = document.getElementById('edit-employee-error');
const editEmployeeCancelBtn = document.getElementById('edit-employee-cancel-btn');

let adminEmployeesById = new Map();

const changePasswordToggleBtn = document.getElementById('change-password-toggle-btn');
const changePasswordView = document.getElementById('change-password-view');
const changePasswordTitleEl = document.getElementById('change-password-title');
const changePasswordForm = document.getElementById('change-password-form');
const changePasswordErrorEl = document.getElementById('change-password-error');

let forcingPasswordChange = false;

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

function renderAdminTable(overview) {
  adminTableBody.innerHTML = '';

  for (const employee of overview) {
    const row = document.createElement('tr');

    const name = document.createElement('td');
    name.textContent = employee.name;

    const status = document.createElement('td');
    status.textContent = employee.clockedIn ? 'Clocked in' : 'Clocked out';
    if (employee.clockedIn) status.classList.add('status-in');

    const late = document.createElement('td');
    late.textContent = employee.late ? 'Yes' : '–';
    if (employee.late) late.classList.add('flag-yes');

    const leftLate = document.createElement('td');
    leftLate.textContent = employee.leftLate ? 'Yes' : '–';
    if (employee.leftLate) leftLate.classList.add('flag-yes');

    const editCell = document.createElement('td');
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'link admin-edit-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openEditEmployee(employee.id));
    editCell.appendChild(editBtn);

    row.appendChild(name);
    row.appendChild(status);
    row.appendChild(late);
    row.appendChild(leftLate);
    row.appendChild(editCell);
    adminTableBody.appendChild(row);
  }
}

function openEditEmployee(id) {
  const employee = adminEmployeesById.get(id);
  if (!employee) return;

  editEmployeeErrorEl.textContent = '';
  document.getElementById('edit-employee-id').value = employee.id;
  document.getElementById('edit-employee-name').value = employee.name;
  document.getElementById('edit-employee-clock-in').value = (employee.scheduled_clock_in || '').slice(0, 5);
  document.getElementById('edit-employee-clock-out').value = (employee.scheduled_clock_out || '').slice(0, 5);
  document.getElementById('edit-employee-break').value = employee.break_allowance_minutes ?? 60;

  editEmployeeTitleEl.hidden = false;
  editEmployeeForm.hidden = false;
}

function closeEditEmployee() {
  editEmployeeTitleEl.hidden = true;
  editEmployeeForm.hidden = true;
  editEmployeeForm.reset();
}

async function loadAdminPanel() {
  adminErrorEl.textContent = '';
  closeEditEmployee();
  try {
    const [overview, employees] = await Promise.all([
      window.eva.admin.today(),
      window.eva.admin.listEmployees(),
    ]);
    adminEmployeesById = new Map(employees.map((e) => [e.id, e]));
    renderAdminTable(overview);
  } catch (err) {
    adminErrorEl.textContent = err.message || 'Could not load admin data.';
  }
}

function showView(view) {
  trackerView.hidden = view !== 'tracker';
  adminView.hidden = view !== 'admin';
  changePasswordView.hidden = view !== 'password';
  adminToggleBtn.textContent = view === 'admin' ? 'Back to tracker' : 'Admin panel';
  changePasswordToggleBtn.textContent = view === 'password' ? 'Back to tracker' : 'Change password';
  cardEl.classList.toggle('card-wide', view === 'admin');
  window.eva.setAdminView(view === 'admin');
  if (view === 'admin') loadAdminPanel();
}

async function refresh() {
  currentStatus = await window.eva.getStatus();
  currentBreak = await window.eva.getBreakStatus();
  renderDate();
  renderStatus();
  renderBreak();
  renderShifts(await window.eva.getShifts(20));
}

async function finishLogin(user) {
  if (user.role === 'admin') adminToggleBtn.hidden = false;
  changePasswordToggleBtn.hidden = false;
  showView('tracker');
  await refresh();
  startTick();
}

async function init() {
  const user = await window.eva.getUser();
  document.getElementById('user-name').textContent = user.name;
  document.getElementById('user-email').textContent = user.email;

  if (user.mustChangePassword) {
    forcingPasswordChange = true;
    changePasswordTitleEl.textContent = 'You must set a new password before continuing';
    showView('password');
    return;
  }

  await finishLogin(user);
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

adminToggleBtn.addEventListener('click', () => {
  showView(adminView.hidden ? 'admin' : 'tracker');
});

changePasswordToggleBtn.addEventListener('click', () => {
  showView(changePasswordView.hidden ? 'password' : 'tracker');
});

exportRangeSelect.addEventListener('change', () => {
  exportCustomRangeEl.hidden = exportRangeSelect.value !== 'custom';
});

adminExportBtn.addEventListener('click', async () => {
  adminErrorEl.textContent = '';

  const range = exportRangeSelect.value;
  const params = { range };
  if (range === 'custom') {
    if (!exportFromInput.value || !exportToInput.value) {
      adminErrorEl.textContent = 'Pick both a "From" and "To" date for a custom range.';
      return;
    }
    params.from = exportFromInput.value;
    params.to = exportToInput.value;
  }

  adminExportBtn.disabled = true;
  try {
    const result = await window.eva.admin.exportCsv(params);
    if (result.saved) adminErrorEl.textContent = `Saved to ${result.path}`;
  } catch (err) {
    adminErrorEl.textContent = err.message || 'Could not export CSV.';
  } finally {
    adminExportBtn.disabled = false;
  }
});

addEmployeeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  addEmployeeErrorEl.textContent = '';
  addEmployeeSuccessEl.textContent = '';

  const name = document.getElementById('employee-name').value.trim();
  const email = document.getElementById('employee-email').value.trim();
  const scheduledClockIn = document.getElementById('employee-clock-in').value || undefined;
  const scheduledClockOut = document.getElementById('employee-clock-out').value || undefined;
  const breakMinutes = document.getElementById('employee-break').value;
  const breakAllowanceMinutes = breakMinutes ? Number(breakMinutes) : undefined;

  try {
    const { temporaryPassword } = await window.eva.admin.createEmployee({
      name,
      email,
      scheduledClockIn,
      scheduledClockOut,
      breakAllowanceMinutes,
    });
    addEmployeeSuccessEl.textContent =
      `Created. Temporary password: ${temporaryPassword} — share it with ${name}, it won't be shown again.`;
    addEmployeeForm.reset();
    await loadAdminPanel();
  } catch (err) {
    addEmployeeErrorEl.textContent = err.message || 'Could not create employee.';
  }
});

editEmployeeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  editEmployeeErrorEl.textContent = '';

  const id = Number(document.getElementById('edit-employee-id').value);
  const name = document.getElementById('edit-employee-name').value.trim();
  const scheduledClockIn = document.getElementById('edit-employee-clock-in').value || undefined;
  const scheduledClockOut = document.getElementById('edit-employee-clock-out').value || undefined;
  const breakMinutes = document.getElementById('edit-employee-break').value;
  const breakAllowanceMinutes = breakMinutes ? Number(breakMinutes) : undefined;

  try {
    await window.eva.admin.updateEmployee(id, {
      name,
      scheduledClockIn,
      scheduledClockOut,
      breakAllowanceMinutes,
    });
    closeEditEmployee();
    await loadAdminPanel();
  } catch (err) {
    editEmployeeErrorEl.textContent = err.message || 'Could not update employee.';
  }
});

editEmployeeCancelBtn.addEventListener('click', closeEditEmployee);

changePasswordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  changePasswordErrorEl.textContent = '';

  const currentPassword = document.getElementById('current-password').value;
  const newPassword = document.getElementById('new-password').value;

  try {
    await window.eva.changePassword(currentPassword, newPassword);
    changePasswordForm.reset();
    const wasForced = forcingPasswordChange;
    forcingPasswordChange = false;
    if (wasForced) {
      await finishLogin(await window.eva.getUser());
    } else {
      showView('tracker');
    }
  } catch (err) {
    changePasswordErrorEl.textContent = err.message || 'Could not update password.';
  }
});

init();
