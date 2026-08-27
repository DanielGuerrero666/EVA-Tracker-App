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
// view — the (non-resizable) window is widened on demand instead of being
// sized for the widest view all the time.
const WINDOW_WIDTH = 420;
const WINDOW_WIDTH_ADMIN = 760;

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: 680,
    resizable: false,
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
        if (mainWindow) mainWindow.loadFile(path.join('src', 'login.html'));
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
  mainWindow.loadFile(path.join('src', 'tracker.html'));
  updateTrayTooltip();
  return user;
});

ipcMain.handle('auth:logout', async () => {
  await store.logout();
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

ipcMain.on('ui:setAdminView', (_event, isAdmin) => {
  if (!mainWindow) return;
  const [, height] = mainWindow.getSize();
  // On Windows, setSize() on a resizable:false window reliably grows it but
  // often silently no-ops when shrinking back — toggling resizable around
  // the call forces the OS to actually apply the new (smaller) size.
  mainWindow.setResizable(true);
  mainWindow.setSize(isAdmin ? WINDOW_WIDTH_ADMIN : WINDOW_WIDTH, height);
  mainWindow.setResizable(false);
});
