const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

// Persists only the long-lived refresh token + user profile, encrypted at
// rest via the OS keychain (DPAPI on Windows). The short-lived access token
// is never written to disk — it's cheap to re-derive from the refresh token
// on every app start, and keeping it memory-only shrinks what a disk-level
// compromise could expose.
class TokenStore {
  constructor(filePath) {
    this.filePath = filePath || path.join(app.getPath('userData'), 'eva-tracker-session.json');
  }

  save({ user, refreshToken }) {
    const payload = JSON.stringify({ user, refreshToken });
    const canEncrypt = safeStorage.isEncryptionAvailable();
    const contents = canEncrypt
      ? safeStorage.encryptString(payload)
      : Buffer.from(payload, 'utf-8');

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify({ encrypted: canEncrypt, data: contents.toString('base64') }));
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      const buffer = Buffer.from(raw.data, 'base64');
      const payload = raw.encrypted ? safeStorage.decryptString(buffer) : buffer.toString('utf-8');
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }

  clear() {
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      // Nothing to remove.
    }
  }
}

module.exports = TokenStore;
