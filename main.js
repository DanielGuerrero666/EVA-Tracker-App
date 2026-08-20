/**
 * Control de Asistencia — proceso principal de Electron
 * =====================================================
 * Responsabilidades:
 *   - Registrar el protocolo asistencia:// para activar por enlace
 *   - Guardar el token del dispositivo CIFRADO con el llavero del sistema
 *   - Hacer todas las llamadas HTTP (el renderer nunca ve el token)
 *   - Icono de bandeja con el estado actual
 */
'use strict';

const { app, BrowserWindow, ipcMain, safeStorage, Tray, Menu, shell, Notification } =
  require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { SERVIDOR } = require('./config');

const VERSION_APP = app.getVersion();
const RUTA_CONFIG = path.join(app.getPath('userData'), 'config.json');
const RUTA_TOKEN = path.join(app.getPath('userData'), 'token.bin');

let ventana = null;
let bandeja = null;
let tokenCache = null;
let estadoActual = 'fuera';
// Sesión de administrador iniciada por correo/contraseña: vive solo en
// memoria de este proceso. Nunca se escribe a disco, así que al cerrar
// la app hay que volver a iniciar sesión — a diferencia del empleado,
// que queda activado para siempre en su equipo.
let sesionAdminMemoria = null;

// ------------------------------------------------------------------
// Instancia única. Sin esto, en Windows cada clic en el enlace
// abriría una copia nueva de la aplicación.
// ------------------------------------------------------------------
const bloqueo = app.requestSingleInstanceLock();
if (!bloqueo) {
  app.quit();
} else {
  app.on('second-instance', (_evento, argv) => {
    // Windows y Linux entregan la URL del protocolo por argv
    const url = argv.find((a) => a.startsWith('asistencia://'));
    if (url) procesarEnlace(url);
    mostrarVentana();
  });
}

// macOS entrega la URL por este evento
app.on('open-url', (evento, url) => {
  evento.preventDefault();
  procesarEnlace(url);
});

// ------------------------------------------------------------------
// Configuración (URL del servidor). No contiene secretos.
// ------------------------------------------------------------------
function leerConfig() {
  try {
    return JSON.parse(fs.readFileSync(RUTA_CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

function guardarConfig(datos) {
  fs.writeFileSync(RUTA_CONFIG, JSON.stringify(datos, null, 2), { mode: 0o600 });
}

// ------------------------------------------------------------------
// Token del dispositivo — cifrado con el llavero del sistema operativo
// (Credential Manager en Windows, Keychain en macOS, libsecret en Linux)
// ------------------------------------------------------------------
function guardarToken(token) {
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(RUTA_TOKEN, safeStorage.encryptString(token), { mode: 0o600 });
  } else {
    // Sin llavero disponible el token queda en texto plano con permisos
    // restringidos. Pasa en algunos Linux sin libsecret instalado.
    console.warn('Llavero no disponible: el token se guarda sin cifrar.');
    fs.writeFileSync(RUTA_TOKEN, token, { mode: 0o600 });
  }
  tokenCache = token;
}

function leerToken() {
  if (tokenCache) return tokenCache;
  try {
    const bruto = fs.readFileSync(RUTA_TOKEN);
    tokenCache = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(bruto)
      : bruto.toString('utf8');
    return tokenCache;
  } catch {
    return null;
  }
}

function borrarToken() {
  tokenCache = null;
  sesionAdminMemoria = null;
  try { fs.unlinkSync(RUTA_TOKEN); } catch { /* no existía */ }
}

// ------------------------------------------------------------------
// Llamadas a la API
// ------------------------------------------------------------------
async function api(ruta, opciones = {}) {
  const token = leerToken();
  const respuesta = await fetch(`${SERVIDOR.replace(/\/$/, '')}${ruta}`, {
    ...opciones,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Token': token } : {}),
      ...(opciones.headers || {}),
    },
  });

  if (respuesta.status === 401) {
    borrarToken();
    throw new Error('Tu acceso fue revocado. Pide una nueva invitación.');
  }

  const cuerpo = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) {
    throw new Error(cuerpo.detail || `Error ${respuesta.status}`);
  }
  return cuerpo;
}

// ------------------------------------------------------------------
// Activación por enlace: asistencia://activar?token=...
// El servidor es siempre el mismo para todos (config.js), así que se
// ignora cualquier "servidor" que traiga el enlace por compatibilidad.
// ------------------------------------------------------------------
async function procesarEnlace(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'activar' && parsed.pathname !== '//activar') {
      return;
    }
    const token = parsed.searchParams.get('token');
    if (!token) throw new Error('El enlace está incompleto.');

    await activar(token);
    mostrarVentana();
    if (ventana) ventana.webContents.send('activado');
  } catch (err) {
    if (ventana) ventana.webContents.send('error-activacion', err.message);
  }
}

