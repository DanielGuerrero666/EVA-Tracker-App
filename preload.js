/**
 * Puente seguro entre el proceso principal y la interfaz.
 * El renderer no tiene acceso a Node ni al token del dispositivo:
 * solo puede llamar a estas funciones.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('asistencia', {
  // Sesión
  sesionActiva: () => ipcRenderer.invoke('sesion:activa'),
  activar: (token) => ipcRenderer.invoke('sesion:activar', { token }),
  loginAdmin: (email, password) =>
    ipcRenderer.invoke('sesion:login-admin', { email, password }),
  cerrarSesion: () => ipcRenderer.invoke('sesion:cerrar'),

  // Marcación
  obtenerEstado: () => ipcRenderer.invoke('api:estado'),
  marcar: (tipo) => ipcRenderer.invoke('api:marcar', tipo),

  // Administración
  admin: (ruta, metodo, cuerpo) =>
    ipcRenderer.invoke('api:admin', { ruta, metodo, cuerpo }),
  exportar: (inicio, fin) =>
    ipcRenderer.invoke('api:exportar', { inicio, fin }),

  // Utilidades
  copiar: (texto) => ipcRenderer.invoke('sistema:copiar', texto),

  // Eventos desde el proceso principal
  alActivar: (callback) => ipcRenderer.on('activado', () => callback()),
  alFallarActivacion: (callback) =>
    ipcRenderer.on('error-activacion', (_e, mensaje) => callback(mensaje)),
});
