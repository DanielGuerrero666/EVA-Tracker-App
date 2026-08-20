/**
 * Control de Asistencia — lado del ADMINISTRADOR: login con correo y
 * contraseña, panel de gestión de empleados, invitaciones y reportes.
 * Requiere que comun.js (y, para el arranque final, empleado.js) se
 * hayan cargado antes.
 */
'use strict';

// ---------- Alternar entre la tarjeta de empleado y la de administrador ----------
$('lnkSoyAdmin').addEventListener('click', (e) => {
  e.preventDefault();
  $('tarjetaEmpleado').classList.add('oculta');
  $('tarjetaAdmin').classList.remove('oculta');
});
$('lnkSoyEmpleado').addEventListener('click', (e) => {
  e.preventDefault();
  $('tarjetaAdmin').classList.add('oculta');
  $('tarjetaEmpleado').classList.remove('oculta');
});

// ---------- Login de administrador (correo + contraseña) ----------
async function intentarLoginAdmin() {
  const email = $('inEmailAdmin').value.trim();
  const password = $('inPasswordLoginAdmin').value;
  if (!email || !password) {
    return mostrarMsg('msgLoginAdmin', 'Escribe tu correo y contraseña.');
  }

  $('btnLoginAdmin').disabled = true;
  try {
    const sesion = await window.asistencia.loginAdmin(email, password);
    esAdmin = true;
    $('nombreUsuario').textContent = (sesion.nombre || '').split(' ')[0];
    $('inPasswordLoginAdmin').value = '';
    mostrarPantalla('pantallaAdmin');
    cargarAdmin();
  } catch (err) {
    mostrarMsg('msgLoginAdmin', err.message);
  } finally {
    $('btnLoginAdmin').disabled = false;
  }
}
$('btnLoginAdmin').addEventListener('click', intentarLoginAdmin);
$('inPasswordLoginAdmin').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') intentarLoginAdmin();
});

// ---------- Navegación del panel ----------
$('btnPanelAdmin').addEventListener('click', () => {
  mostrarPantalla('pantallaAdmin');
  cargarAdmin();
});
$('btnVolver').addEventListener('click', () => {
  mostrarPantalla('pantallaPrincipal');
  cargarEstado();
});
$('btnCerrarSesionAdmin').addEventListener('click', async () => {
  await window.asistencia.cerrarSesion();
  mostrarPantalla('pantallaActivacion');
  $('tarjetaAdmin').classList.remove('oculta');
  $('tarjetaEmpleado').classList.add('oculta');
});

// ---------- Formulario "Agregar empleado" ----------
function actualizarAyudaJornada() {
  $('ayudaJornada').textContent = textoAyudaJornada(
    Number($('nvJornada').value) || 0,
    Number($('nvDescanso').value) || 0,
    $('nvIncluye').checked);
}
['nvJornada', 'nvDescanso', 'nvIncluye'].forEach((id) =>
  $(id).addEventListener('input', actualizarAyudaJornada));

$('nvAdmin').addEventListener('change', () => {
  $('campoPasswordAdmin').classList.toggle('oculta', !$('nvAdmin').checked);
});

// ---------- Carga del panel ----------
async function cargarAdmin() {
  actualizarAyudaJornada();
  try {
    const [panel, equipo] = await Promise.all([
      window.asistencia.admin('/api/admin/hoy'),
      window.asistencia.admin('/api/admin/empleados'),
    ]);
    pintarAlertas(panel);
    pintarEmpleados(equipo.empleados);
  } catch (err) {
    mostrarMsg('msgAdmin', err.message);
  }
}

