const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eva', {
  login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getUser: () => ipcRenderer.invoke('auth:getUser'),
  clockIn: () => ipcRenderer.invoke('time:clockIn'),
  clockOut: () => ipcRenderer.invoke('time:clockOut'),
  getStatus: () => ipcRenderer.invoke('time:getStatus'),
  getShifts: (limit) => ipcRenderer.invoke('time:getShifts', limit),
  startBreak: () => ipcRenderer.invoke('break:start'),
  endBreak: () => ipcRenderer.invoke('break:end'),
  getBreakStatus: () => ipcRenderer.invoke('break:getStatus'),
  changePassword: (currentPassword, newPassword) =>
    ipcRenderer.invoke('auth:changePassword', { currentPassword, newPassword }),
  admin: {
    listEmployees: () => ipcRenderer.invoke('admin:listEmployees'),
    today: () => ipcRenderer.invoke('admin:today'),
    exportCsv: () => ipcRenderer.invoke('admin:exportCsv'),
    createEmployee: (employee) => ipcRenderer.invoke('admin:createEmployee', employee),
    updateEmployee: (id, updates) => ipcRenderer.invoke('admin:updateEmployee', id, updates),
  },
});
