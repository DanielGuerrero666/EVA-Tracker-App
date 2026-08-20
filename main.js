const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const DataStore = require('./lib/dataStore');

let mainWindow;
let tray;
let store;
let isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
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

function updateTrayTooltip() {
  if (!tray || !store.getUser()) return;
  const status = store.getStatus();
  tray.setToolTip(`EVA Tracker — ${status.clockedIn ? 'Clocked In' : 'Clocked Out'}`);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'src/assets/tray-icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('EVA Tracker');

  const menu = Menu.buildFromTemplate([
    { label: 'Open EVA Tracker', click: () => mainWindow.show() },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => mainWindow.show());

  updateTrayTooltip();
}

app.whenReady().then(() => {
  store = new DataStore();
  createWindow();
  createTray();
});

app.on('before-quit', () => {
  isQuitting = true;
});

ipcMain.handle('auth:login', (_event, { name, email }) => {
  const user = store.setUser({ name, email });
  mainWindow.loadFile(path.join('src', 'tracker.html'));
  updateTrayTooltip();
  return user;
});

ipcMain.handle('auth:logout', () => {
  store.clearUser();
  mainWindow.loadFile(path.join('src', 'login.html'));
  updateTrayTooltip();
});

ipcMain.handle('auth:getUser', () => store.getUser());

ipcMain.handle('time:clockIn', () => {
  const result = store.clockIn();
  updateTrayTooltip();
  return result;
});
ipcMain.handle('time:clockOut', () => {
  const result = store.clockOut();
  updateTrayTooltip();
  return result;
});
ipcMain.handle('time:getStatus', () => store.getStatus());
ipcMain.handle('time:getShifts', (_event, limit) => store.getShifts(limit));

ipcMain.handle('break:start', () => store.startBreak());
ipcMain.handle('break:end', () => store.endBreak());
ipcMain.handle('break:getStatus', () => store.getBreakStatus());