function pintarAlertas(panel) {
  const olvidos = panel.sin_salida || [];
  const dentro = panel.dentro_ahora || [];
  const excedidos = (panel.registros_hoy || [])
    .filter((r) => Number(r.descanso_excedido_min) > 0);

  let html = '';

  if (olvidos.length) {
    html += `<div class="msg err">
      <b>${olvidos.length} jornada${olvidos.length > 1 ? 's' : ''} sin salida.</b>
      Estas horas no aparecen en el reporte hasta corregirlas.<br>
      ${olvidos.map((o) => `${o.nombre} — ${fmtFecha(o.fecha)}`).join('<br>')}
    </div>`;
  }

  if (excedidos.length) {
    html += `<div class="msg avi">
      <b>Descanso excedido hoy:</b><br>
      ${excedidos.map((e) => `${e.nombre} — ${e.descanso_excedido_min} min de más`).join('<br>')}
    </div>`;
  }

  html += `<div class="tarjeta">
    <h2>Dentro ahora (${dentro.length})</h2>
    ${dentro.length ? `<table>
      <thead><tr><th>Empleado</th><th>Entrada</th><th>Lleva</th></tr></thead>
      <tbody>${dentro.map((d) => `
        <tr>
          <td>${d.nombre}</td>
          <td>${fmtHora(d.entrada)}</td>
          <td><b>${Number(d.horas_transcurridas).toFixed(1)} h</b></td>
        </tr>`).join('')}
      </tbody></table>` : '<div class="vacio">Nadie tiene jornada abierta.</div>'}
  </div>`;

  $('alertas').innerHTML = html;
}

function pintarEmpleados(lista) {
  if (!lista.length) {
    $('listaEmpleados').innerHTML = '<div class="vacio">Aún no hay empleados.</div>';
    return;
  }
  $('listaEmpleados').innerHTML = lista.map((e) => `
    <div class="empleado">
      <div class="empleado-info">
        <div class="empleado-nombre">
          ${e.nombre}
          ${e.es_admin ? '<span class="etiqueta-chip chip-admin">admin</span>' : ''}
          ${e.dispositivos === 0 && e.invitacion_pendiente
            ? '<span class="etiqueta-chip chip-pendiente">sin activar</span>' : ''}
        </div>
        <div class="empleado-meta">
          ${e.email} · ${Number(e.jornada_horas).toFixed(2)} h jornada ·
          ${e.descanso_minutos} min descanso ·
          ${Number(e.trabajo_esperado).toFixed(2)} h efectivas
        </div>
      </div>
      <div class="acciones-emp">
        <button class="btn-mini" data-editar="${e.id}">Horario</button>
        <button class="btn-mini" data-invitar="${e.id}">Enlace</button>
      </div>
    </div>`).join('');

  $('listaEmpleados').querySelectorAll('[data-editar]').forEach((btn) =>
    btn.addEventListener('click', () =>
      abrirEditor(lista.find((x) => x.id === Number(btn.dataset.editar)))));

  $('listaEmpleados').querySelectorAll('[data-invitar]').forEach((btn) =>
    btn.addEventListener('click', () => generarEnlace(Number(btn.dataset.invitar))));
}

// ---------- Crear empleado ----------
$('btnCrear').addEventListener('click', async () => {
  const cuerpo = {
    nombre: $('nvNombre').value.trim(),
    email: $('nvEmail').value.trim(),
    departamento: $('nvDepto').value.trim() || null,
    jefe_email: $('nvJefe').value.trim() || null,
    jornada_horas: Number($('nvJornada').value),
    descanso_minutos: Number($('nvDescanso').value),
    jornada_incluye_descanso: $('nvIncluye').checked,
    es_admin: $('nvAdmin').checked,
  };
  if (cuerpo.es_admin) cuerpo.password = $('nvPassword').value;

  if (!cuerpo.nombre || !cuerpo.email) {
    return mostrarMsg('msgAdmin', 'El nombre y el correo son obligatorios.');
  }
  if (cuerpo.es_admin && (!cuerpo.password || cuerpo.password.length < 8)) {
    return mostrarMsg('msgAdmin', 'La contraseña de administrador debe tener mínimo 8 caracteres.');
  }

  $('btnCrear').disabled = true;
  try {
    const res = await window.asistencia.admin('/api/admin/empleados', 'POST', cuerpo);
    mostrarEnlace(res.enlace);
    mostrarMsg('msgAdmin', `${cuerpo.nombre} fue creado. Envíale el enlace.`, 'ok');
    ['nvNombre', 'nvEmail', 'nvDepto', 'nvJefe', 'nvPassword'].forEach((id) => { $(id).value = ''; });
    $('nvAdmin').checked = false;
    $('campoPasswordAdmin').classList.add('oculta');
    await cargarAdmin();
  } catch (err) {
    mostrarMsg('msgAdmin', err.message);
  } finally {
    $('btnCrear').disabled = false;
  }
});

