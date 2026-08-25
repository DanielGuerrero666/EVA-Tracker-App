require('dotenv').config();

for (const key of ['DATABASE_URL', 'JWT_ACCESS_SECRET']) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const app = require('./app');

const port = process.env.PORT || 3000;
// Bind to loopback only — Nginx terminates TLS and reverse-proxies from
// 443 to this port; the Node process itself must never be reachable directly.
app.listen(port, '127.0.0.1', () => {
  console.log(`EVA Tracker API listening on 127.0.0.1:${port}`);
});
