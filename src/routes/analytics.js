const express = require('express');
const auth = require('../../auth');
const { pool } = require('../db');
const { wrap, HttpError } = require('../http');
const analytics = require('../services/analytics');
const { listDispensers } = require('../services/dispensers');

const r = express.Router();

r.get('/api/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, uptime_s: Math.round(process.uptime()) });
}));

r.get('/api/stats', auth.requireAuth, wrap(async (req, res) => res.json(await analytics.stats())));

// usage per day for the last N days (default 7), zero-filled
r.get('/api/usage/daily', auth.requireAuth, wrap(async (req, res) =>
  res.json(await analytics.usageDaily(Math.min(90, Math.max(1, +req.query.days || 7))))));

// usage per hour of today
r.get('/api/usage/hourly', auth.requireAuth, wrap(async (req, res) => res.json(await analytics.usageHourly())));

r.get('/api/alerts', auth.requireAuth, wrap(async (req, res) => res.json(await analytics.alertList(req.query.all === '1'))));

r.post('/api/alerts/:id/resolve', auth.requireAdmin, wrap(async (req, res) => {
  const [result] = await pool.query('UPDATE alerts SET resolved=1, resolved_at=NOW() WHERE id=? AND resolved=0', [req.params.id]);
  if (!result.affectedRows) throw new HttpError(404, 'Open alert not found');
  res.json({ ok: true });
}));

// Everything the dashboard shows, in one round trip (it polls this instead of five separate endpoints).
r.get('/api/dashboard', auth.requireAuth, wrap(async (req, res) => {
  const [stats, dispensers, alerts, daily, hourly] = await Promise.all([
    analytics.stats(), listDispensers(), analytics.alertList(false), analytics.usageDaily(7), analytics.usageHourly(),
  ]);
  res.json({ stats, dispensers, alerts, daily, hourly });
}));

const csvCell = v => {
  let t = v instanceof Date ? v.toISOString() : String(v ?? '');
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // neutralise spreadsheet formula injection
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
r.get('/api/export/events.csv', auth.requireAuth, wrap(async (req, res) => {
  const days = Math.min(365, Math.max(1, +req.query.days || 30));
  const [rows] = await pool.query(
    `SELECT e.id, d.name, d.location, e.volume_ml, e.created_at
     FROM dispense_events e JOIN dispensers d ON d.id = e.dispenser_id
     WHERE e.created_at >= NOW() - INTERVAL ? DAY ORDER BY e.created_at DESC`, [days]);
  const lines = ['id,dispenser,location,volume_ml,time',
    ...rows.map(row => [row.id, row.name, row.location, row.volume_ml, row.created_at].map(csvCell).join(','))];
  res.set({ 'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="dispense-events-${days}d.csv"` });
  res.send(lines.join('\n') + '\n');
}));

module.exports = r;
