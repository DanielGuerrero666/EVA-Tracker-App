"""
Tokens de invitación y de dispositivo.

No hay contraseñas en el sistema. El flujo es:
  1. El admin crea al empleado y genera una invitación de un solo uso.
  2. El empleado abre el enlace → la app de escritorio canjea el token.
  3. El canje devuelve un token de dispositivo permanente, que la app
     guarda cifrado con el llavero del sistema operativo.

En la base de datos solo se guarda el SHA-256 del token, nunca el valor
en claro: si alguien lee la tabla no puede suplantar a nadie.
"""
from __future__ import annotations

import hashlib
import secrets

import bcrypt

# Longitud en bytes. 32 bytes = 256 bits = 64 caracteres hex.
LONGITUD_TOKEN = 32


def nuevo_token() -> str:
    """Token aleatorio criptográficamente seguro."""
    return secrets.token_urlsafe(LONGITUD_TOKEN)


def hash_token(token: str) -> str:
    """SHA-256 del token. Es lo único que se guarda."""
    return hashlib.sha256(token.encode()).hexdigest()


def comparar(a: str, b: str) -> bool:
    """Comparación en tiempo constante."""
    return secrets.compare_digest(a, b)


# ------------------------------------------------------------------
# Contraseñas de administrador. bcrypt es lento a propósito: dificulta
# probar contraseñas por fuerza bruta si la base de datos se filtra.
# ------------------------------------------------------------------
def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verificar_password(password: str, hash_guardado: str) -> bool:
    return bcrypt.checkpw(password.encode(), hash_guardado.encode())