async function generarEnlace(empleadoId) {
  try {
    const res = await window.asistencia.admin(
      `/api/admin/empleados/${empleadoId}/invitacion`, 'POST');
    mostrarEnlace(res.enlace);
    mostrarMsg('msgAdmin',
      `Enlace nuevo generado. El anterior quedó anulado.`, 'ok');
  } catch (err) {
    mostrarMsg('msgAdmin', err.message);
  }
}

function mostrarEnlace(enlace) {
  $('tarjetaEnlace').classList.remove('oculta');
  $('enlaceGenerado').textContent = enlace;
  $('tarjetaEnlace').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

$('btnCopiar').addEventListener('click', async () => {
  await window.asistencia.copiar($('enlaceGenerado').textContent);
  $('btnCopiar').textContent = 'Copiado';
  setTimeout(() => { $('btnCopiar').textContent = 'Copiar enlace'; }, 2000);
});

// ---------- Editar horario ----------
function abrirEditor(empleado) {
  empleadoEditando = empleado;
  $('tituloEditar').textContent = `Horario de ${empleado.nombre}`;
  $('edJornada').value = Number(empleado.jornada_horas);
  $('edDescanso').value = empleado.descanso_minutos;
  $('edIncluye').checked = empleado.jornada_incluye_descanso;
  actualizarAyudaEditar();
  $('msgEditar').innerHTML = '';
  $('modalEditar').classList.remove('oculta');
}

function actualizarAyudaEditar() {
  $('ayudaEditar').textContent = textoAyudaJornada(
    Number($('edJornada').value) || 0,
    Number($('edDescanso').value) || 0,
    $('edIncluye').checked);
}
['edJornada', 'edDescanso', 'edIncluye'].forEach((id) =>
  $(id).addEventListener('input', actualizarAyudaEditar));

$('btnCancelarEditar').addEventListener('click', () =>
  $('modalEditar').classList.add('oculta'));

$('btnGuardarEditar').addEventListener('click', async () => {
  $('btnGuardarEditar').disabled = true;
  try {
    await window.asistencia.admin(
      `/api/admin/empleados/${empleadoEditando.id}`, 'PATCH', {
        jornada_horas: Number($('edJornada').value),
        descanso_minutos: Number($('edDescanso').value),
        jornada_incluye_descanso: $('edIncluye').checked,
      });
    $('modalEditar').classList.add('oculta');
    mostrarMsg('msgAdmin', `Horario de ${empleadoEditando.nombre} actualizado.`, 'ok');
    await cargarAdmin();
  } catch (err) {
    mostrarMsg('msgEditar', err.message);
  } finally {
    $('btnGuardarEditar').disabled = false;
  }
});

// ---------- Exportar ----------
$('btnExportar').addEventListener('click', async () => {
  const inicio = $('exInicio').value;
  const fin = $('exFin').value;
  if (!inicio || !fin) return mostrarMsg('msgAdmin', 'Selecciona el rango de fechas.');

  $('btnExportar').disabled = true;
  try {
    const ruta = await window.asistencia.exportar(inicio, fin);
    mostrarMsg('msgAdmin', `Archivo guardado en: ${ruta}`, 'ok');
  } catch (err) {
    mostrarMsg('msgAdmin', err.message);
  } finally {
    $('btnExportar').disabled = false;
  }
});

// Excel con todo el historial, sin tener que elegir fechas.
$('btnExportarTodo').addEventListener('click', async () => {
  $('btnExportarTodo').disabled = true;
  try {
    const hoy = new Date().toISOString().slice(0, 10);
    const ruta = await window.asistencia.exportar('2020-01-01', hoy);
    mostrarMsg('msgAdmin', `Excel completo guardado en: ${ruta}`, 'ok');
  } catch (err) {
    mostrarMsg('msgAdmin', err.message);
  } finally {
    $('btnExportarTodo').disabled = false;
  }
});

// ==================================================================
// Arranque de la app — se dispara aquí porque este es el último script
// en cargar (comun.js define iniciar(), empleado.js define cargarEstado()).
// ==================================================================
iniciar();

// Refresco periódico, por si marcó desde otro equipo
setInterval(() => {
  if (!$('pantallaPrincipal').classList.contains('oculta')) cargarEstado();
}, 60000);
