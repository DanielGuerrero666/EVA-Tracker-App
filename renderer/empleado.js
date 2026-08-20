/**
 * Control de Asistencia — lado del EMPLEADO: activación por invitación
 * (sin contraseña) y marcación de entrada/descanso/salida.
 * Requiere que comun.js se haya cargado antes.
 */
'use strict';

// ==================================================================
// Activación por código de invitación
// ==================================================================
$('btnActivar').addEventListener('click', async () => {
  const codigo = $('inCodigo').value.trim();

  if (!codigo) {
    return mostrarMsg('msgActivacion', 'Pega el código de invitación.');
  }

  $('btnActivar').disabled = true;
  try {
    // El código puede venir pegado como enlace completo
    const token = codigo.includes('/invitacion/')
      ? codigo.split('/invitacion/')[1].split(/[?#]/)[0]
      : codigo;

    await window.asistencia.activar(token);
    await iniciar();
  } catch (err) {
    mostrarMsg('msgActivacion', err.message);
  } finally {
    $('btnActivar').disabled = false;
  }
});

// Activación automática por enlace asistencia://
window.asistencia.alActivar(() => iniciar());
window.asistencia.alFallarActivacion((mensaje) =>
  mostrarMsg('msgActivacion', mensaje));

// ==================================================================
// Pantalla principal — estado y marcación
// ==================================================================
const ETIQUETAS = {
  fuera: { texto: 'Fuera de jornada', color: 'var(--grey-claro)' },
  trabajando: { texto: 'Trabajando', color: 'var(--verde)' },
  en_descanso: { texto: 'En descanso', color: 'var(--naranja)' },
};

async function cargarEstado() {
  try {
    const datos = await window.asistencia.obtenerEstado();
    configUsuario = datos.config;

    const info = ETIQUETAS[datos.estado] || ETIQUETAS.fuera;
    $('punto').style.background = info.color;
    $('estadoTexto').textContent = info.texto;
    $('estadoDetalle').textContent = datos.desde
      ? `Desde las ${fmtHora(datos.desde)}`
      : '';

    aplicarAcciones(datos.estado, datos.acciones_validas);
    pintarMarcacionesHoy(datos.marcaciones_hoy);
    pintarProgreso(datos);
    pintarHistorial(datos.historial);
  } catch (err) {
    mostrarMsg('msgMarcar', err.message);
    if (err.message.includes('revocado')) mostrarPantalla('pantallaActivacion');
  }
}

/** Habilita solo los botones que el servidor considera válidos. */
function aplicarAcciones(estado, validas) {
  const enDescanso = estado === 'en_descanso';

  $('btnEntrada').disabled = !validas.includes('entrada');
  $('btnSalida').disabled = !validas.includes('salida');

  // El botón de descanso alterna entre iniciar y terminar.
  const btnD = $('btnDescanso');
  btnD.dataset.tipo = enDescanso ? 'descanso_fin' : 'descanso_inicio';
  btnD.querySelector('.btn-titulo').textContent = enDescanso ? 'Terminar' : 'Descanso';
  $('subDescanso').textContent = enDescanso ? 'Volver al trabajo' : 'Tomar descanso';
  btnD.disabled = !(validas.includes('descanso_inicio') || validas.includes('descanso_fin'));
}

function pintarMarcacionesHoy(marcaciones) {
  const nombres = {
    entrada: 'Entrada',
    descanso_inicio: 'Inicio de descanso',
    descanso_fin: 'Fin de descanso',
    salida: 'Salida',
  };
  if (!marcaciones.length) {
    $('marcacionesHoy').innerHTML = '<div class="vacio">Sin marcaciones hoy.</div>';
    return;
  }
  $('marcacionesHoy').innerHTML = `
    <table><tbody>
      ${marcaciones.map((m) => `
        <tr>
          <td>${nombres[m.tipo] || m.tipo}</td>
          <td style="text-align:right"><b>${fmtHora(m.marcado_en)}</b></td>
        </tr>`).join('')}
    </tbody></table>`;
}

/** Barras de progreso del día en curso. */
function pintarProgreso(datos) {
  const hoy = datos.historial[0];
  const esHoy = hoy && new Date(`${hoy.fecha}T12:00:00`).toDateString() === new Date().toDateString();

  const trabajadas = esHoy ? Number(hoy.horas_trabajadas) : 0;
  const descansoMin = esHoy ? Math.round(Number(hoy.horas_descanso) * 60) : 0;

  const esperado = trabajoEsperado(configUsuario);
  const permitido = configUsuario.descanso_minutos;

  $('trabajadoHoy').textContent = horasATexto(trabajadas);
  $('barraTrabajo').style.width =
    `${Math.min((trabajadas / Math.max(esperado, 0.01)) * 100, 100)}%`;
  $('metaTrabajo').textContent =
    `Meta: ${esperado.toFixed(2)} h de trabajo efectivo` +
    (trabajadas >= esperado ? ' — cumplida' : '');

  $('descansoHoy').textContent = `${descansoMin} min`;
  const pctD = permitido > 0 ? (descansoMin / permitido) * 100 : 0;
  const barraD = $('barraDescanso');
  barraD.style.width = `${Math.min(pctD, 100)}%`;
  barraD.classList.toggle('excedido', descansoMin > permitido);
  $('metaDescanso').textContent = descansoMin > permitido
    ? `Excediste el descanso en ${descansoMin - permitido} min`
    : `Permitido: ${permitido} min`;
}

function pintarHistorial(filas) {
  if (!filas.length) {
    $('historial').innerHTML = '<div class="vacio">Aún no tienes registros.</div>';
    return;
  }
  $('historial').innerHTML = `
    <table>
      <thead><tr>
        <th>Fecha</th><th>Entrada</th><th>Salida</th><th>Desc.</th><th>Trabajado</th>
      </tr></thead>
      <tbody>${filas.map((f) => `
        <tr>
          <td>${fmtFecha(f.fecha)}</td>
          <td>${fmtHora(f.primera_entrada)}</td>
          <td>${fmtHora(f.ultima_salida)}</td>
          <td${Number(f.descanso_excedido_min) > 0 ? ' style="color:var(--rojo)"' : ''}>
            ${Math.round(Number(f.horas_descanso) * 60)}m</td>
          <td><b>${Number(f.horas_trabajadas).toFixed(2)}</b></td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

// Los tres botones comparten manejador
document.querySelectorAll('.btn-marcar').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const tipo = btn.dataset.tipo;
    document.querySelectorAll('.btn-marcar').forEach((b) => { b.disabled = true; });
    try {
      const datos = await window.asistencia.marcar(tipo);
      const nombres = {
        entrada: 'Entrada registrada',
        descanso_inicio: 'Descanso iniciado',
        descanso_fin: 'Descanso terminado',
        salida: 'Salida registrada',
      };
      mostrarMsg('msgMarcar', `${nombres[tipo]} a las ${fmtHora(datos.marcado_en)}.`, 'ok');
    } catch (err) {
      mostrarMsg('msgMarcar', err.message);
    }
    await cargarEstado();
  });
});

// Cerrar sesión del empleado en este equipo (⋯ en la pantalla principal).
$('btnMenu').addEventListener('click', async () => {
  if (confirm('¿Cerrar sesión en este equipo? Necesitarás una invitación nueva.')) {
    await window.asistencia.cerrarSesion();
    mostrarPantalla('pantallaActivacion');
  }
});
