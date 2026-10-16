require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const auth = require('./auth');
const { PORT } = require('./src/config');
const { pool } = require('./src/db');
const { checkOffline } = require('./src/services/alerts');

auth.setUserLookup(async username =>
  (await pool.query('SELECT username, role, email, password_hash FROM users WHERE username=?', [username]))[0][0]);

const app = express();
app.disable('x-powered-by');
// Behind a reverse proxy (Render, Railway, nginx...) set TRUST_PROXY=1 so req.ip is the real client (rate limits depend on it).
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? +process.env.TRUST_PROXY : process.env.TRUST_PROXY === 'true');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    ...(process.env.COOKIE_SECURE === 'true' && { 'Strict-Transport-Security': 'max-age=15552000; includeSubDomains' }),
  });
  next();
});
app.use(cors({ origin: process.env.CORS_ORIGIN || false })); // same-origin only unless CORS_ORIGIN is set
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: res => res.set('Cache-Control', 'no-cache') })); // always revalidate, so upgrades show up immediately

app.use(require('./src/routes/auth').router);
app.use(require('./src/routes/users'));
app.use(require('./src/routes/dispensers'));
app.use(require('./src/routes/analytics'));
app.use(require('./src/routes/complaints'));

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'Invalid JSON' });
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

let server, timer;
function start(port = PORT) {
  server = app.listen(port, () => {
    console.log(`Smart Water Dispenser running at http://localhost:${server.address().port}`);
  });
  timer = setInterval(checkOffline, 30_000);
  return server;
}

function shutdown() {
  clearInterval(timer);
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}

if (require.main === module) {
  start();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { app, pool, start, checkOffline };
