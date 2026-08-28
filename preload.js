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
  setAdminView: (isAdmin) => ipcRenderer.invoke('ui:setAdminView', isAdmin),
  toggleAdminFullScreen: () => ipcRenderer.invoke('ui:toggleAdminFullScreen'),
  onWindowMode: (callback) => {
    const listener = (_event, mode) => callback(mode);
    ipcRenderer.on('ui:windowMode', listener);
    return () => ipcRenderer.removeListener('ui:windowMode', listener);
  },
  admin: {
    listEmployees: () => ipcRenderer.invoke('admin:listEmployees'),
    today: () => ipcRenderer.invoke('admin:today'),
    exportCsv: (params) => ipcRenderer.invoke('admin:exportCsv', params),
    createEmployee: (employee) => ipcRenderer.invoke('admin:createEmployee', employee),
    updateEmployee: (id, updates) => ipcRenderer.invoke('admin:updateEmployee', id, updates),
  },
});
