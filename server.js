require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const auth = require('./auth');

const PORT = +(process.env.PORT || 3000);
const OFFLINE_AFTER_MIN = +(process.env.OFFLINE_AFTER_MIN || 2);
const LOW_LEVEL_PCT = +(process.env.LOW_LEVEL_PCT || 20);
const HIGH_TEMP_C = 25;

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: +(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'smart_water',
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true,
  dateStrings: false,
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = fn => (req, res, next) => fn(req, res).catch(next);

const num = (v, name, { min = -Infinity, max = Infinity } = {}) => {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n) || n < min || n > max)
    throw new HttpError(400, `${name} must be a number between ${min} and ${max}`);
  return n;
};
const str = (v, name, max) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max)
    throw new HttpError(400, `${name} is required (max ${max} chars)`);
  return v.trim();
};

// status is derived, not stored, so it can never go stale
function withStatus(d) {
  const pct = d.capacity_l > 0 ? (d.level_l / d.capacity_l) * 100 : 0;
  const ageMin = d.last_seen ? (Date.now() - new Date(d.last_seen).getTime()) / 60000 : Infinity;
  let status = 'OK';
  if (!d.enabled) status = 'DISABLED';
  else if (ageMin > OFFLINE_AFTER_MIN) status = 'OFFLINE';
  else if (d.level_l <= 0) status = 'EMPTY';
  else if (pct < LOW_LEVEL_PCT) status = 'LOW';
  return { ...d, enabled: !!d.enabled, level_pct: Math.round(pct * 10) / 10, status };
}

// Open an alert only if there isn't already an unresolved one (dedupe); resolve when condition clears.
async function syncAlert(conn, dispenserId, type, active, message) {
  const [rows] = await conn.query(
    'SELECT id FROM alerts WHERE dispenser_id=? AND type=? AND resolved=0 LIMIT 1 FOR UPDATE', [dispenserId, type]);
  if (active && !rows.length)
    await conn.query('INSERT INTO alerts (dispenser_id, type, message) VALUES (?,?,?)', [dispenserId, type, message]);
  else if (!active && rows.length)
    await conn.query('UPDATE alerts SET resolved=1, resolved_at=NOW() WHERE id=?', [rows[0].id]);
}

async function evaluateAlerts(conn, d) {
  const pct = (d.level_l / d.capacity_l) * 100;
  await syncAlert(conn, d.id, 'EMPTY', d.level_l <= 0, `${d.name} is empty`);
  await syncAlert(conn, d.id, 'LOW_LEVEL', d.level_l > 0 && pct < LOW_LEVEL_PCT,
    `${d.name} is low (${pct.toFixed(0)}%)`);
  await syncAlert(conn, d.id, 'HIGH_TEMP', d.temperature_c != null && d.temperature_c > HIGH_TEMP_C,
    `${d.name} water temperature is ${d.temperature_c}°C`);
  await syncAlert(conn, d.id, 'OFFLINE', false, '');
}

