const TokenStore = require('./tokenStore');
const { API_BASE_URL } = require('./config');

class SessionExpiredError extends Error {
  constructor() {
    super('Session expired, please log in again');
    this.sessionExpired = true;
  }
}

// Same method names/shapes as the old local-JSON-file store so main.js's
// ipcMain handlers barely change — only the storage moved to HTTP calls
// against the VPS-hosted API.
class ApiClient {
  constructor({ baseUrl = API_BASE_URL, onSessionExpired } = {}) {
    this.baseUrl = baseUrl;
    this.onSessionExpired = onSessionExpired || (() => {});
    this.tokenStore = new TokenStore();
    this.accessToken = null; // never persisted — re-derived from the refresh token on start

    const cached = this.tokenStore.load();
    this.user = cached ? cached.user : null;
    this.refreshToken = cached ? cached.refreshToken : null;
  }

  getUser() {
    return this.user;
  }

  // Wraps the global fetch() so a network-level failure (DNS, TLS, connection
  // refused, timeout, proxy...) surfaces its real cause instead of the opaque
  // "TypeError: fetch failed" that undici throws — Electron's IPC layer only
  // forwards error.message to the renderer, dropping error.cause otherwise.
  async _fetch(url, options) {
    try {
      return await fetch(url, options);
    } catch (err) {
      const cause = err.cause;
      console.error('Network request failed:', url, cause || err);
      const detail = cause ? `${cause.code || cause.name || ''} ${cause.message || cause}`.trim() : err.message;
      throw new Error(`No se pudo conectar al servidor (${detail})`);
    }
  }

  async login(email, password) {
    const res = await this._fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Could not log in');
    }
    const data = await res.json();
    this.accessToken = data.accessToken;
    this.refreshToken = data.refreshToken;
    this.user = data.user;
    this.tokenStore.save({ user: this.user, refreshToken: this.refreshToken });
    return this.user;
  }

  async logout() {
    if (this.refreshToken) {
      await this._fetch(`${this.baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      }).catch(() => {});
    }
    this._clearSession();
  }

  _clearSession() {
    this.accessToken = null;
    this.refreshToken = null;
    this.user = null;
    this.tokenStore.clear();
  }

  async _refreshAccessToken() {
    if (!this.refreshToken) return false;
    const res = await this._fetch(`${this.baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: this.refreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    this.accessToken = data.accessToken;
    this.refreshToken = data.refreshToken;
    this.tokenStore.save({ user: this.user, refreshToken: this.refreshToken });
    return true;
  }

  async _authedRequest(method, path, body, { raw = false, returnResponse = false } = {}) {
    if (!this.accessToken && !(await this._refreshAccessToken())) {
      this._clearSession();
      this.onSessionExpired();
      throw new SessionExpiredError();
    }

    const doRequest = () =>
      this._fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

    let res = await doRequest();

    if (res.status === 401) {
      if (await this._refreshAccessToken()) {
        res = await doRequest();
      } else {
        this._clearSession();
        this.onSessionExpired();
        throw new SessionExpiredError();
      }
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Request failed (${res.status})`);
    }

    if (returnResponse) return res;
    if (res.status === 204) return null;
    return raw ? res.text() : res.json();
  }

  getStatus() {
    return this._authedRequest('GET', '/api/time/status');
  }

  clockIn() {
    return this._authedRequest('POST', '/api/time/clock-in');
  }

  clockOut() {
    return this._authedRequest('POST', '/api/time/clock-out');
  }

  getShifts(limit = 20) {
    return this._authedRequest('GET', `/api/time/shifts?limit=${encodeURIComponent(limit)}`);
  }

  getBreakStatus() {
    return this._authedRequest('GET', '/api/break/status');
  }

  startBreak() {
    return this._authedRequest('POST', '/api/break/start');
  }

  endBreak() {
    return this._authedRequest('POST', '/api/break/end');
  }

  listEmployees() {
    return this._authedRequest('GET', '/api/admin/employees');
  }

  today() {
    return this._authedRequest('GET', '/api/admin/today');
  }

  async exportCsv(params = {}) {
    const query = new URLSearchParams(params).toString();
    const res = await this._authedRequest('GET', `/api/admin/export.csv${query ? `?${query}` : ''}`, undefined, {
      returnResponse: true,
    });
    const match = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/);
    return { csv: await res.text(), filename: match ? match[1] : 'shifts.csv' };
  }

  createEmployee(employee) {
    return this._authedRequest('POST', '/api/admin/employees', employee);
  }

  updateEmployee(id, updates) {
    return this._authedRequest('PATCH', `/api/admin/employees/${encodeURIComponent(id)}`, updates);
  }

  async changePassword(currentPassword, newPassword) {
    await this._authedRequest('POST', '/api/auth/change-password', { currentPassword, newPassword });
    if (this.user) {
      this.user = { ...this.user, mustChangePassword: false };
      this.tokenStore.save({ user: this.user, refreshToken: this.refreshToken });
    }
  }
}

module.exports = ApiClient;
