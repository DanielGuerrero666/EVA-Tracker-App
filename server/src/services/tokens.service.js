const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const REFRESH_TTL_MS = (Number(process.env.JWT_REFRESH_TTL_DAYS) || 30) * 24 * 60 * 60 * 1000;

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: process.env.JWT_ACCESS_TTL || '15m' }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_ACCESS_SECRET);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Rows past their expiry have no further use — rotateRefreshToken already
// rejects a token once expires_at has passed, revoked or not — so it's safe
// to purge them here on every issuance instead of needing a separate cron
// job. Best-effort: a cleanup hiccup should never block login/refresh.
async function cleanupExpiredTokens() {
  try {
    await pool.query('DELETE FROM refresh_tokens WHERE expires_at < now()');
  } catch (err) {
    console.error('Failed to clean up expired refresh tokens:', err);
  }
}

async function issueRefreshToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
  await pool.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, hashToken(token), expiresAt]
  );
  cleanupExpiredTokens();
  return token;
}

// Rotation: the presented token is revoked and a new one issued in the same
// call, so a stolen-but-unused token becomes worthless the moment the
// legitimate client refreshes again.
async function rotateRefreshToken(presentedToken) {
  const tokenHash = hashToken(presentedToken);
  const { rows } = await pool.query(
    `SELECT id, user_id FROM refresh_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash]
  );
  const row = rows[0];
  if (!row) return null;

  await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
  const newToken = await issueRefreshToken(row.user_id);
  return { userId: row.user_id, refreshToken: newToken };
}

async function revokeRefreshToken(presentedToken) {
  await pool.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(presentedToken)]
  );
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
};