// run fn inside a transaction on a dedicated connection
async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function getDispenser(conn, id, lock = false) {
  const [rows] = await conn.query(`SELECT * FROM dispensers WHERE id=? ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!rows.length) throw new HttpError(404, 'Dispenser not found');
  return rows[0];
}

// Devices authenticate with a shared key (header x-api-key). Disabled if DEVICE_API_KEY is unset.
const deviceAuth = (req, res, next) => {
  const key = process.env.DEVICE_API_KEY;
  if (key && req.get('x-api-key') !== key) return res.status(401).json({ error: 'Invalid or missing API key' });
  next();
};

// ---------- auth ----------
app.post('/api/auth/login', wrap(async (req, res) => {
  const ip = req.ip;
  if (auth.throttled(ip)) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
  const { username, password } = req.body || {};
  const [rows] = typeof username === 'string' && typeof password === 'string'
    ? await pool.query('SELECT * FROM users WHERE username=?', [username]) : [[]];
  const u = rows[0];
  if (!u || !auth.verifyPassword(password, u.password_hash)) {
    auth.recordFail(ip);
    throw new HttpError(401, 'Invalid username or password');
  }
  auth.setSession(res, u);
  res.json({ username: u.username, role: u.role });
}));
app.post('/api/auth/logout', (req, res) => { auth.clearSession(res); res.json({ ok: true }); });
app.get('/api/auth/me', auth.requireAuth, (req, res) => res.json(req.user));

// ---------- health ----------
app.get('/api/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, uptime_s: Math.round(process.uptime()) });
}));

// ---------- dispensers CRUD ----------
app.get('/api/dispensers', auth.requireAuth, wrap(async (req, res) => {
  const [rows] = await pool.query(`
    SELECT d.*, COALESCE(t.ml, 0) AS today_ml
    FROM dispensers d
    LEFT JOIN (SELECT dispenser_id, SUM(volume_ml) ml FROM dispense_events
               WHERE created_at >= CURDATE() GROUP BY dispenser_id) t ON t.dispenser_id = d.id
    ORDER BY d.id`);
  res.json(rows.map(withStatus));
}));

app.get('/api/dispensers/:id', auth.requireAuth, wrap(async (req, res) => {
  res.json(withStatus(await getDispenser(pool, req.params.id)));
}));

app.post('/api/dispensers', auth.requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 'name', 80);
  const location = str(b.location, 'location', 120);
  const capacity = num(b.capacity_l ?? 20, 'capacity_l', { min: 1, max: 1000 });
  const level = num(b.level_l ?? 0, 'level_l', { min: 0, max: capacity });
  const [r] = await pool.query(
    'INSERT INTO dispensers (name, location, capacity_l, level_l, last_seen) VALUES (?,?,?,?,NOW())',
    [name, location, capacity, level]);
  res.status(201).json(withStatus(await getDispenser(pool, r.insertId)));
}));

app.put('/api/dispensers/:id', auth.requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const out = await tx(async conn => {
    const d = await getDispenser(conn, req.params.id, true);
    const name = b.name !== undefined ? str(b.name, 'name', 80) : d.name;
    const location = b.location !== undefined ? str(b.location, 'location', 120) : d.location;
    const capacity = b.capacity_l !== undefined ? num(b.capacity_l, 'capacity_l', { min: 1, max: 1000 }) : d.capacity_l;
    const enabled = b.enabled !== undefined ? (b.enabled ? 1 : 0) : d.enabled;
    if (d.level_l > capacity) throw new HttpError(400, 'capacity_l cannot be below the current level');
    await conn.query('UPDATE dispensers SET name=?, location=?, capacity_l=?, enabled=? WHERE id=?',
      [name, location, capacity, enabled, d.id]);
    return withStatus(await getDispenser(conn, d.id));
  });
  res.json(out);
}));

app.delete('/api/dispensers/:id', auth.requireAdmin, wrap(async (req, res) => {
  const [r] = await pool.query('DELETE FROM dispensers WHERE id=?', [req.params.id]);
  if (!r.affectedRows) throw new HttpError(404, 'Dispenser not found');
  res.status(204).end();
}));

// ---------- device endpoints ----------
// Heartbeat / telemetry: device reports its sensor values.
app.post('/api/dispensers/:id/readings', deviceAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const out = await tx(async conn => {
    const d = await getDispenser(conn, req.params.id, true);
    const level = b.level_l !== undefined ? num(b.level_l, 'level_l', { min: 0, max: d.capacity_l }) : d.level_l;
    const temp = b.temperature_c !== undefined ? num(b.temperature_c, 'temperature_c', { min: -10, max: 100 }) : d.temperature_c;
    await conn.query('UPDATE dispensers SET level_l=?, temperature_c=?, last_seen=NOW() WHERE id=?', [level, temp, d.id]);
    const updated = await getDispenser(conn, d.id);
    await evaluateAlerts(conn, updated);
    return withStatus(updated);
  });
  res.json(out);
}));

// A user draws water: logs the event and deducts from the tank atomically.
app.post('/api/dispensers/:id/dispense', deviceAuth, wrap(async (req, res) => {
  const ml = Math.round(num(req.body?.volume_ml, 'volume_ml', { min: 1, max: 5000 }));
  const out = await tx(async conn => {
    const d = await getDispenser(conn, req.params.id, true);
    if (!d.enabled) throw new HttpError(409, 'Dispenser is disabled');
    if (d.level_l * 1000 < ml) throw new HttpError(409, 'Not enough water in tank');
    await conn.query('INSERT INTO dispense_events (dispenser_id, volume_ml) VALUES (?,?)', [d.id, ml]);
    await conn.query('UPDATE dispensers SET level_l = level_l - ?, last_seen=NOW() WHERE id=?', [ml / 1000, d.id]);
    const updated = await getDispenser(conn, d.id);
    await evaluateAlerts(conn, updated);
    return withStatus(updated);
  });
  res.json(out);
}));

app.post('/api/dispensers/:id/refill', auth.requireAdmin, wrap(async (req, res) => {
  const out = await tx(async conn => {
    const d = await getDispenser(conn, req.params.id, true);
    const added = req.body?.added_l !== undefined
      ? num(req.body.added_l, 'added_l', { min: 0.1, max: d.capacity_l })
      : d.capacity_l - d.level_l; // default: fill to the top
    const newLevel = Math.min(d.capacity_l, d.level_l + added);
    await conn.query('INSERT INTO refills (dispenser_id, added_l) VALUES (?,?)', [d.id, newLevel - d.level_l]);
    await conn.query('UPDATE dispensers SET level_l=?, last_seen=NOW() WHERE id=?', [newLevel, d.id]);
    const updated = await getDispenser(conn, d.id);
    await evaluateAlerts(conn, updated);
    return withStatus(updated);
  });
  res.json(out);
}));

// ---------- analytics ----------
app.get('/api/stats', auth.requireAuth, wrap(async (req, res) => {
  const [[dayRow]] = await pool.query(
    'SELECT COALESCE(SUM(volume_ml),0) ml, COUNT(*) n FROM dispense_events WHERE created_at >= CURDATE()');
  const [dispensers] = await pool.query('SELECT * FROM dispensers');
  const withS = dispensers.map(withStatus);
  const count = s => withS.filter(d => d.status === s).length;
  const [[{ open }]] = await pool.query('SELECT COUNT(*) open FROM alerts WHERE resolved=0');
  res.json({
    total: withS.length,
    ok: count('OK'), low: count('LOW'), empty: count('EMPTY'),
    offline: count('OFFLINE'), disabled: count('DISABLED'),
    today_liters: dayRow.ml / 1000,
    today_dispenses: dayRow.n,
    open_alerts: open,
  });
}));

// usage per day for the last N days (default 7), zero-filled
app.get('/api/usage/daily', auth.requireAuth, wrap(async (req, res) => {
  const days = Math.min(90, Math.max(1, +req.query.days || 7));
  const [rows] = await pool.query(
    `SELECT DATE(created_at) d, SUM(volume_ml)/1000 liters FROM dispense_events
     WHERE created_at >= CURDATE() - INTERVAL ? DAY GROUP BY DATE(created_at)`, [days - 1]);
  const map = new Map(rows.map(r => [new Date(r.d).toLocaleDateString('en-CA'), +r.liters]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(Date.now() - i * 864e5).toLocaleDateString('en-CA');
    out.push({ date: key, liters: Math.round((map.get(key) || 0) * 100) / 100 });
  }
  res.json(out);
}));

// usage per hour of today
app.get('/api/usage/hourly', auth.requireAuth, wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT HOUR(created_at) h, SUM(volume_ml)/1000 liters FROM dispense_events
     WHERE created_at >= CURDATE() GROUP BY HOUR(created_at)`);
  const map = new Map(rows.map(r => [r.h, +r.liters]));
  res.json(Array.from({ length: 24 }, (_, h) => ({ hour: h, liters: Math.round((map.get(h) || 0) * 100) / 100 })));
}));

