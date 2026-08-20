-- ============================================================
-- Control de Asistencia — Esquema PostgreSQL 14+  (v2)
-- Alcance: entrada / descanso / salida.
-- Acceso por invitación (sin contraseñas).
-- ============================================================

CREATE SCHEMA IF NOT EXISTS asistencia;
SET search_path TO asistencia, public;

-- ------------------------------------------------------------
-- Empleados. El administrador los crea; el empleado nunca se registra solo.
-- ------------------------------------------------------------
CREATE TABLE empleados (
    id             BIGSERIAL PRIMARY KEY,
    email          TEXT         NOT NULL UNIQUE,
    nombre         TEXT         NOT NULL,
    departamento   TEXT,
    jefe_email     TEXT,
    timezone       TEXT         NOT NULL DEFAULT 'America/Bogota',

    -- ---- Horario, editable por el administrador para cada persona ----
    -- Jornada total esperada. Por defecto 8 h.
    jornada_horas       NUMERIC(4,2) NOT NULL DEFAULT 8.00
                        CHECK (jornada_horas > 0 AND jornada_horas <= 24),
    -- Descanso permitido. Por defecto 60 min.
    descanso_minutos    INTEGER      NOT NULL DEFAULT 60
                        CHECK (descanso_minutos >= 0 AND descanso_minutos < 1440),
    -- TRUE  → la jornada de 8 h YA incluye el descanso  (trabajo efectivo = 7 h)
    -- FALSE → 8 h de trabajo efectivo + 1 h de descanso (presencia = 9 h)
    jornada_incluye_descanso BOOLEAN NOT NULL DEFAULT TRUE,

    es_admin       BOOLEAN      NOT NULL DEFAULT FALSE,
    -- Solo los administradores tienen contraseña: protege la entrada al
    -- panel de administración. Los empleados nunca la usan (acceso por enlace).
    password_hash  TEXT,
    activo         BOOLEAN      NOT NULL DEFAULT TRUE,
    creado_por     TEXT,
    creado_en      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX ix_empleados_jefe ON empleados (jefe_email);
CREATE INDEX ix_empleados_dept ON empleados (departamento);

-- Trabajo efectivo esperado por día, según la configuración de cada quien.
CREATE OR REPLACE FUNCTION fn_trabajo_esperado(
    p_jornada NUMERIC, p_descanso INTEGER, p_incluye BOOLEAN
) RETURNS NUMERIC AS $$
    SELECT ROUND(
        CASE WHEN p_incluye
             THEN GREATEST(p_jornada - p_descanso / 60.0, 0)
             ELSE p_jornada
        END, 2);
$$ LANGUAGE sql IMMUTABLE;

-- ------------------------------------------------------------
-- Invitaciones. El administrador genera un enlace de un solo uso.
-- Se guarda el HASH del token, nunca el token en claro.
-- ------------------------------------------------------------
CREATE TABLE invitaciones (
    id            BIGSERIAL PRIMARY KEY,
    empleado_id   BIGINT      NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
    token_hash    TEXT        NOT NULL UNIQUE,
    creada_por    TEXT        NOT NULL,
    creada_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
    expira_en     TIMESTAMPTZ NOT NULL,
    usada_en      TIMESTAMPTZ,
    revocada      BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX ix_invit_empleado ON invitaciones (empleado_id);

-- ------------------------------------------------------------
-- Dispositivos activados. Un empleado puede tener varios equipos.
-- El token vive cifrado en el equipo (Electron safeStorage).
-- ------------------------------------------------------------
CREATE TABLE dispositivos (
    id             BIGSERIAL PRIMARY KEY,
    empleado_id    BIGINT      NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
    token_hash     TEXT        NOT NULL UNIQUE,
    nombre_equipo  TEXT,
    sistema        TEXT,
    version_app    TEXT,
    activado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
    ultimo_uso     TIMESTAMPTZ,
    revocado       BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX ix_disp_empleado ON dispositivos (empleado_id);

-- ------------------------------------------------------------
-- Marcaciones. Bitácora de eventos: no se edita ni se borra.
-- ------------------------------------------------------------
CREATE TABLE marcaciones (
    id            BIGSERIAL PRIMARY KEY,
    empleado_id   BIGINT      NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
    dispositivo_id BIGINT     REFERENCES dispositivos(id) ON DELETE SET NULL,
    tipo          TEXT        NOT NULL
                  CHECK (tipo IN ('entrada','descanso_inicio','descanso_fin','salida')),
    marcado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
    origen        TEXT        NOT NULL DEFAULT 'app'
                  CHECK (origen IN ('app','manual','auto')),
    ajustado_por  TEXT,
    nota          TEXT,
    ip            INET,
    anulada       BOOLEAN     NOT NULL DEFAULT FALSE,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_marc_emp_fecha ON marcaciones (empleado_id, marcado_en);

-- Evita el doble clic accidental (misma persona, mismo tipo, < 30 s).
CREATE OR REPLACE FUNCTION fn_evitar_duplicados() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.origen = 'app' AND EXISTS (
        SELECT 1 FROM asistencia.marcaciones
         WHERE empleado_id = NEW.empleado_id
           AND anulada = FALSE
           AND tipo = NEW.tipo
           AND marcado_en > NEW.marcado_en - INTERVAL '30 seconds'
           AND marcado_en <= NEW.marcado_en
    ) THEN
        RAISE EXCEPTION 'duplicado_reciente';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_evitar_duplicados
    BEFORE INSERT ON marcaciones
    FOR EACH ROW EXECUTE FUNCTION fn_evitar_duplicados();

-- ------------------------------------------------------------
-- Auditoría
-- ------------------------------------------------------------
CREATE TABLE auditoria (
    id           BIGSERIAL PRIMARY KEY,
    actor_email  TEXT        NOT NULL,
    accion       TEXT        NOT NULL,
    detalle      JSONB,
    ocurrido_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip           INET
);

CREATE INDEX ix_audit_actor ON auditoria (actor_email, ocurrido_en);

-- ============================================================
-- VISTAS DE REPORTE
-- ============================================================

-- Sesiones de trabajo.
-- Cada 'entrada' abre una sesión; todo lo que sigue (descansos y salida)
-- pertenece a esa sesión hasta la próxima 'entrada'.
CREATE OR REPLACE VIEW v_sesiones AS
WITH marc AS (
    SELECT
        m.empleado_id,
        m.tipo,
        m.marcado_en,
        SUM(CASE WHEN m.tipo = 'entrada' THEN 1 ELSE 0 END)
            OVER (PARTITION BY m.empleado_id ORDER BY m.marcado_en
                  ROWS UNBOUNDED PRECEDING) AS sesion
    FROM marcaciones m
    WHERE m.anulada = FALSE
),
sig AS (
    SELECT
        marc.*,
        LEAD(marcado_en) OVER w AS sig_en,
        LEAD(tipo)       OVER w AS sig_tipo
    FROM marc
    WINDOW w AS (PARTITION BY empleado_id, sesion ORDER BY marcado_en)
),
agg AS (
    SELECT
        empleado_id,
        sesion,
        MIN(marcado_en) FILTER (WHERE tipo = 'entrada') AS entrada,
        MAX(marcado_en) FILTER (WHERE tipo = 'salida')  AS salida,
        -- Un descanso cuenta desde 'descanso_inicio' hasta 'descanso_fin'.
        -- Si la persona marcó salida sin cerrar el descanso, cierra en la salida.
        COALESCE(SUM(EXTRACT(EPOCH FROM (sig_en - marcado_en)))
                 FILTER (WHERE tipo = 'descanso_inicio'
                           AND sig_tipo IN ('descanso_fin','salida')), 0) AS descanso_seg,
        COUNT(*) FILTER (WHERE tipo = 'descanso_inicio')                  AS descansos,
        COUNT(*) FILTER (WHERE tipo = 'descanso_inicio'
                           AND sig_tipo NOT IN ('descanso_fin','salida')) AS descansos_sin_cerrar
    FROM sig
    GROUP BY empleado_id, sesion
)
SELECT
    a.empleado_id,
    a.sesion,
    e.email,
    e.nombre,
    e.departamento,
    e.jefe_email,
    e.jornada_horas,
    e.descanso_minutos,
    fn_trabajo_esperado(e.jornada_horas, e.descanso_minutos,
                        e.jornada_incluye_descanso)          AS trabajo_esperado,
    (a.entrada AT TIME ZONE e.timezone)::date                AS fecha,
    (a.entrada AT TIME ZONE e.timezone)                      AS entrada,
    (a.salida  AT TIME ZONE e.timezone)                      AS salida,
    ROUND(EXTRACT(EPOCH FROM (a.salida - a.entrada)) / 3600.0, 2)          AS horas_presencia,
    ROUND(a.descanso_seg / 3600.0, 2)                                     AS horas_descanso,
    ROUND((EXTRACT(EPOCH FROM (a.salida - a.entrada)) - a.descanso_seg)
          / 3600.0, 2)                                                    AS horas_trabajadas,
    a.descansos,
    a.descansos_sin_cerrar
FROM agg a
JOIN empleados e ON e.id = a.empleado_id
WHERE a.entrada IS NOT NULL
  AND a.salida  IS NOT NULL;

-- Resumen por empleado y día. Esta es la vista que consume Excel.
CREATE OR REPLACE VIEW v_resumen_diario AS
SELECT
    email,
    nombre,
    departamento,
    jefe_email,
    fecha,
    MIN(entrada)                     AS primera_entrada,
    MAX(salida)                      AS ultima_salida,
    COUNT(*)                         AS sesiones,
    ROUND(SUM(horas_presencia),  2)  AS horas_presencia,
    ROUND(SUM(horas_descanso),   2)  AS horas_descanso,
    ROUND(SUM(horas_trabajadas), 2)  AS horas_trabajadas,
    MAX(descanso_minutos)            AS descanso_permitido_min,
    MAX(trabajo_esperado)            AS trabajo_esperado,
    -- Minutos de descanso por encima de lo permitido
    GREATEST(ROUND(SUM(horas_descanso) * 60 - MAX(descanso_minutos)), 0)  AS descanso_excedido_min,
    ROUND(GREATEST(SUM(horas_trabajadas) - MAX(trabajo_esperado), 0), 2)  AS horas_extra,
    ROUND(GREATEST(MAX(trabajo_esperado) - SUM(horas_trabajadas), 0), 2)  AS horas_faltantes
FROM v_sesiones
GROUP BY email, nombre, departamento, jefe_email, fecha;

-- Sesiones sin cerrar.
--   'en_curso'   → está trabajando o en descanso ahora mismo (normal)
--   'sin_salida' → olvidó marcar salida y ya hay marcaciones posteriores.
--                  Estas horas NO aparecen en el reporte hasta corregirlas.
CREATE OR REPLACE VIEW v_pendientes AS
WITH marc AS (
    SELECT
        m.empleado_id,
        m.tipo,
        m.marcado_en,
        SUM(CASE WHEN m.tipo = 'entrada' THEN 1 ELSE 0 END)
            OVER (PARTITION BY m.empleado_id ORDER BY m.marcado_en
                  ROWS UNBOUNDED PRECEDING) AS sesion
    FROM marcaciones m
    WHERE m.anulada = FALSE
),
agg AS (
    SELECT
        empleado_id,
        sesion,
        MIN(marcado_en) FILTER (WHERE tipo = 'entrada') AS entrada,
        MAX(marcado_en) FILTER (WHERE tipo = 'salida')  AS salida,
        MAX(marcado_en)                                 AS ultima_marca
    FROM marc
    GROUP BY empleado_id, sesion
)
SELECT
    e.email,
    e.nombre,
    e.departamento,
    e.jefe_email,
    (a.entrada AT TIME ZONE e.timezone)::date  AS fecha,
    (a.entrada AT TIME ZONE e.timezone)        AS entrada,
    ROUND(EXTRACT(EPOCH FROM (now() - a.entrada)) / 3600.0, 2) AS horas_transcurridas,
    CASE WHEN a.sesion = (SELECT MAX(sesion) FROM agg a2
                           WHERE a2.empleado_id = a.empleado_id)
         THEN 'en_curso' ELSE 'sin_salida' END AS situacion
FROM agg a
JOIN empleados e ON e.id = a.empleado_id
WHERE a.entrada IS NOT NULL
  AND a.salida  IS NULL;

-- ------------------------------------------------------------
-- Rol de solo lectura para la conexión de Excel del jefe
-- ------------------------------------------------------------
-- CREATE ROLE bi_lector LOGIN PASSWORD 'CAMBIAR-ESTO';
-- GRANT USAGE ON SCHEMA asistencia TO bi_lector;
-- GRANT SELECT ON asistencia.v_resumen_diario,
--                 asistencia.v_sesiones,
--                 asistencia.v_pendientes TO bi_lector;
-- No se otorga acceso a empleados, invitaciones ni dispositivos:
-- contienen hashes de tokens.
