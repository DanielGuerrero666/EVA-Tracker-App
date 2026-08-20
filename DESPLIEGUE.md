# Despliegue en un VPS o máquina virtual en la nube

Esta guía lleva el backend (FastAPI + PostgreSQL) de "corriendo en mi PC
mientras tengo la terminal abierta" a **un servidor Linux siempre
encendido**, con dominio propio y HTTPS. El instalador de Windows de la
app de escritorio se sigue generando en una máquina Windows (como se hizo
hasta ahora con `npm run dist:win`) — el VPS solo lo aloja para que se
descargue desde `/descargas/instalador.exe`.

Aplica a cualquier VPS Linux: DigitalOcean, AWS EC2, Azure VM, Google
Cloud, Hetzner, un droplet, etc. Los pasos usan Ubuntu 22.04/24.04.

---

## 0. Qué vas a necesitar

- Un VPS con Ubuntu 22.04+ (mínimo 1 vCPU / 1 GB RAM alcanza para esta
  escala de app).
- Acceso SSH como usuario con `sudo`.
- (Opcional pero recomendado) Un dominio o subdominio propio, por ejemplo
  `asistencia.tuagencia.com`, apuntando por un registro **A** a la IP del
  VPS. Sin dominio se puede usar la IP directa, pero no hay HTTPS válido.

---

## 1. Preparar el servidor

```bash
ssh usuario@IP_DEL_VPS

sudo apt update && sudo apt upgrade -y
sudo apt install -y python3-venv python3-pip postgresql postgresql-contrib \
                    nginx git ufw
```

Firewall básico (deja pasar SSH, HTTP y HTTPS; todo lo demás cerrado):

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

---

## 2. Base de datos

```bash
sudo -u postgres psql -c "CREATE DATABASE asistencia;"
sudo -u postgres psql -c "CREATE ROLE asistencia_app LOGIN PASSWORD 'ELIGE-UNA-CLAVE-FUERTE';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE asistencia TO asistencia_app;"

# Cargar el esquema (súbelo antes, ver paso 3)
sudo -u postgres psql -d asistencia -f /opt/asistencia/schema.sql
```

Habilita también el rol de solo lectura para el Excel en vivo (descomenta
y ejecuta el bloque final de `schema.sql`, cambiando la clave):

```sql
CREATE ROLE bi_lector LOGIN PASSWORD 'OTRA-CLAVE-FUERTE';
GRANT USAGE ON SCHEMA asistencia TO bi_lector;
GRANT SELECT ON asistencia.v_resumen_diario,
                asistencia.v_sesiones,
                asistencia.v_pendientes TO bi_lector;
```

Si el admin va a conectar Excel desde **otra máquina** (no el propio
VPS), habilita conexiones remotas a Postgres:

```bash
# /etc/postgresql/16/main/postgresql.conf
listen_addresses = '*'

# /etc/postgresql/16/main/pg_hba.conf — agrega al final, restringido al rol de lectura
host    asistencia    bi_lector    0.0.0.0/0    scram-sha-256
```

```bash
sudo systemctl restart postgresql
sudo ufw allow 5432/tcp   # solo si de verdad necesitas Postgres accesible desde fuera
```

---

## 3. Subir el código

Desde tu máquina local (con el proyecto ya en git, ver `README.md`):

```bash
# En el VPS
sudo mkdir -p /opt/asistencia
sudo chown $USER:$USER /opt/asistencia

# En tu máquina local
git clone <url-del-repo> /tmp/asistencia-local   # o simplemente rsync el working tree
rsync -avz --exclude node_modules --exclude .venv --exclude dist \
      --exclude __pycache__ --exclude '*.log' \
      ./ usuario@IP_DEL_VPS:/opt/asistencia/
```

(O clona directamente en el VPS con `git clone` si el repo ya está en
GitHub — ver el paso de "Actualizar" más abajo.)

---

## 4. Backend en Python

```bash
cd /opt/asistencia
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
```

Crea el archivo de entorno (nunca lo subas a git):

```bash
sudo tee /etc/asistencia.env > /dev/null <<'EOF'
DATABASE_URL=postgresql+psycopg2://asistencia_app:ELIGE-UNA-CLAVE-FUERTE@localhost:5432/asistencia
APP_URL=https://asistencia.tuagencia.com
DIAS_VALIDEZ_INVITACION=7
EOF
sudo chmod 600 /etc/asistencia.env
```

Crea al primer administrador (una sola vez):

