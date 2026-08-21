"""
Rutas del lado del EMPLEADO: todo lo que no requiere contraseña.

Cubre la página pública de invitación, la descarga del instalador, y el
canje de invitación / marcación de la app de escritorio. Nada aquí
verifica `es_admin` — para eso está `rutas_admin.py`.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import text

import tokens
from nucleo import (
    MENSAJE_TRANSICION,
    TRANSICIONES,
    WEB_DIR,
    auditar,
    engine,
    estado_de,
    ip_de,
    sesion,
)

router = APIRouter()


# ==================================================================
# Modelos
# ==================================================================
class Activacion(BaseModel):
    token: str
    nombre_equipo: str | None = None
    sistema: str | None = None
    version_app: str | None = None


class Marcacion(BaseModel):
    tipo: Literal["entrada", "descanso_inicio", "descanso_fin", "salida"]


# ==================================================================
# Páginas públicas (invitación, logo, instalador)
# ==================================================================
@router.get("/healthz")
def healthz():
    return {"status": "ok"}


@router.get("/invitacion/{token}")
def pagina_invitacion(token: str):
    """Página que abre el empleado al recibir el enlace."""
    return FileResponse(WEB_DIR / "invitacion.html")


@router.get("/logo.svg")
def logo():
    return FileResponse(WEB_DIR / "logo.svg", media_type="image/svg+xml")


@router.get("/logo-icono.svg")
def logo_icono():
    return FileResponse(WEB_DIR / "logo-icono.svg", media_type="image/svg+xml")


@router.get("/descargas/instalador.exe")
def descargar_instalador():
    """Instalador de Windows para equipos que aún no tienen la app."""
    ruta = WEB_DIR / "dist" / "Control de Asistencia Setup 1.0.0.exe"
    if not ruta.exists():
        raise HTTPException(404, "El instalador aún no está publicado.")
    return FileResponse(ruta, media_type="application/octet-stream",
                        filename="ControlDeAsistencia-Setup.exe")


@router.get("/api/invitacion/{token}")
def revisar_invitacion(token: str):
    """La página consulta si el enlace sigue siendo válido, sin canjearlo."""
    with engine.begin() as conn:
        inv = conn.execute(
            text("""SELECT i.usada_en, i.revocada, i.expira_en, e.nombre, e.email
                      FROM asistencia.invitaciones i
                      JOIN asistencia.empleados e ON e.id = i.empleado_id
                     WHERE i.token_hash = :h"""),
            {"h": tokens.hash_token(token)},
        ).mappings().first()

    if not inv:
        raise HTTPException(404, "Este enlace no es válido.")
    if inv["revocada"]:
        raise HTTPException(410, "Este enlace fue revocado por el administrador.")
    if inv["usada_en"]:
        raise HTTPException(410, "Este enlace ya fue usado.")
    if inv["expira_en"] < datetime.now(timezone.utc):
        raise HTTPException(410, "Este enlace expiró. Pide uno nuevo al administrador.")

    return {"nombre": inv["nombre"], "email": inv["email"], "expira_en": inv["expira_en"]}


# ==================================================================
# Activación: la app de escritorio canjea la invitación
# ==================================================================
@router.post("/api/activar")
def activar(req: Activacion, request: Request):
    """
    Canjea la invitación por un token de dispositivo permanente.
    La invitación queda consumida: un solo uso.
    """
    hash_inv = tokens.hash_token(req.token)

    with engine.begin() as conn:
        # FOR UPDATE evita que dos equipos canjeen la misma invitación a la vez.
        inv = conn.execute(
            text("""SELECT i.id, i.empleado_id, i.usada_en, i.revocada, i.expira_en
                      FROM asistencia.invitaciones i
                     WHERE i.token_hash = :h
                       FOR UPDATE"""),
            {"h": hash_inv},
        ).mappings().first()

        if not inv:
            raise HTTPException(404, "Este enlace no es válido.")
        if inv["revocada"]:
            raise HTTPException(410, "Este enlace fue revocado.")
        if inv["usada_en"]:
            raise HTTPException(410, "Este enlace ya fue usado.")
        if inv["expira_en"] < datetime.now(timezone.utc):
            raise HTTPException(410, "Este enlace expiró.")

        token_disp = tokens.nuevo_token()
        conn.execute(
            text("""INSERT INTO asistencia.dispositivos
                        (empleado_id, token_hash, nombre_equipo, sistema, version_app)
                    VALUES (:e, :h, :n, :s, :v)"""),
            {"e": inv["empleado_id"], "h": tokens.hash_token(token_disp),
             "n": req.nombre_equipo, "s": req.sistema, "v": req.version_app},
        )
        conn.execute(
            text("UPDATE asistencia.invitaciones SET usada_en = now() WHERE id = :i"),
            {"i": inv["id"]},
        )

        emp = conn.execute(
            text("""SELECT nombre, email, es_admin, jornada_horas,
                           descanso_minutos, jornada_incluye_descanso
                      FROM asistencia.empleados WHERE id = :i"""),
            {"i": inv["empleado_id"]},
        ).mappings().first()

        auditar(conn, emp["email"], "activar_dispositivo",
                {"equipo": req.nombre_equipo}, ip_de(request))

    return {
        "token": token_disp,
        "nombre": emp["nombre"],
        "email": emp["email"],
        "es_admin": emp["es_admin"],
        "jornada_horas": float(emp["jornada_horas"]),
        "descanso_minutos": emp["descanso_minutos"],
        "jornada_incluye_descanso": emp["jornada_incluye_descanso"],
    }


# ==================================================================
# Marcación
# ==================================================================
@router.get("/api/estado")
def estado(datos: dict = Depends(sesion)):
    """Estado actual del empleado, más su historial reciente."""
    with engine.begin() as conn:
        ultima = conn.execute(
            text("""SELECT tipo, marcado_en FROM asistencia.marcaciones
                     WHERE empleado_id = :i AND anulada = FALSE
                     ORDER BY marcado_en DESC LIMIT 1"""),
            {"i": datos["empleado_id"]},
        ).mappings().first()

        # Marcaciones de hoy, para el detalle en pantalla
        hoy = conn.execute(
            text("""SELECT tipo, marcado_en AT TIME ZONE :tz AS marcado_en
                      FROM asistencia.marcaciones
                     WHERE empleado_id = :i AND anulada = FALSE
                       AND (marcado_en AT TIME ZONE :tz)::date
                           = (now() AT TIME ZONE :tz)::date
                     ORDER BY marcado_en"""),
            {"i": datos["empleado_id"], "tz": datos["timezone"]},
        ).mappings().all()

        historial = conn.execute(
            text("""SELECT fecha, primera_entrada, ultima_salida, sesiones,
                           horas_presencia, horas_descanso, horas_trabajadas,
                           descanso_excedido_min, horas_extra, horas_faltantes
                      FROM asistencia.v_resumen_diario
                     WHERE email = :e AND fecha >= :d
                     ORDER BY fecha DESC"""),
            {"e": datos["email"], "d": date.today() - timedelta(days=14)},
        ).mappings().all()

    actual = estado_de(ultima["tipo"] if ultima else None)

    # Tiempo trabajado/en descanso HOY, incluyendo la sesión en curso (sin
    # salida todavía). v_resumen_diario (usada en `historial`) solo cuenta
    # sesiones ya cerradas, así que mientras la jornada sigue abierta el día
    # de hoy no aparece ahí — este cálculo es lo que alimenta el cronómetro
    # en vivo del panel del empleado.
    segundos_trabajados_hoy = 0.0
    segundos_descanso_hoy = 0.0
    trabajando_desde = None
    descanso_desde = None
    for m in hoy:
        tipo, ts = m["tipo"], m["marcado_en"]
        if tipo == "entrada":
            trabajando_desde = ts
        elif tipo == "descanso_inicio":
            if trabajando_desde is not None:
                segundos_trabajados_hoy += (ts - trabajando_desde).total_seconds()
                trabajando_desde = None
            descanso_desde = ts
        elif tipo == "descanso_fin":
            if descanso_desde is not None:
                segundos_descanso_hoy += (ts - descanso_desde).total_seconds()
                descanso_desde = None
            trabajando_desde = ts
        elif tipo == "salida":
            if trabajando_desde is not None:
                segundos_trabajados_hoy += (ts - trabajando_desde).total_seconds()
                trabajando_desde = None
            if descanso_desde is not None:
                segundos_descanso_hoy += (ts - descanso_desde).total_seconds()
                descanso_desde = None

    if trabajando_desde is not None or descanso_desde is not None:
        ahora_local = datetime.now(ZoneInfo(datos["timezone"])).replace(tzinfo=None)
        if trabajando_desde is not None:
            segundos_trabajados_hoy += max((ahora_local - trabajando_desde).total_seconds(), 0)
        if descanso_desde is not None:
            segundos_descanso_hoy += max((ahora_local - descanso_desde).total_seconds(), 0)

    return {
        "estado": actual,
        "acciones_validas": list(TRANSICIONES[actual].keys()),
        "desde": ultima["marcado_en"] if ultima else None,
        "marcaciones_hoy": [dict(m) for m in hoy],
        "historial": [dict(h) for h in historial],
        "segundos_trabajados_hoy": round(segundos_trabajados_hoy),
        "segundos_descanso_hoy": round(segundos_descanso_hoy),
        "config": {
            "jornada_horas": float(datos["jornada_horas"]),
            "descanso_minutos": datos["descanso_minutos"],
            "jornada_incluye_descanso": datos["jornada_incluye_descanso"],
        },
    }


@router.post("/api/marcar")
def marcar(req: Marcacion, request: Request, datos: dict = Depends(sesion)):
    with engine.begin() as conn:
        ultima = conn.execute(
            text("""SELECT tipo FROM asistencia.marcaciones
                     WHERE empleado_id = :i AND anulada = FALSE
                     ORDER BY marcado_en DESC LIMIT 1
                       FOR UPDATE"""),
            {"i": datos["empleado_id"]},
        ).first()

        actual = estado_de(ultima[0] if ultima else None)

        if req.tipo not in TRANSICIONES[actual]:
            mensaje = MENSAJE_TRANSICION.get(
                (actual, req.tipo), "Esa acción no es válida en este momento.")
            raise HTTPException(409, mensaje)

        # Marcar salida durante el descanso: se cierra el descanso primero,
        # para que el tiempo quede correctamente contabilizado.
        if actual == "en_descanso" and req.tipo == "salida":
            conn.execute(
                text("""INSERT INTO asistencia.marcaciones
                            (empleado_id, dispositivo_id, tipo, origen, nota, ip)
                        VALUES (:i, :d, 'descanso_fin', 'auto',
                                'Cerrado automáticamente al marcar salida', :ip)"""),
                {"i": datos["empleado_id"], "d": datos["dispositivo_id"],
                 "ip": ip_de(request)},
            )

        try:
            fila = conn.execute(
                text("""INSERT INTO asistencia.marcaciones
                            (empleado_id, dispositivo_id, tipo, origen, ip)
                        VALUES (:i, :d, :t, 'app', :ip)
                        RETURNING marcado_en"""),
                {"i": datos["empleado_id"], "d": datos["dispositivo_id"],
                 "t": req.tipo, "ip": ip_de(request)},
            ).first()
        except Exception as exc:
            if "duplicado_reciente" in str(exc):
                raise HTTPException(409, "Ya registraste esa marcación hace unos segundos.")
            raise

    return {
        "tipo": req.tipo,
        "marcado_en": fila[0],
        "estado": TRANSICIONES[actual][req.tipo],
    }
