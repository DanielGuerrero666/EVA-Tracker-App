const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const ApiClient = require('./lib/apiClient');

let mainWindow;
let tray;
let store;
let isQuitting = false;
let updateReady = false;

// The admin panel's table/forms need more room than the compact tracker
// view — the window is widened on demand instead of being sized for the widest
// view all the time.
const WINDOW_WIDTH = 420;
const WINDOW_HEIGHT = 680;
const WINDOW_WIDTH_ADMIN = 760;
const WINDOW_HEIGHT_MIN_ADMIN = 520;

let adminViewActive = false;
// The size the admin last had, so that resizing the panel and then dipping back
// into the tracker doesn't silently throw the resize away.
let adminSize = null;

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

const gotSingleInstanceLock = app.requestSingleInstanceLock();

// The three places the user asks to see the app again: clicking the tray
// icon, picking "Open EVA Tracker" from its menu, or re-launching while an
// instance is already running. Since the window is normally just hidden
// (not closed) rather than reopened, none of these naturally restart the
// process — which is required to actually swap in a downloaded update. So
// this is also the one safe, non-disruptive moment to apply a pending
// update: the user is asking to use the app right now anyway, and the
// persisted session means the silent restart won't even require logging
// in again.
function showOrApplyUpdate() {
  if (updateReady) {
    autoUpdater.quitAndInstall(true, true);
    return;
  }
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showOrApplyUpdate();
  });
}

// The admin panel is the only view the user may resize, maximise or put full
// screen. Every other view — login, tracker, change-password — is one fixed
// column of controls that gains nothing from being dragged about, so the window
// is pinned shut again the moment the panel is closed. resizable alone is not
// enough: the maximise button and the full-screen entry point are separate
// capabilities and have to be withdrawn explicitly.
function lockCompactSize() {
  if (!mainWindow) return;

  // Order matters: setFullScreen() is a no-op whenever fullScreenable is false,
  // so the window has to be brought back out of full screen BEFORE that
  // capability is withdrawn at the end of this function, or it is stranded full
  // screen with no way out. Doing it here — rather than from a
  // 'leave-full-screen' handler — is also what makes the resize below stick:
  // on Windows that event is emitted *before* the transition runs, so
  // isFullScreen() still reports the old value inside it and any setSize() from
  // there is overwritten by the saved-rect restore. The whole native chain is
  // synchronous, so by the time setFullScreen(false) returns the window is
  // genuinely back to its pre-full-screen rect.
  if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
  if (mainWindow.isMaximized()) mainWindow.unmaximize();

  mainWindow.setResizable(true);
  // Both constraints have to be relaxed before the window will move:
  // setSize() is clamped *up* to the current minimum, and every setSize() on a
  // non-resizable window pins minimum and maximum to the size it had at the
  // time — so the compact window carries a 420x680 ceiling that would silently
  // swallow the growth to 760. 0 means unbounded.
  mainWindow.setMaximumSize(0, 0);
  mainWindow.setMinimumSize(WINDOW_WIDTH, WINDOW_HEIGHT);
  mainWindow.setSize(WINDOW_WIDTH, WINDOW_HEIGHT);
  mainWindow.setResizable(false);
  mainWindow.setMaximizable(false);
  mainWindow.setFullScreenable(false);
}

function unlockAdminSize() {
  if (!mainWindow) return;

  // setResizable(true) first: while the window is non-resizable, every resize
  // re-pins its minimum and maximum to the requested size, which is exactly
  // what would block the growth below.
  mainWindow.setResizable(true);
  mainWindow.setMaximizable(true);
  mainWindow.setFullScreenable(true);

  const [, currentHeight] = mainWindow.getSize();
  mainWindow.setMaximumSize(0, 0);
  // Raise the floor so the roster table can never be squeezed narrower than it
  // was designed for; growing past it in the same tick is fine.
  mainWindow.setMinimumSize(WINDOW_WIDTH_ADMIN, WINDOW_HEIGHT_MIN_ADMIN);
  const [width, height] = adminSize || [
    WINDOW_WIDTH_ADMIN,
    Math.max(currentHeight, WINDOW_HEIGHT_MIN_ADMIN),
  ];
  mainWindow.setSize(width, height);
}

