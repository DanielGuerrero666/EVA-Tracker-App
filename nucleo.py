"""
Núcleo compartido entre las rutas de empleado y de administrador:
configuración, conexión a la base de datos, autenticación por token de
dispositivo y la máquina de estados de la marcación.

Nada en este módulo sabe si quien llama es empleado o admin — eso lo
deciden `rutas_empleado.py` y `rutas_admin.py`, que son los que se
importan en `main.py`.
"""
from __future__ import annotations

import ipaddress
import json
import os
from pathlib import Path

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import create_engine, text

import tokens

DATABASE_URL = os.environ["DATABASE_URL"]
APP_URL = os.environ.get("APP_URL", "http://localhost:8000")
DIAS_VALIDEZ_INVITACION = int(os.environ.get("DIAS_VALIDEZ_INVITACION", "7"))
WEB_DIR = Path(__file__).parent

engine = create_engine(DATABASE_URL, pool_pre_ping=True, future=True)


# ==================================================================
# Máquina de estados
# ==================================================================
# Estado actual según la última marcación:
ESTADO_POR_ULTIMA = {
    None:              "fuera",
    "salida":          "fuera",
    "entrada":         "trabajando",
    "descanso_fin":    "trabajando",
    "descanso_inicio": "en_descanso",
}

# Qué acción se permite desde cada estado.
TRANSICIONES: dict[str, dict[str, str]] = {
    "fuera": {
        "entrada": "trabajando",
    },
    "trabajando": {
        "descanso_inicio": "en_descanso",
        "salida": "fuera",
    },
    "en_descanso": {
        "descanso_fin": "trabajando",
        # Marcar salida durante el descanso lo cierra automáticamente.
        "salida": "fuera",
    },
}

MENSAJE_TRANSICION = {
    ("fuera", "descanso_inicio"): "No puedes tomar descanso sin haber registrado entrada.",
    ("fuera", "descanso_fin"):    "No tienes un descanso abierto.",
    ("fuera", "salida"):          "No tienes una jornada abierta.",
    ("trabajando", "entrada"):    "Ya registraste tu entrada.",
    ("trabajando", "descanso_fin"): "No estás en descanso.",
    ("en_descanso", "entrada"):   "Estás en descanso. Termínalo antes de registrar entrada.",
    ("en_descanso", "descanso_inicio"): "Ya estás en descanso.",
}


def estado_de(ultima_tipo: str | None) -> str:
    return ESTADO_POR_ULTIMA.get(ultima_tipo, "fuera")


# ==================================================================
# Utilidades
# ==================================================================
def ip_de(request: Request) -> str | None:
    """Solo devuelve la IP si es válida: la columna es INET y rechazaría el INSERT."""
    bruto = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    if not bruto and request.client:
        bruto = request.client.host
    try:
        return str(ipaddress.ip_address(bruto))
    except ValueError:
        return None


def auditar(conn, actor: str, accion: str, detalle: dict, ip: str | None):
    conn.execute(
        text("""INSERT INTO asistencia.auditoria (actor_email, accion, detalle, ip)
                VALUES (:a, :ac, CAST(:d AS jsonb), :ip)"""),
        {"a": actor, "ac": accion, "d": json.dumps(detalle, default=str), "ip": ip},
    )


# ==================================================================
# Autenticación por token de dispositivo
# ==================================================================
def sesion(x_token: str = Header(...)) -> dict:
    """
    Dependencia de FastAPI: identifica al dueño del token de dispositivo.
    La usan tanto rutas de empleado (marcación) como de administrador
    (que además exigen `es_admin` con `sesion_admin`).
    """
    with engine.begin() as conn:
        fila = conn.execute(
            text("""SELECT d.id AS dispositivo_id, d.empleado_id, d.revocado,
                           e.email, e.nombre, e.es_admin, e.activo,
                           e.timezone, e.jornada_horas, e.descanso_minutos,
                           e.jornada_incluye_descanso, e.password_hash
                      FROM asistencia.dispositivos d
                      JOIN asistencia.empleados e ON e.id = d.empleado_id
                     WHERE d.token_hash = :h"""),
            {"h": tokens.hash_token(x_token)},
        ).mappings().first()

        if not fila or fila["revocado"] or not fila["activo"]:
            raise HTTPException(401, "Dispositivo no autorizado. Pide una nueva invitación.")

        conn.execute(
            text("UPDATE asistencia.dispositivos SET ultimo_uso = now() WHERE id = :d"),
            {"d": fila["dispositivo_id"]},
        )
    return dict(fila)


def sesion_admin(datos: dict = Depends(sesion)) -> dict:
    if not datos.get("es_admin"):
        raise HTTPException(403, "Requiere permisos de administrador.")
    return datos
