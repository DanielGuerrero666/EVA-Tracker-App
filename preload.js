const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eva', {
  login: (name, email) => ipcRenderer.invoke('auth:login', { name, email }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getUser: () => ipcRenderer.invoke('auth:getUser'),
  clockIn: () => ipcRenderer.invoke('time:clockIn'),
  clockOut: () => ipcRenderer.invoke('time:clockOut'),
  getStatus: () => ipcRenderer.invoke('time:getStatus'),
  getShifts: (limit) => ipcRenderer.invoke('time:getShifts', limit),
  startBreak: () => ipcRenderer.invoke('break:start'),
  endBreak: () => ipcRenderer.invoke('break:end'),
  getBreakStatus: () => ipcRenderer.invoke('break:getStatus'),
});
