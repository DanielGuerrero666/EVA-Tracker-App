const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const tokens = require('../services/tokens.service');

async function login(req, res) {
  const { email, password } = req.body;

  const { rows } = await pool.query(
    'SELECT id, name, email, password_hash, role, must_change_password FROM users WHERE email = $1',
    [email]
  );
  const user = rows[0];

  // Compare against a fixed dummy hash when the user doesn't exist so the
  // response time doesn't reveal whether the email is registered.
  const passwordHash = user ? user.password_hash : '$2b$12$invalidsaltinvalidsaltinvalidsaltinvalidsaltinvalidsa';
  const passwordOk = await bcrypt.compare(password, passwordHash);

  if (!user || !passwordOk) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const accessToken = tokens.signAccessToken(user);
  const refreshToken = await tokens.issueRefreshToken(user.id);

  res.json({
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      mustChangePassword: user.must_change_password,
    },
  });
}

async function refresh(req, res) {
  const { refreshToken } = req.body;

  const rotated = await tokens.rotateRefreshToken(refreshToken);
  if (!rotated) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  const { rows } = await pool.query('SELECT id, role FROM users WHERE id = $1', [rotated.userId]);
  const user = rows[0];
  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  res.json({
    accessToken: tokens.signAccessToken(user),
    refreshToken: rotated.refreshToken,
  });
}

async function logout(req, res) {
  const { refreshToken } = req.body;
  if (refreshToken) await tokens.revokeRefreshToken(refreshToken);
  res.status(204).end();
}

async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;

  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  const user = rows[0];
  const currentOk = user && (await bcrypt.compare(currentPassword, user.password_hash));

  if (!currentOk) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const newHash = await bcrypt.hash(newPassword, 12);
  await pool.query(
    'UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2',
    [newHash, req.user.id]
  );

  res.status(204).end();
}

module.exports = { login, refresh, logout, changePassword };