app.get('/api/dispensers/:id/events', auth.requireAuth, wrap(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, volume_ml, created_at FROM dispense_events WHERE dispenser_id=? ORDER BY created_at DESC LIMIT 50',
    [req.params.id]);
  res.json(rows);
}));

// ---------- alerts ----------
app.get('/api/alerts', auth.requireAuth, wrap(async (req, res) => {
  const where = req.query.all === '1' ? '' : 'WHERE a.resolved=0';
  const [rows] = await pool.query(
    `SELECT a.*, d.name AS dispenser_name FROM alerts a JOIN dispensers d ON d.id=a.dispenser_id
     ${where} ORDER BY a.created_at DESC LIMIT 100`);
  res.json(rows);
}));

app.post('/api/alerts/:id/resolve', auth.requireAdmin, wrap(async (req, res) => {
  const [r] = await pool.query('UPDATE alerts SET resolved=1, resolved_at=NOW() WHERE id=? AND resolved=0', [req.params.id]);
  if (!r.affectedRows) throw new HttpError(404, 'Open alert not found');
  res.json({ ok: true });
}));

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'Invalid JSON' });
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------- background job: offline detection ----------
async function checkOffline() {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query('SELECT * FROM dispensers WHERE enabled=1');
    for (const d of rows) {
      const stale = !d.last_seen || (Date.now() - new Date(d.last_seen).getTime()) / 60000 > OFFLINE_AFTER_MIN;
      await conn.beginTransaction();
      await syncAlert(conn, d.id, 'OFFLINE', stale, `${d.name} has stopped reporting`);
      await conn.commit();
    }
  } catch (e) {
    await conn.rollback().catch(() => {});
    console.error('offline check failed:', e.message);
  } finally {
    conn.release();
  }
}

const server = app.listen(PORT, () => {
  console.log(`Smart Water Dispenser running at http://localhost:${PORT}`);
});
const timer = setInterval(checkOffline, 30_000);

function shutdown() {
  clearInterval(timer);
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