```bash
set -a; source /etc/asistencia.env; set +a
.venv/bin/python - <<'PY'
import os, tokens
from sqlalchemy import create_engine, text
eng = create_engine(os.environ["DATABASE_URL"])
with eng.begin() as c:
    c.execute(text("""
        INSERT INTO asistencia.empleados (email, nombre, es_admin, password_hash, creado_por)
        VALUES ('jefe@empresa.com', 'María Jefe', TRUE, :p, 'bootstrap')
    """), dict(p=tokens.hash_password("CAMBIA-ESTA-CLAVE")))
print("Admin creado.")
PY
```

---

## 5. Servicio systemd (para que sobreviva reinicios y caídas)

Este es el paso que evita el problema de "el backend se cae si cierro la
terminal" que se vio en las pruebas locales — `systemd` lo mantiene vivo
y lo reinicia solo si crashea.

```bash
sudo tee /etc/systemd/system/asistencia.service > /dev/null <<'EOF'
[Unit]
Description=Control de Asistencia — API FastAPI
After=network.target postgresql.service

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/asistencia
EnvironmentFile=/etc/asistencia.env
ExecStart=/opt/asistencia/.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo chown -R www-data:www-data /opt/asistencia
sudo systemctl daemon-reload
sudo systemctl enable --now asistencia
sudo systemctl status asistencia   # debe decir "active (running)"
```

Uvicorn escucha en `127.0.0.1:8000` (no expuesto directo a internet) —
Nginx en el siguiente paso es el que recibe el tráfico público real.

---

## 6. Nginx como proxy + HTTPS

```bash
sudo tee /etc/nginx/sites-available/asistencia > /dev/null <<'EOF'
server {
    listen 80;
    server_name asistencia.tuagencia.com;

    client_max_body_size 100M;   # el instalador .exe pesa ~80 MB

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/asistencia /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

HTTPS gratis con Let's Encrypt (requiere que el dominio ya apunte al VPS):

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d asistencia.tuagencia.com
```

Certbot edita el bloque de Nginx solo, añade el certificado y programa la
renovación automática. Verifica con:

```bash
curl https://asistencia.tuagencia.com/healthz
# {"status":"ok"}
```

---

## 7. Subir el instalador de Windows

El `.exe` se construye en una máquina Windows con `npm run dist:win`
(Electron/NSIS no compilan instaladores Windows desde Linux sin
herramientas extra). Una vez generado en `dist/Control de Asistencia
Setup 1.0.0.exe`, súbelo al VPS:

```bash
scp "dist/Control de Asistencia Setup 1.0.0.exe" \
    usuario@IP_DEL_VPS:/opt/asistencia/dist/
```

La ruta y el nombre deben coincidir exactamente con lo que espera
`rutas_empleado.py` (`WEB_DIR / "dist" / "Control de Asistencia Setup
1.0.0.exe"`). Verifica la descarga:

```bash
curl -I https://asistencia.tuagencia.com/descargas/instalador.exe
```

---

## 8. Apuntar la app al servidor real

Antes de compilar el instalador que vas a distribuir, edita `config.js`
en tu máquina Windows:

```js
module.exports = {
  SERVIDOR: 'https://asistencia.tuagencia.com',
};
```

Y recompílalo:

```bash
npm run dist:win
```

Todos los instaladores nuevos ya apuntan al VPS. Los equipos que ya
activaron con la versión anterior **no se ven afectados** — el token de
dispositivo no depende de esta constante, solo las nuevas activaciones.

---

## 9. Lista de verificación final

- [ ] `curl https://tu-dominio/healthz` responde `{"status":"ok"}`
- [ ] `sudo systemctl status asistencia` → `active (running)`
- [ ] El certificado HTTPS es válido (candado verde en el navegador)
- [ ] Generar una invitación desde el panel y activarla en un equipo real
- [ ] Descargar el instalador desde `/descargas/instalador.exe` en un
      navegador normal
- [ ] Backup de PostgreSQL programado (ver abajo)

---

## 10. Backups

Mínimo viable, un cron diario:

```bash
sudo -u postgres crontab -e
```

```cron
0 3 * * * pg_dump asistencia | gzip > /var/backups/asistencia_$(date +\%F).sql.gz
```

Guarda esas copias fuera del propio VPS (S3, otro servidor, etc.) —
si el disco del VPS se pierde, un backup que vive solo ahí no sirve.

---

## 11. Actualizar la app más adelante

```bash
cd /opt/asistencia
sudo -u www-data git pull            # si el código vive en git en el VPS
sudo -u www-data .venv/bin/pip install -r requirements.txt
sudo systemctl restart asistencia
```

Si cambiaste `schema.sql` (nuevas columnas/tablas), escribe una migración
específica — **no vuelvas a correr `schema.sql` completo** sobre una base
con datos reales, fallará por los `CREATE TABLE` ya existentes y podría
perder datos si se fuerza.
