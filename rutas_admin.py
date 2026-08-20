"""
Rutas del lado del ADMINISTRADOR: todas exigen `sesion_admin`, excepto
el login (que es justamente el que la otorga). Correo y contraseña,
nunca invitación — ese mecanismo es exclusivo del empleado.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, EmailStr, Field, model_validator
from sqlalchemy import text

import tokens
from export_excel import build_workbook
from nucleo import APP_URL, DIAS_VALIDEZ_INVITACION, auditar, engine, ip_de, sesion_admin

router = APIRouter(prefix="/api/admin")


# ==================================================================
# Modelos
# ==================================================================
class LoginAdmin(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=72)
    nombre_equipo: str | None = None
    sistema: str | None = None
    version_app: str | None = None


class EmpleadoNuevo(BaseModel):
    email: EmailStr
    nombre: str = Field(min_length=2, max_length=120)
    departamento: str | None = None
    jefe_email: EmailStr | None = None
    timezone: str = "America/Bogota"
    jornada_horas: float = Field(default=8.0, gt=0, le=24)
    descanso_minutos: int = Field(default=60, ge=0, lt=1440)
    jornada_incluye_descanso: bool = True
    es_admin: bool = False
    # Solo se usa (y se exige) cuando es_admin es True. Los empleados
    # normales siguen entrando sin contraseña, por enlace de invitación.
    password: str | None = Field(default=None, min_length=8, max_length=72)

    @model_validator(mode="after")
    def _password_si_es_admin(self):
        if self.es_admin and not self.password:
            raise ValueError(
                "Los administradores necesitan contraseña (mínimo 8 caracteres).")
        return self


class EmpleadoEdicion(BaseModel):
    nombre: str | None = None
    departamento: str | None = None
    jefe_email: EmailStr | None = None
    jornada_horas: float | None = Field(default=None, gt=0, le=24)
    descanso_minutos: int | None = Field(default=None, ge=0, lt=1440)
    jornada_incluye_descanso: bool | None = None
    activo: bool | None = None


class Correccion(BaseModel):
    empleado_email: EmailStr
    tipo: Literal["entrada", "descanso_inicio", "descanso_fin", "salida"]
    marcado_en: datetime
    nota: str = Field(min_length=3, max_length=500)


# ==================================================================
# Login de administrador — correo y contraseña, sin invitación.
# ==================================================================
@router.post("/login")
def login_admin(req: LoginAdmin, request: Request):
    with engine.begin() as conn:
        emp = conn.execute(
            text("""SELECT id, nombre, email, es_admin, password_hash,
                               jornada_horas, descanso_minutos, jornada_incluye_descanso
                          FROM asistencia.empleados
                         WHERE lower(email) = lower(:e) AND es_admin AND activo"""),
            {"e": req.email},
        ).mappings().first()

        if (not emp or not emp["password_hash"]
                or not tokens.verificar_password(req.password, emp["password_hash"])):
            raise HTTPException(401, "Correo o contraseña incorrectos.")

        token_disp = tokens.nuevo_token()
        conn.execute(
            text("""INSERT INTO asistencia.dispositivos
                            (empleado_id, token_hash, nombre_equipo, sistema, version_app)
                        VALUES (:e, :h, :n, :s, :v)"""),
            {"e": emp["id"], "h": tokens.hash_token(token_disp),
             "n": req.nombre_equipo, "s": req.sistema, "v": req.version_app},
        )
        auditar(conn, emp["email"], "login_admin", {"equipo": req.nombre_equipo},
                ip_de(request))

    return {
        "token": token_disp,
        "nombre": emp["nombre"],
        "email": emp["email"],
        "es_admin": True,
        "jornada_horas": float(emp["jornada_horas"]),
        "descanso_minutos": emp["descanso_minutos"],
        "jornada_incluye_descanso": emp["jornada_incluye_descanso"],
    }


# ==================================================================
# Administración de empleados
# ==================================================================
@router.get("/empleados")
def listar_empleados(datos: dict = Depends(sesion_admin)):
    with engine.begin() as conn:
        filas = conn.execute(
            text("""SELECT e.id, e.email, e.nombre, e.departamento, e.jefe_email,
                               e.jornada_horas, e.descanso_minutos,
                               e.jornada_incluye_descanso, e.es_admin, e.activo,
                               asistencia.fn_trabajo_esperado(
                                   e.jornada_horas, e.descanso_minutos,
                                   e.jornada_incluye_descanso)      AS trabajo_esperado,
                               (SELECT COUNT(*) FROM asistencia.dispositivos d
                                 WHERE d.empleado_id = e.id AND NOT d.revocado) AS dispositivos,
                               (SELECT MAX(i.creada_en) FROM asistencia.invitaciones i
                                 WHERE i.empleado_id = e.id AND i.usada_en IS NULL
                                   AND NOT i.revocada AND i.expira_en > now()) AS invitacion_pendiente
                          FROM asistencia.empleados e
                         ORDER BY e.activo DESC, e.nombre""")
        ).mappings().all()
    return {"empleados": [dict(f) for f in filas]}


@router.post("/empleados")
def crear_empleado(req: EmpleadoNuevo, request: Request,
                   datos: dict = Depends(sesion_admin)):
    """Crea al empleado y genera de una vez su enlace de invitación."""
    with engine.begin() as conn:
        existe = conn.execute(
            text("SELECT 1 FROM asistencia.empleados WHERE lower(email) = lower(:e)"),
            {"e": req.email},
        ).first()
        if existe:
            raise HTTPException(409, "Ya existe un empleado con ese correo.")

        emp_id = conn.execute(
            text("""INSERT INTO asistencia.empleados
                            (email, nombre, departamento, jefe_email, timezone,
                             jornada_horas, descanso_minutos, jornada_incluye_descanso,
                             es_admin, password_hash, creado_por)
                        VALUES (:email, :nombre, :dept, :jefe, :tz,
                                :jornada, :descanso, :incluye, :admin, :password, :creador)
                        RETURNING id"""),
            {"email": req.email.lower(), "nombre": req.nombre,
             "dept": req.departamento, "jefe": req.jefe_email, "tz": req.timezone,
             "jornada": req.jornada_horas, "descanso": req.descanso_minutos,
             "incluye": req.jornada_incluye_descanso, "admin": req.es_admin,
             "password": tokens.hash_password(req.password) if req.es_admin else None,
             "creador": datos["email"]},
        ).scalar_one()

        enlace = _crear_invitacion(conn, emp_id, datos["email"])
        auditar(conn, datos["email"], "crear_empleado",
                {"email": req.email, "jornada": req.jornada_horas,
                 "descanso_min": req.descanso_minutos}, ip_de(request))

    return {"id": emp_id, "email": req.email, "enlace": enlace}


@router.patch("/empleados/{empleado_id}")
def editar_empleado(empleado_id: int, req: EmpleadoEdicion, request: Request,
                    datos: dict = Depends(sesion_admin)):
    """Edita horario y datos. El cambio aplica a los reportes desde ese momento."""
    campos = {k: v for k, v in req.model_dump().items() if v is not None}
    if not campos:
        raise HTTPException(400, "No enviaste ningún cambio.")

    mapa = {
        "nombre": "nombre", "departamento": "departamento", "jefe_email": "jefe_email",
        "jornada_horas": "jornada_horas", "descanso_minutos": "descanso_minutos",
        "jornada_incluye_descanso": "jornada_incluye_descanso", "activo": "activo",
    }
    sets = ", ".join(f"{mapa[k]} = :{k}" for k in campos)

    with engine.begin() as conn:
        fila = conn.execute(
            text(f"""UPDATE asistencia.empleados SET {sets}
                          WHERE id = :id
                      RETURNING email, jornada_horas, descanso_minutos,
                                jornada_incluye_descanso,
                                asistencia.fn_trabajo_esperado(
                                    jornada_horas, descanso_minutos,
                                    jornada_incluye_descanso) AS trabajo_esperado"""),
            {**campos, "id": empleado_id},
        ).mappings().first()

        if not fila:
            raise HTTPException(404, "Empleado no encontrado.")

        auditar(conn, datos["email"], "editar_empleado",
                {"empleado_id": empleado_id, "cambios": campos}, ip_de(request))

    return dict(fila)


# ==================================================================
# Invitaciones
# ==================================================================
def _crear_invitacion(conn, empleado_id: int, creada_por: str) -> str:
    """Genera el enlace. Invalida cualquier invitación pendiente anterior."""
    conn.execute(
        text("""UPDATE asistencia.invitaciones SET revocada = TRUE
                     WHERE empleado_id = :e AND usada_en IS NULL AND NOT revocada"""),
        {"e": empleado_id},
    )
    token = tokens.nuevo_token()
    conn.execute(
        text("""INSERT INTO asistencia.invitaciones
                        (empleado_id, token_hash, creada_por, expira_en)
                    VALUES (:e, :h, :c, now() + make_interval(days => :d))"""),
        {"e": empleado_id, "h": tokens.hash_token(token),
         "c": creada_por, "d": DIAS_VALIDEZ_INVITACION},
    )
    return f"{APP_URL}/invitacion/{token}"


@router.post("/empleados/{empleado_id}/invitacion")
def reenviar_invitacion(empleado_id: int, request: Request,
                        datos: dict = Depends(sesion_admin)):
    """Genera un enlace nuevo. Útil si el anterior expiró o se perdió."""
    with engine.begin() as conn:
        emp = conn.execute(
            text("SELECT email FROM asistencia.empleados WHERE id = :i AND activo"),
            {"i": empleado_id},
        ).first()
        if not emp:
            raise HTTPException(404, "Empleado no encontrado o inactivo.")

        enlace = _crear_invitacion(conn, empleado_id, datos["email"])
        auditar(conn, datos["email"], "generar_invitacion",
                {"empleado_id": empleado_id}, ip_de(request))

    return {"enlace": enlace, "expira_en_dias": DIAS_VALIDEZ_INVITACION}


@router.delete("/dispositivos/{dispositivo_id}")
def revocar_dispositivo(dispositivo_id: int, request: Request,
                        datos: dict = Depends(sesion_admin)):
    """Corta el acceso de un equipo (robo, salida de la empresa)."""
    with engine.begin() as conn:
        fila = conn.execute(
            text("""UPDATE asistencia.dispositivos SET revocado = TRUE
                         WHERE id = :i RETURNING empleado_id"""),
            {"i": dispositivo_id},
        ).first()
        if not fila:
            raise HTTPException(404, "Dispositivo no encontrado.")
        auditar(conn, datos["email"], "revocar_dispositivo",
                {"dispositivo_id": dispositivo_id}, ip_de(request))
    return {"ok": True}


# ==================================================================
# Panel del jefe
# ==================================================================
@router.get("/hoy")
def panel_hoy(datos: dict = Depends(sesion_admin)):
    with engine.begin() as conn:
        pendientes = conn.execute(
            text("""SELECT nombre, email, departamento, entrada, fecha,
                               horas_transcurridas, situacion
                          FROM asistencia.v_pendientes
                         ORDER BY situacion, entrada""")
        ).mappings().all()

        hoy = conn.execute(
            text("""SELECT nombre, email, departamento, primera_entrada,
                               ultima_salida, horas_presencia, horas_descanso,
                               horas_trabajadas, descanso_excedido_min
                          FROM asistencia.v_resumen_diario
                         WHERE fecha = CURRENT_DATE
                         ORDER BY primera_entrada""")
        ).mappings().all()

    return {
        "dentro_ahora": [dict(p) for p in pendientes if p["situacion"] == "en_curso"],
        "sin_salida":   [dict(p) for p in pendientes if p["situacion"] == "sin_salida"],
        "registros_hoy": [dict(h) for h in hoy],
    }


@router.post("/corregir")
def corregir(req: Correccion, request: Request, datos: dict = Depends(sesion_admin)):
    """
    Agrega una marcación manual. No borra ni edita el registro original:
    queda el rastro de quién corrigió y por qué.
    """
    with engine.begin() as conn:
        emp = conn.execute(
            text("SELECT id FROM asistencia.empleados WHERE lower(email) = lower(:e)"),
            {"e": req.empleado_email},
        ).first()
        if not emp:
            raise HTTPException(404, "Empleado no encontrado.")

        conn.execute(
            text("""INSERT INTO asistencia.marcaciones
                            (empleado_id, tipo, marcado_en, origen, ajustado_por, nota, ip)
                        VALUES (:i, :t, :m, 'manual', :por, :nota, :ip)"""),
            {"i": emp[0], "t": req.tipo, "m": req.marcado_en,
             "por": datos["email"], "nota": req.nota, "ip": ip_de(request)},
        )
        auditar(conn, datos["email"], "correccion_manual",
                req.model_dump(), ip_de(request))

    return {"ok": True}


# ==================================================================
# Exportación a Excel
# ==================================================================
@router.get("/export.xlsx")
def exportar(request: Request, inicio: date, fin: date,
             departamento: str | None = None,
             datos: dict = Depends(sesion_admin)):
    if fin < inicio:
        raise HTTPException(400, "La fecha final no puede ser anterior a la inicial.")
    if (fin - inicio).days > 3660:
        raise HTTPException(400, "El rango máximo es de 3660 días (10 años).")

    filtro = "WHERE fecha BETWEEN :i AND :f"
    params: dict = {"i": inicio, "f": fin}
    if departamento:
        filtro += " AND departamento = :d"
        params["d"] = departamento

    with engine.begin() as conn:
        resumen = conn.execute(
            text(f"""SELECT nombre, email, departamento, fecha, primera_entrada,
                                ultima_salida, sesiones, horas_presencia, horas_descanso,
                                horas_trabajadas, descanso_permitido_min,
                                descanso_excedido_min, trabajo_esperado,
                                horas_extra, horas_faltantes
                           FROM asistencia.v_resumen_diario {filtro}
                          ORDER BY departamento, nombre, fecha"""),
            params,
        ).mappings().all()

        sesiones = conn.execute(
            text(f"""SELECT nombre, email, departamento, fecha, entrada, salida,
                                horas_presencia, horas_descanso, horas_trabajadas, descansos
                           FROM asistencia.v_sesiones {filtro}
                          ORDER BY nombre, entrada"""),
            params,
        ).mappings().all()

        auditar(conn, datos["email"], "exportar_excel",
                {"inicio": inicio, "fin": fin, "departamento": departamento,
                 "filas": len(resumen)}, ip_de(request))

    stream = build_workbook(
        [dict(r) for r in resumen], [dict(s) for s in sesiones],
        inicio, fin, datos["email"], departamento or "Toda la organización",
    )
    nombre = f"Asistencia_{inicio:%Y%m%d}-{fin:%Y%m%d}.xlsx"
    return StreamingResponse(
        stream,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{nombre}"'},
    )
