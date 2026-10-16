const express = require('express');
const auth = require('../../auth');
const { pool, tx } = require('../db');
const { HttpError, wrap, num, str, sameSecret } = require('../http');
const { withStatus, getDispenser, listDispensers } = require('../services/dispensers');
const { evaluateAlerts, logLevel } = require('../services/alerts');

const r = express.Router();

// Devices authenticate with a shared key (header x-api-key). Disabled if DEVICE_API_KEY is unset.
if (!process.env.DEVICE_API_KEY && process.env.NODE_ENV === 'production')
  console.warn('WARNING: DEVICE_API_KEY is not set, so anyone can post readings and dispense events. Set it in production.');
const deviceAuth = (req, res, next) => {
  const key = process.env.DEVICE_API_KEY;
  if (key && !sameSecret(req.get('x-api-key') ?? '', key)) return res.status(401).json({ error: 'Invalid or missing API key' });
  next();
};

// ---------- dispensers CRUD ----------
r.get('/api/dispensers', auth.requireAuth, wrap(async (req, res) => res.json(await listDispensers())));

r.get('/api/dispensers/:id', auth.requireAuth, wrap(async (req, res) => {
  res.json((await listDispensers(req.params.id))[0]);
}));

// Optional per-dispenser alert thresholds: null/absent means "use the server default".
const threshold = (v, name, min, max, int) => {
  if (v === null || v === '') return null;
  const n = num(v, name, { min, max });
  if (int && !Number.isInteger(n)) throw new HttpError(400, `${name} must be a whole number`);
  return n;
};

r.post('/api/dispensers', auth.requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 'name', 80);
  const location = str(b.location, 'location', 120);
  const capacity = num(b.capacity_l ?? 20, 'capacity_l', { min: 1, max: 1000 });
  const level = num(b.level_l ?? 0, 'level_l', { min: 0, max: capacity });
  const lowPct = b.low_level_pct === undefined ? null : threshold(b.low_level_pct, 'low_level_pct', 1, 99, true);
  const hotC = b.high_temp_c === undefined ? null : threshold(b.high_temp_c, 'high_temp_c', 0, 100, false);
  const [r] = await pool.query(
    'INSERT INTO dispensers (name, location, capacity_l, level_l, low_level_pct, high_temp_c, last_seen) VALUES (?,?,?,?,?,?,NOW())',
    [name, location, capacity, level, lowPct, hotC]);
  res.status(201).json((await listDispensers(r.insertId))[0]);
}));

r.put('/api/dispensers/:id', auth.requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const out = await tx(async conn => {
    const d = await getDispenser(conn, req.params.id, true);
    const name = b.name !== undefined ? str(b.name, 'name', 80) : d.name;
    const location = b.location !== undefined ? str(b.location, 'location', 120) : d.location;
    const capacity = b.capacity_l !== undefined ? num(b.capacity_l, 'capacity_l', { min: 1, max: 1000 }) : d.capacity_l;
    const enabled = b.enabled !== undefined ? (b.enabled ? 1 : 0) : d.enabled;
    const lowPct = b.low_level_pct !== undefined ? threshold(b.low_level_pct, 'low_level_pct', 1, 99, true) : d.low_level_pct;
    const hotC = b.high_temp_c !== undefined ? threshold(b.high_temp_c, 'high_temp_c', 0, 100, false) : d.high_temp_c;
    if (d.level_l > capacity) throw new HttpError(400, 'capacity_l cannot be below the current level');
    await conn.query('UPDATE dispensers SET name=?, location=?, capacity_l=?, enabled=?, low_level_pct=?, high_temp_c=? WHERE id=?',
      [name, location, capacity, enabled, lowPct, hotC, d.id]);
    await evaluateAlerts(conn, await getDispenser(conn, d.id)); // a new threshold can open or clear an alert immediately
    return d.id;
  });
  res.json((await listDispensers(out))[0]);
}));

r.delete('/api/dispensers/:id', auth.requireAdmin, wrap(async (req, res) => {
  const [r] = await pool.query('DELETE FROM dispensers WHERE id=?', [req.params.id]);
  if (!r.affectedRows) throw new HttpError(404, 'Dispenser not found');
  res.status(204).end();
}));

// ---------- device endpoints ----------
// Heartbeat / telemetry: device reports its sensor values.
r.post('/api/dispensers/:id/readings', deviceAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const out = await tx(async conn => {
    const d = await getDispenser(conn, req.params.id, true);
    const level = b.level_l !== undefined ? num(b.level_l, 'level_l', { min: 0, max: d.capacity_l }) : d.level_l;
    const temp = b.temperature_c !== undefined ? num(b.temperature_c, 'temperature_c', { min: -10, max: 100 }) : d.temperature_c;
    await conn.query('UPDATE dispensers SET level_l=?, temperature_c=?, last_seen=NOW() WHERE id=?', [level, temp, d.id]);
    const updated = await getDispenser(conn, d.id);
    await evaluateAlerts(conn, updated);
    await logLevel(conn, updated);
    return withStatus(updated);
  });
  res.json(out);
}));

// A user draws water: logs the event and deducts from the tank atomically.
r.post('/api/dispensers/:id/dispense', deviceAuth, wrap(async (req, res) => {
  const ml = Math.round(num(req.body?.volume_ml, 'volume_ml', { min: 1, max: 5000 }));
  const out = await tx(async conn => {
    const d = await getDispenser(conn, req.params.id, true);
    if (!d.enabled) throw new HttpError(409, 'Dispenser is disabled');
    if (d.level_l * 1000 < ml) throw new HttpError(409, 'Not enough water in tank');
    await conn.query('INSERT INTO dispense_events (dispenser_id, volume_ml) VALUES (?,?)', [d.id, ml]);
    await conn.query('UPDATE dispensers SET level_l = level_l - ?, last_seen=NOW() WHERE id=?', [ml / 1000, d.id]);
    const updated = await getDispenser(conn, d.id);
    await evaluateAlerts(conn, updated);
    await logLevel(conn, updated);
    return withStatus(updated);
  });
  res.json(out);
}));

r.post('/api/dispensers/:id/refill', auth.requireAdmin, wrap(async (req, res) => {
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
    await logLevel(conn, updated);
    return withStatus(updated);
  });
  res.json(out);
}));

r.get('/api/dispensers/:id/events', auth.requireAuth, wrap(async (req, res) => {
  await getDispenser(pool, req.params.id);
  const [rows] = await pool.query(
    'SELECT id, volume_ml, created_at FROM dispense_events WHERE dispenser_id=? ORDER BY created_at DESC LIMIT 50',
    [req.params.id]);
  res.json(rows);
}));

r.get('/api/dispensers/:id/refills', auth.requireAuth, wrap(async (req, res) => {
  await getDispenser(pool, req.params.id);
  const [rows] = await pool.query(
    'SELECT id, added_l, created_at FROM refills WHERE dispenser_id=? ORDER BY created_at DESC, id DESC LIMIT 20', [req.params.id]);
  res.json(rows);
}));

r.get('/api/dispensers/:id/history', auth.requireAuth, wrap(async (req, res) => {
  await getDispenser(pool, req.params.id);
  const hours = Math.min(168, Math.max(1, +req.query.hours || 24));
  const [rows] = await pool.query(
    `SELECT level_l, temperature_c, created_at FROM level_readings
     WHERE dispenser_id=? AND created_at >= NOW() - INTERVAL ? HOUR ORDER BY created_at LIMIT 1000`,
    [req.params.id, hours]);
  res.json(rows);
}));

module.exports = r;
