/**
 * Control de Asistencia — utilidades compartidas entre la parte de
 * empleado (empleado.js) y la de administrador (admin.js).
 * No tiene acceso a Node ni al token: todo pasa por window.asistencia (preload).
 */
'use strict';

const $ = (id) => document.getElementById(id);

// Estado compartido entre empleado.js y admin.js.
let esAdmin = false;
let configUsuario = { jornada_horas: 8, descanso_minutos: 60, jornada_incluye_descanso: true };
let empleadoEditando = null;

// ==================================================================
// Utilidades de formato
// ==================================================================
function mostrarMsg(destino, texto, tipo = 'err') {
  $(destino).innerHTML = texto ? `<div class="msg ${tipo}">${texto}</div>` : '';
  if (texto && tipo === 'ok') {
    setTimeout(() => { $(destino).innerHTML = ''; }, 4000);
  }
}

function fmtHora(valor) {
  if (!valor) return '—';
  return new Date(valor).toLocaleTimeString('es-CO',
    { hour: '2-digit', minute: '2-digit' });
}

function fmtFecha(valor) {
  if (!valor) return '—';
  const iso = valor.length === 10 ? `${valor}T12:00:00` : valor;
  return new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
}

function horasATexto(horas) {
  const total = Math.round(Number(horas) * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h} h ${m.toString().padStart(2, '0')} min` : `${m} min`;
}

// Trabajo efectivo esperado, con la misma regla que usa el servidor.
function trabajoEsperado(cfg) {
  return cfg.jornada_incluye_descanso
    ? Math.max(cfg.jornada_horas - cfg.descanso_minutos / 60, 0)
    : cfg.jornada_horas;
}

function textoAyudaJornada(jornada, descansoMin, incluye) {
  const efectivo = incluye ? Math.max(jornada - descansoMin / 60, 0) : jornada;
  const presencia = incluye ? jornada : jornada + descansoMin / 60;
  return `Con esta configuración: ${presencia.toFixed(2)} h de presencia total, ` +
         `de las cuales ${efectivo.toFixed(2)} h son de trabajo efectivo.`;
}

// ==================================================================
// Reloj
// ==================================================================
setInterval(() => {
  const ahora = new Date();
  if ($('reloj')) {
    $('reloj').textContent = ahora.toLocaleTimeString('es-CO', { hour12: false });
  }
  if ($('fechaHoy')) {
    $('fechaHoy').textContent = ahora.toLocaleDateString('es-CO',
      { weekday: 'long', day: 'numeric', month: 'long' });
  }
}, 1000);

// ==================================================================
// Navegación entre pantallas
// ==================================================================
function mostrarPantalla(id) {
  ['pantallaActivacion', 'pantallaPrincipal', 'pantallaAdmin']
    .forEach((p) => $(p).classList.toggle('oculta', p !== id));
}

// ==================================================================
// Arranque — decide qué pantalla mostrar según la sesión guardada.
// Se invoca al final de admin.js, una vez que empleado.js y admin.js
// ya definieron cargarEstado()/cargarAdmin().
// ==================================================================
async function iniciar() {
  const sesion = await window.asistencia.sesionActiva();

  if (!sesion.activa) {
    mostrarPantalla('pantallaActivacion');
    return;
  }

  esAdmin = sesion.es_admin;
  $('nombreUsuario').textContent = (sesion.nombre || '').split(' ')[0];
  $('btnPanelAdmin').classList.toggle('oculta', !esAdmin);

  if (esAdmin) {
    const hoy = new Date();
    $('exFin').value = hoy.toISOString().slice(0, 10);
    $('exInicio').value = new Date(hoy.getFullYear(), hoy.getMonth(), 1)
      .toISOString().slice(0, 10);
  }

  mostrarPantalla('pantallaPrincipal');
  await cargarEstado();
}
