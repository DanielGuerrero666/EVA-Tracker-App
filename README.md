# Control de Asistencia

Aplicación de escritorio (Electron) para que los empleados marquen **Entrada
/ Descanso / Salida**, con un backend en FastAPI + PostgreSQL y un panel de
administración con reportes en Excel.

Marca: [Elite VA Consulting](https://elitevaconsulting.com) — paleta dorado
`#A36F06` / negro / blanco, tipografía Poppins.

```
┌──────────────────────┐         ┌──────────────┐        ┌──────────────┐
│  App Electron        │  HTTPS  │  API FastAPI │        │  PostgreSQL  │
│  Entrada/Descanso/    │───────►│              │───────►│              │
│  Salida + panel admin │ X-Token │              │        │              │
└──────────────────────┘         └──────┬───────┘        └──────┬───────┘
         ▲                              │                       │
         │ asistencia://activar         │ export.xlsx           │ Excel en vivo
    enlace de invitación                ▼                       ▼ (ODBC, ver abajo)
                                  Excel descargable     Excel del jefe
```

---

## 1. Funcionalidades

### Lado del empleado (sin contraseña)

- **Alta sin contraseña.** El administrador crea al empleado desde el panel
  y se genera un enlace de invitación de un solo uso (expira en 7 días por
  defecto). El empleado lo abre, la app de escritorio lo canjea, y queda
  activada **para siempre** en ese equipo — nunca vuelve a pedir el enlace.
- **Tres botones con máquina de estados en el servidor:** Entrada,
  Descanso (alterna a "Terminar"), Salida. El servidor rechaza transiciones
  inválidas (no puedes marcar salida sin entrada, etc.), así que un cliente
  modificado no puede ensuciar los datos.
- **Cierre automático de descanso** si alguien marca salida mientras estaba
  en descanso, para que el tiempo quede bien contabilizado.
- **Jornada configurable por persona** (horas totales, minutos de descanso,
  si el descanso ya está incluido en la jornada o no). Extras y faltantes
  se calculan siempre sobre el trabajo efectivo.
- **Token de dispositivo cifrado** con el llavero del sistema operativo
  (Credential Manager / Keychain / libsecret) — el proceso de interfaz
  (renderer) nunca tiene acceso a él; todas las llamadas HTTP salen del
  proceso principal de Electron.

### Lado del administrador (correo y contraseña)

- **Login independiente**, sin invitación: correo + contraseña
  (`bcrypt`), directo al panel — nunca se guarda en disco, así que hay que
  volver a iniciar sesión cada vez que se cierra la app (a diferencia del
  empleado, que queda activado permanentemente).
- **Gestión de empleados:** crear, editar horario, generar/reenviar enlace
  de invitación, revocar el acceso de un equipo.
- **Alertas del día:** quién está dentro ahora mismo, quién excedió el
  descanso, y jornadas **sin cerrar** (`v_pendientes`) que no producen
  horas hasta que un admin las corrija manualmente.
- **Corrección manual de marcaciones** — nunca se edita ni se borra el
  registro original, solo se agrega uno nuevo marcado como `manual` con
  autor y nota (rastro auditable ante un reclamo laboral).
- **Exportar a Excel** con rango de fechas, o con un botón de un clic
  ("Ver Excel completo") que trae todo el historial.
- **Excel en vivo (opcional):** el rol de solo lectura `bi_lector` (ver
  `schema.sql`) permite conectar Excel directo a las vistas de PostgreSQL
  por ODBC y activar "Actualizar cada 5 minutos" nativo de Excel — sin
  necesidad de descargar archivos ni depender de la app.
- **Auditoría** de cada acción administrativa (`asistencia.auditoria`).

### Distribución

- **Instalador de Windows** (`electron-builder` + NSIS) que crea
  automáticamente el acceso directo en el escritorio.
- **Descarga desde la propia app:** `/descargas/instalador.exe` en el
  backend, enlazado desde la página de invitación — el empleado nunca
  necesita que alguien le pase el `.exe` por otro medio.
- **Detección explícita de instalación:** la página de invitación pregunta
  "¿ya tienes la app instalada?" en vez de intentar abrir el protocolo a
  ciegas (evita el error confuso del navegador cuando no está instalada).
- **Un solo servidor para todos**, fijo en `config.js` — el usuario final
  nunca escribe una URL. Cambiar de servidor (por ejemplo al mudar a un
  VPS) es editar una línea y recompilar. Ver `DESPLIEGUE.md`.

---

## 2. Estructura del código

El código está separado por audiencia — empleado vs. administrador — tanto
en el backend como en el frontend, para que sea fácil ubicar y modificar
cada parte sin tocar la otra.

```
EVA-tracker/
├── schema.sql              Tablas, vistas, función de trabajo esperado
│
├── nucleo.py                Config, conexión a BD, autenticación, máquina de estados
├── rutas_empleado.py         Invitación, activación, marcación — SIN contraseña
├── rutas_admin.py            Login, empleados, reportes — CON contraseña
├── main.py                   Arma la app FastAPI e incluye los dos routers
├── tokens.py                  Tokens de invitación/dispositivo y hash de contraseñas
├── export_excel.py            Generador del libro de Excel
├── requirements.txt            Dependencias del backend
├── invitacion.html             Página que abre el empleado al recibir el enlace
│
├── main.js                     Proceso principal de Electron: protocolo, llavero, bandeja
├── preload.js                  contextBridge (el renderer nunca toca Node)
├── config.js                    Un solo lugar para la URL del servidor
├── package.json                 electron-builder (incluye acceso directo de escritorio)
└── renderer/
    ├── index.html               Tres pantallas: activación, marcación, admin
    ├── estilos.css
    ├── comun.js                  Utilidades y navegación compartidas
    ├── empleado.js                Activación y marcación — SIN contraseña
    ├── admin.js                   Login, panel, reportes — CON contraseña (y arranca la app)
    ├── logo.svg / logo-icono.svg   Marca Elite VA Consulting
    └── icono.png / icono.ico       Ícono de la app (ventana, bandeja, instalador)
```

`renderer/index.html` carga los scripts en orden: `comun.js` primero
(define utilidades y `iniciar()`), luego `empleado.js` (define
`cargarEstado()`), y `admin.js` al final — que es quien realmente llama a
`iniciar()`, porque para entonces ya existe todo lo que necesita.

---

## 3. Cómo funciona el acceso sin contraseña (empleado)

1. El administrador crea al empleado desde el panel (nombre, correo,
   jornada, descanso).
2. El sistema genera un enlace: `https://<servidor>/invitacion/<token>`.
3. El admin se lo envía por correo o chat.
4. El empleado lo abre. La página confirma si quiere abrir la app
   (`asistencia://`) o descargarla primero si no la tiene.
5. La app canjea el token por uno permanente y queda activada. **No hay
   contraseña que crear ni recordar, y nunca vuelve a usar el enlace.**

El token permanente se guarda cifrado con el llavero del sistema operativo.

### Seguridad de las invitaciones

- Un solo uso: al canjearse queda consumida. Un segundo intento devuelve
  error `410 Gone`.
- Expiran a los 7 días (`DIAS_VALIDEZ_INVITACION`).
- En la base se guarda solo el SHA-256 del token, nunca el valor en claro.
- Generar un enlace nuevo anula automáticamente el anterior.
- El admin puede revocar un equipo (robo, salida de la empresa) y el
  acceso muere en la siguiente llamada.

## 4. Cómo funciona el login del administrador

- Correo + contraseña (`bcrypt`), verificado en `POST /api/admin/login`.
- Si es correcto, se genera un token de dispositivo igual que el de un
  empleado — pero la app **nunca lo escribe a disco**: vive solo en
  memoria del proceso de Electron mientras está abierto.
- Al cerrar la app (o hacer click en "Cerrar sesión" dentro del panel),
  la sesión desaparece. La próxima vez hay que volver a escribir correo y
  contraseña — a propósito, porque el panel expone datos de toda la
  organización.
- Un admin nuevo se crea marcando "Dar permisos de administrador" al
  agregar un empleado desde el panel (exige contraseña de mínimo 8
  caracteres en ese momento).

---

## 5. Jornada y descanso

Cada empleado tiene su propia configuración, editable en el panel:

| Campo | Por defecto | Qué significa |
|---|---|---|
| `jornada_horas` | 8.00 | Jornada total esperada |
| `descanso_minutos` | 60 | Descanso permitido |
| `jornada_incluye_descanso` | activado | Si la jornada ya contiene el descanso |

Con los valores por defecto: **8 h de presencia, de las cuales 1 h es
descanso → 7 h de trabajo efectivo.**

Si desactivas la casilla, el mismo empleado pasa a 8 h de trabajo efectivo
y 9 h de presencia. El panel muestra el resultado en texto mientras
editas, para que no quede ambiguo.

> **Cuidado con los cambios retroactivos.** Los reportes leen la
> configuración *actual* del empleado. Si cambias la jornada de alguien,
> los días ya registrados se recalculan con el valor nuevo. Exporta y
> archiva el reporte del periodo antes de tocar horarios.

---

## 6. El Excel

Cuatro hojas: **Resumen** (totales por empleado con fórmulas vivas),
**Detalle** (por empleado y día), **Sesiones** (cada jornada individual) y
**Notas** (metodología).

Columnas clave: presencia, descanso, trabajadas, trabajo esperado, exceso
de descanso en minutos (resaltado en rojo), extras y faltantes.

**Alternativa en vivo, sin descargar archivos:** conecta el Excel del jefe
a la vista `asistencia.v_resumen_diario` por
**Datos → Obtener datos → Desde ODBC**, con el rol `bi_lector` (creado
manualmente, ver el bloque comentado al final de `schema.sql`). Luego,
click derecho en la conexión → Propiedades → **"Actualizar cada 5
minutos"**. Es una función nativa de Excel, no requiere código adicional.

---

## 7. Lo que hay que vigilar: jornadas sin cerrar

Si alguien marca entrada y nunca marca salida, esa jornada **no produce
horas**. La vista `v_pendientes` las detecta y separa:

- `en_curso` → está trabajando o en descanso ahora mismo. Normal.
- `sin_salida` → olvidó marcar y ya hay marcaciones posteriores.
  **Requiere corrección.**

El panel lo muestra en rojo. Revísalo antes de exportar el cierre de cada
periodo.

Para corregir se agrega una marcación manual; no se edita ni borra la
original:

```bash
curl -X POST https://<servidor>/api/admin/corregir \
  -H "X-Token: <token del admin>" -H "Content-Type: application/json" \
  -d '{"empleado_email":"luis@empresa.com","tipo":"salida",
       "marcado_en":"2026-08-10T17:30:00-05:00",
       "nota":"Olvidó marcar salida, confirmado por teléfono"}'
```

---

## 8. Decisiones de diseño

**Las marcaciones no se editan ni se borran.** Las correcciones son
registros nuevos marcados como `manual`, con autor y nota.

**La máquina de estados vive en el servidor, no en la interfaz.** La app
deshabilita botones por comodidad, pero es el servidor el que rechaza las
transiciones inválidas.

**El renderer de Electron no toca Node ni ve el token.**
`contextIsolation` activo, `nodeIntegration` desactivado, `sandbox`
activo, y todas las llamadas HTTP salen del proceso principal a través de
un `contextBridge` acotado.

**Una sesión = una `entrada` y todo lo que sigue hasta la próxima.**
Descansos y salida se agrupan por sesión con una función de ventana.

**Admin y empleado son mecanismos de acceso distintos a propósito.** El
empleado no necesita saber qué es una contraseña; el administrador no
debería quedar con sesión abierta indefinidamente en un equipo compartido.

---

## 9. Arranque rápido en local

```bash
# Base de datos
createdb asistencia
psql asistencia -f schema.sql

# Backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt      # Windows
# .venv/bin/pip install -r requirements.txt          # Linux/Mac

set DATABASE_URL=postgresql+psycopg2://usuario:clave@localhost:5432/asistencia
set APP_URL=http://localhost:8000
.venv\Scripts\python -m uvicorn main:app --host 0.0.0.0 --port 8000

# Primer administrador (una sola vez, a mano)
python - <<'PY'
import os, tokens
from sqlalchemy import create_engine, text
eng = create_engine(os.environ["DATABASE_URL"])
with eng.begin() as c:
    c.execute(text("""
        INSERT INTO asistencia.empleados (email, nombre, es_admin, password_hash, creado_por)
        VALUES ('jefe@empresa.com', 'María Jefe', TRUE, :p, 'bootstrap')
    """), dict(p=tokens.hash_password("CAMBIA-ESTA-CLAVE")))
PY

# App de escritorio
npm install
npm start          # desarrollo
npm run dist:win   # genera el instalador .exe (Windows)
```

Para llevar esto a un VPS o una máquina virtual en la nube, con dominio,
HTTPS y el backend corriendo como servicio permanente, ver
**[DESPLIEGUE.md](DESPLIEGUE.md)**.

---

## 10. Pendientes conocidos

- [ ] HTTPS con certificado válido (cubierto en `DESPLIEGUE.md` si se usa
      un dominio propio)
- [ ] Firma de código del instalador (sin firma, SmartScreen y el
      navegador muestran una advertencia al descargar/instalar — hay que
      aceptarla manualmente)
- [ ] Backup diario de PostgreSQL con prueba de restauración
- [ ] Recordatorio automático a quien tenga jornada abierta al final del día
- [ ] Definir con RRHH el manejo de festivos, vacaciones e incapacidades
- [ ] Actualizaciones automáticas (`electron-updater`) para no reinstalar a mano
- [x] Ruta `/descargas/instalador.exe` con el instalador de Windows
