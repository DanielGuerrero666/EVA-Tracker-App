"""
Control de Asistencia — API v2
==============================
Sin contraseñas para el empleado. El administrador entra con correo y
contraseña. Este archivo solo arma la aplicación; la lógica está
separada en:

    nucleo.py          Configuración, DB, autenticación, máquina de estados
    rutas_empleado.py  Invitación, activación, marcación (sin contraseña)
    rutas_admin.py     Login, gestión de empleados, reportes (con contraseña)

Desarrollo:
    export DATABASE_URL="postgresql+psycopg2://usuario:clave@localhost/asistencia"
    export APP_URL="https://asistencia.empresa.com"
    uvicorn main:app --reload --port 8000
"""
from __future__ import annotations

from fastapi import FastAPI

import rutas_admin
import rutas_empleado

app = FastAPI(title="Control de Asistencia", version="2.0.0")

app.include_router(rutas_empleado.router)
app.include_router(rutas_admin.router)