async function activar(tokenInvitacion) {
  const respuesta = await fetch(`${SERVIDOR.replace(/\/$/, '')}/api/activar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: tokenInvitacion,
      nombre_equipo: os.hostname(),
      sistema: `${os.type()} ${os.release()}`,
      version_app: VERSION_APP,
    }),
  });

  const cuerpo = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) throw new Error(cuerpo.detail || 'No se pudo activar.');

  guardarToken(cuerpo.token);
  guardarConfig({ nombre: cuerpo.nombre, email: cuerpo.email,
                  es_admin: cuerpo.es_admin });
  return cuerpo;
}

// ------------------------------------------------------------------
// Login de administrador: correo + contraseña, sin invitación.
// El token NO se guarda en disco a propósito.
// ------------------------------------------------------------------
async function loginAdmin(email, password) {
  const respuesta = await fetch(`${SERVIDOR.replace(/\/$/, '')}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email, password,
      nombre_equipo: os.hostname(),
      sistema: `${os.type()} ${os.release()}`,
      version_app: VERSION_APP,
    }),
  });

  const cuerpo = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) throw new Error(cuerpo.detail || 'No se pudo iniciar sesión.');

  tokenCache = cuerpo.token;
  sesionAdminMemoria = { nombre: cuerpo.nombre, email: cuerpo.email, es_admin: true };
  return cuerpo;
}

// ------------------------------------------------------------------
// Ventana
// ------------------------------------------------------------------
function crearVentana() {
  ventana = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 400,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#FAFAFA',
    icon: path.join(__dirname, 'renderer', 'icono.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // el renderer no toca Node
      nodeIntegration: false,
      sandbox: true,
    },
  });

  ventana.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  ventana.once('ready-to-show', () => ventana.show());

  // Cerrar la ventana la envía a la bandeja, no cierra la aplicación:
  // así el empleado no pierde el acceso rápido a marcar salida.
  ventana.on('close', (evento) => {
    if (!app.estaSaliendo) {
      evento.preventDefault();
      ventana.hide();
    }
  });

  // Los enlaces externos abren en el navegador, no dentro de la app
  ventana.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function mostrarVentana() {
  if (!ventana) crearVentana();
  if (ventana.isMinimized()) ventana.restore();
  ventana.show();
  ventana.focus();
}

// ------------------------------------------------------------------
// Bandeja del sistema
// ------------------------------------------------------------------
const ETIQUETA_ESTADO = {
  fuera: 'Fuera',
  trabajando: 'Trabajando',
  en_descanso: 'En descanso',
};

function crearBandeja() {
  const icono = path.join(__dirname, 'renderer', 'icono.png');
  try {
    bandeja = new Tray(icono);
  } catch {
    return; // sin icono disponible, la app sigue funcionando
  }
  actualizarBandeja('fuera');

  bandeja.on('click', mostrarVentana);
}

function actualizarBandeja(estado) {
  estadoActual = estado;
  if (!bandeja) return;

  bandeja.setToolTip(`Control de Asistencia — ${ETIQUETA_ESTADO[estado] || estado}`);
  bandeja.setContextMenu(Menu.buildFromTemplate([
    { label: `Estado: ${ETIQUETA_ESTADO[estado] || estado}`, enabled: false },
    { type: 'separator' },
    { label: 'Abrir', click: mostrarVentana },
    {
      label: 'Salir de la aplicación',
      click: () => { app.estaSaliendo = true; app.quit(); },
    },
  ]));
}