// Full screen and maximise both hide the frame's usual affordances, so the
// renderer is told about them: it swaps the panel's button label and lets the
// card use the extra width.
//
// `overrides` is not a convenience. On Windows the full-screen events are
// emitted before Electron flips the underlying flag, so isFullScreen() reports
// the *previous* value inside those handlers — reading it back would send the
// renderer exactly the opposite of what just happened.
function sendWindowMode(overrides) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('ui:windowMode', {
    fullScreen: mainWindow.isFullScreen(),
    maximized: mainWindow.isMaximized(),
    ...overrides,
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#FFFFFF',
    icon: path.join(__dirname, 'build/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const user = store.getUser();
  mainWindow.loadFile(path.join('src', user ? 'tracker.html' : 'login.html'));

  // Closing the window hides it to the tray instead of quitting — the app
  // keeps tracking in the background until "Quit" is chosen from the tray.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('enter-full-screen', () => sendWindowMode({ fullScreen: true }));
  mainWindow.on('leave-full-screen', () => sendWindowMode({ fullScreen: false }));
  mainWindow.on('maximize', () => sendWindowMode({ maximized: true }));
  mainWindow.on('unmaximize', () => sendWindowMode({ maximized: false }));
}

async function updateTrayTooltip() {
  if (!tray || !store.getUser()) return;
  const status = await store.getStatus().catch(() => null);
  if (!status) return;
  const suffix = updateReady ? ' (update ready — restart to apply)' : '';
  tray.setToolTip(`EVA Tracker — ${status.clockedIn ? 'Clocked In' : 'Clocked Out'}${suffix}`);
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open EVA Tracker', click: showOrApplyUpdate },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'src/assets/tray-icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('EVA Tracker');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', showOrApplyUpdate);

  updateTrayTooltip();
}

if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    store = new ApiClient({
      onSessionExpired: () => {
        if (!mainWindow) return;
        adminViewActive = false;
        lockCompactSize();
        mainWindow.loadFile(path.join('src', 'login.html'));
      },
    });
    createWindow();
    createTray();

    // checkForUpdates() (not checkForUpdatesAndNotify()) — still downloads
    // silently in the background via autoDownload, just without the native
    // OS "update downloaded" notification. Installing happens later, on
    // demand, via showOrApplyUpdate().
    autoUpdater.checkForUpdates();
    setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
  });
}

autoUpdater.on('update-downloaded', () => {
  updateReady = true;
  updateTrayTooltip();
});

autoUpdater.on('error', (err) => {
  console.error('autoUpdater error:', err);
});

app.on('before-quit', () => {
  isQuitting = true;
});

ipcMain.handle('auth:login', async (_event, { email, password }) => {
  const user = await store.login(email, password);
  adminViewActive = false;
  lockCompactSize();
  mainWindow.loadFile(path.join('src', 'tracker.html'));
  updateTrayTooltip();
  return user;
});

ipcMain.handle('auth:logout', async () => {
  await store.logout();
  // Logging out from the admin panel must not leave the login screen sitting in
  // a wide, resizable — possibly full-screen — window.
  adminViewActive = false;
  lockCompactSize();
  mainWindow.loadFile(path.join('src', 'login.html'));
  updateTrayTooltip();
});

ipcMain.handle('auth:getUser', () => store.getUser());

ipcMain.handle('time:clockIn', async () => {
  const result = await store.clockIn();
  updateTrayTooltip();
  return result;
});
ipcMain.handle('time:clockOut', async () => {
  const result = await store.clockOut();
  updateTrayTooltip();
  return result;
});
ipcMain.handle('time:getStatus', () => store.getStatus());
ipcMain.handle('time:getShifts', (_event, limit) => store.getShifts(limit));

ipcMain.handle('break:start', () => store.startBreak());
ipcMain.handle('break:end', () => store.endBreak());
ipcMain.handle('break:getStatus', () => store.getBreakStatus());

ipcMain.handle('auth:changePassword', (_event, { currentPassword, newPassword }) =>
  store.changePassword(currentPassword, newPassword)
);

ipcMain.handle('admin:listEmployees', () => store.listEmployees());
ipcMain.handle('admin:today', () => store.today());
ipcMain.handle('admin:createEmployee', (_event, employee) => store.createEmployee(employee));
ipcMain.handle('admin:updateEmployee', (_event, id, updates) => store.updateEmployee(id, updates));

ipcMain.handle('admin:exportCsv', async (_event, params) => {
  const { csv, filename } = await store.exportCsv(params);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: filename,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { saved: false };
  fs.writeFileSync(filePath, csv);
  return { saved: true, path: filePath };
});

// handle(), not on(), so the renderer can await the frame actually being wide
// before it applies the CSS class that widens the card inside it — otherwise the
// card is briefly wider than the window and its left edge is clipped away.
ipcMain.handle('ui:setAdminView', (_event, isAdmin) => {
  if (!mainWindow) return;

  if (adminViewActive && !isAdmin && !mainWindow.isFullScreen() && !mainWindow.isMaximized()) {
    adminSize = mainWindow.getSize();
  }

  adminViewActive = Boolean(isAdmin);
  if (adminViewActive) unlockAdminSize();
  else lockCompactSize();
});

ipcMain.handle('ui:toggleAdminFullScreen', () => {
  // Guarded on adminViewActive so a stale message from any other view cannot
  // unlock the window.
  if (!mainWindow || !adminViewActive) return false;
  const next = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(next);
  return next;
});
