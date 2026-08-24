# EVA Tracker

Un control de horario de escritorio, ligero, construido para **Elite VA Consulting**, hecho con Electron. Esta es la v1: entrada/salida (clock in/out), descansos pagos e historial de turnos. Más funcionalidades (proyectos, reportes, un backend sincronizado) están planeadas a medida que el producto crece.

## Funcionalidades

- **Clock in / Clock out** — un solo botón, con un temporizador `HH:MM:SS` que corre desde el momento en que se marca la entrada.
- **Descansos pagos** — cada turno tiene una asignación de descanso por defecto de 60 minutos. Al terminar un descanso, el tiempo restante queda congelado en lugar de reiniciarse; solo al marcar salida (y empezar un nuevo turno) se reinicia la asignación. El temporizador principal nunca se detiene durante un descanso, ya que ese tiempo es pago.
- **Historial de turnos** — cuando un turno termina (clock out), se agrega al historial como una sola tarjeta: fecha, duración total y el rango de horas de entrada-salida. Los turnos en curso no aparecen hasta que se cierran, y los descansos quedan intencionalmente fuera de esta vista.
- **Corre en segundo plano** — cerrar la ventana minimiza EVA Tracker a la bandeja del sistema (system tray) en lugar de cerrarlo. Sigue registrando el tiempo hasta que se elige "Quit" desde el menú de la bandeja. El tooltip de la bandeja muestra en vivo el estado (Clocked In / Clocked Out).
- **Inicio de sesión simple** — una pantalla de nombre + correo identifica a quién está registrando su tiempo (sin contraseña por ahora, ya que no hay backend contra el cual autenticar). Este es el punto de extensión para un futuro sistema de cuentas.

## Capturas de pantalla

| Login | Registrando tiempo | En descanso |
|---|---|---|
| Nombre + correo, sin contraseña | Temporizador grande, día/fecha, historial de turnos | Cuenta regresiva del descanso, congelada hasta el clock out |

*(Agregar capturas de pantalla aquí una vez que la interfaz esté definitiva.)*

## Cómo está construido

```mermaid
flowchart TB
    subgraph Renderer["Renderer (login.html / tracker.html)"]
        UI["UI: tracker.js / login.js"]
    end

    subgraph Preload["preload.js (contextBridge)"]
        API["API window.eva.*"]
    end

    subgraph Main["Proceso principal (main.js)"]
        IPC["Manejadores ipcMain"]
        Tray["Ícono y menú de bandeja"]
        Win["BrowserWindow"]
    end

    Store["DataStore (lib/dataStore.js)"]
    JSON[("eva-tracker-data.json<br/>(carpeta userData de la app)")]

    UI -->|"window.eva.clockIn() etc."| API
    API -->|ipcRenderer.invoke| IPC
    IPC --> Store
    Store <--> JSON
    IPC -.->|actualiza tooltip| Tray
    Win -->|"close" oculta a la bandeja| Tray
    Tray -->|Abrir| Win
```

No hay ningún servicio corriendo por separado en segundo plano — cuando la app se minimiza a la bandeja, el proceso de Electron simplemente sigue ahí, sin ventana visible, hasta que se elige Quit. El "temporizador" que se ve tampoco es un contador que corre en memoria todo el tiempo: es pura aritmética de reloj (`Date.now() - marcaDeTiempoDelClockIn`) calculada de nuevo cada vez que la interfaz se actualiza, así que cerrar y volver a abrir la app (o incluso poner la máquina a dormir) no pierde ni pausa el tiempo transcurrido — solo un clock out explícito lo hace.

Los métodos de `DataStore` (`getStatus`, `clockIn`, `clockOut`, `startBreak`, `endBreak`, `getShifts`, ...) son el punto de extensión pensado para reemplazar el almacenamiento local en JSON por un cliente HTTP contra un backend real más adelante — `main.js` y el renderer no deberían necesitar cambios cuando eso pase.

## Estados de clock y descanso

```mermaid
stateDiagram-v2
    [*] --> ClockedOut
    ClockedOut --> ClockedIn: clockIn()
    ClockedIn --> ClockedOut: clockOut() - se agrega el turno al historial
    ClockedIn --> OnBreak: startBreak()
    OnBreak --> ClockedIn: endBreak() - tiempo restante queda congelado
    OnBreak --> ClockedOut: clockOut() - el descanso se cierra automáticamente primero

    note right of OnBreak
        El temporizador principal sigue
        corriendo — los descansos son pagos.
    end note
```

## Estructura del proyecto

```
main.js                    Proceso principal de Electron: ventana, bandeja, manejadores IPC
preload.js                 contextBridge — expone window.eva.* al renderer
lib/
  dataStore.js             Almacenamiento local en JSON + lógica de negocio
src/
  login.html, login.js     Pantalla de nombre + correo
  tracker.html, tracker.js Temporizador, control de descansos, historial de turnos
  styles.css               Tema blanco / negro / #9d7026, tipografía Poppins
  assets/
    icon-mark.svg          Ícono fuente usado para generar los íconos de la app y la bandeja
    logo.svg               Logo completo (usado en la pantalla de login)
    tray-icon.png          Ícono de bandeja generado (32px, a partir de icon-mark.svg)
build/
  icon.ico                 Ícono de Windows generado (16/32/48/256px, a partir de icon-mark.svg)
```

Los datos viven fuera del repositorio, en la carpeta de datos de usuario propia de cada sistema operativo (en Windows: `%APPDATA%\eva-tracker\eva-tracker-data.json`) — un archivo JSON con el usuario actual y un registro plano de entradas `in` / `out` / `break_start` / `break_end`.

## Cómo empezar

```bash
npm install
npm start
```

Requiere Node.js y npm. Electron es una dependencia de desarrollo y se instala junto con todo lo demás.

## Generar el instalador

```bash
npm run dist
```

Genera un instalador de Windows en `dist/EVA Tracker Setup <versión>.exe` (electron-builder + NSIS). El build no está firmado (no hay certificado de firma de código configurado), así que Windows SmartScreen puede mostrar una advertencia la primera vez que se ejecute — eso es esperado para un build interno/sin firmar.

> **Detalle específico de Windows:** el paso de empaquetado NSIS de electron-builder necesita extraer un archivo auxiliar que contiene symlinks, lo cual requiere tener el **Modo de desarrollador** activado (Configuración → Privacidad y seguridad → Para desarrolladores) o ejecutar el build desde una terminal **elevada (Administrador)**. Es un ajuste de entorno de una sola vez, no un error del proyecto.

`dist/` está en `.gitignore` — el instalador es un artefacto de build, no algo que se deba subir al repositorio. Se puede regenerar en cualquier momento con el comando de arriba.

## Regenerar los íconos de la app y la bandeja

`build/icon.ico` y `src/assets/tray-icon.png` se generan a partir de `src/assets/icon-mark.svg`. A propósito no hay un script de build para esto en el repositorio — es una conversión puntual, que se vuelve a hacer a mano (o pidiéndole ayuda a quien esté colaborando en el código) cada vez que el ícono fuente cambie.

## Roadmap

Esta es intencionalmente una v1 delgada. Próximos pasos conocidos, todavía no construidos:
- Un backend real (con Postgres) para reemplazar el almacenamiento local en JSON y agregar cuentas de múltiples usuarios con autenticación.
- Proyectos/etiquetas por cada registro de tiempo.
- Reportes y exportación a CSV.
- Detección de inactividad o niveles de actividad, si esto necesita competir con herramientas como Hubstaff/Insightful en ese aspecto.