// ------------------------------------------------------------------
// Puente con el renderer
// ------------------------------------------------------------------
ipcMain.handle('sesion:activa', () => {
  if (sesionAdminMemoria) {
    return {
      activa: Boolean(tokenCache),
      nombre: sesionAdminMemoria.nombre,
      email: sesionAdminMemoria.email,
      es_admin: true,
      version: VERSION_APP,
      servidor: SERVIDOR,
    };
  }
  const config = leerConfig();
  return {
    activa: Boolean(leerToken()),
    nombre: config.nombre || null,
    email: config.email || null,
    es_admin: Boolean(config.es_admin),
    version: VERSION_APP,
    servidor: SERVIDOR,
  };
});

// Activación manual: por si el protocolo asistencia:// falla,
// el empleado solo pega el código — el servidor ya viene fijo en la app.
ipcMain.handle('sesion:activar', async (_e, { token }) => {
  const datos = await activar(token);
  return datos;
});

// Login de administrador: correo y contraseña, sin invitación.
ipcMain.handle('sesion:login-admin', async (_e, { email, password }) => {
  const datos = await loginAdmin(email, password);
  return datos;
});

ipcMain.handle('sesion:cerrar', () => {
  borrarToken();
  guardarConfig({});
  return true;
});

ipcMain.handle('api:estado', async () => {
  const datos = await api('/api/estado');
  actualizarBandeja(datos.estado);
  return datos;
});

ipcMain.handle('api:marcar', async (_e, tipo) => {
  const datos = await api('/api/marcar', {
    method: 'POST',
    body: JSON.stringify({ tipo }),
  });
  actualizarBandeja(datos.estado);

  if (Notification.isSupported()) {
    const texto = {
      entrada: 'Entrada registrada',
      descanso_inicio: 'Descanso iniciado',
      descanso_fin: 'Descanso terminado',
      salida: 'Salida registrada',
    }[tipo];
    new Notification({ title: 'Control de Asistencia', body: texto }).show();
  }
  return datos;
});

ipcMain.handle('api:admin', async (_e, { ruta, metodo, cuerpo }) => {
  return api(ruta, {
    method: metodo || 'GET',
    ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
  });
});

// Descarga del Excel: el renderer no puede escribir en disco.
ipcMain.handle('api:exportar', async (_e, { inicio, fin }) => {
  const url = `${SERVIDOR.replace(/\/$/, '')}` +
              `/api/admin/export.xlsx?inicio=${inicio}&fin=${fin}`;
  const respuesta = await fetch(url, { headers: { 'X-Token': leerToken() } });
  if (!respuesta.ok) throw new Error('No se pudo generar el reporte.');

  const destino = path.join(app.getPath('downloads'),
                            `Asistencia_${inicio}_${fin}.xlsx`);
  fs.writeFileSync(destino, Buffer.from(await respuesta.arrayBuffer()));
  shell.showItemInFolder(destino);
  return destino;
});

ipcMain.handle('sistema:copiar', (_e, texto) => {
  require('electron').clipboard.writeText(texto);
  return true;
});

// ------------------------------------------------------------------
// Arranque
// ------------------------------------------------------------------
app.whenReady().then(() => {
  // Registrar asistencia:// como protocolo de esta aplicación
  if (process.defaultApp && process.argv.length >= 2) {
    // Modo desarrollo: hay que indicar la ruta del ejecutable
    app.setAsDefaultProtocolClient('asistencia', process.execPath,
                                   [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('asistencia');
  }

  crearVentana();
  crearBandeja();

  // Windows/Linux: si la app se abrió DESDE el enlace, la URL viene en argv
  const urlInicial = process.argv.find((a) => a.startsWith('asistencia://'));
  if (urlInicial) {
    ventana.webContents.once('did-finish-load', () => procesarEnlace(urlInicial));
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana();
    else mostrarVentana();
  });
});

// En macOS la aplicación sigue viva al cerrar la ventana; en el resto
// la mantenemos en la bandeja para que marcar salida siga a un clic.
app.on('window-all-closed', (evento) => {
  if (process.platform !== 'darwin') evento.preventDefault?.();
});

app.on('before-quit', () => { app.estaSaliendo = true; });
