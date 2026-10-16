const { pool } = require('../db');
const { withStatus } = require('./dispensers');

async function stats() {
  const [[dayRow]] = await pool.query(
    'SELECT COALESCE(SUM(volume_ml),0) ml, COUNT(*) n FROM dispense_events WHERE created_at >= CURDATE()');
  const [dispensers] = await pool.query('SELECT * FROM dispensers');
  const withS = dispensers.map(withStatus);
  const count = s => withS.filter(d => d.status === s).length;
  const [[{ open }]] = await pool.query('SELECT COUNT(*) open FROM alerts WHERE resolved=0');
  return {
    total: withS.length,
    ok: count('OK'), low: count('LOW'), empty: count('EMPTY'),
    offline: count('OFFLINE'), disabled: count('DISABLED'),
    today_liters: dayRow.ml / 1000,
    today_dispenses: dayRow.n,
    open_alerts: open,
  };
}

// usage per day for the last N days, zero-filled
async function usageDaily(days) {
  const [rows] = await pool.query(
    `SELECT DATE(created_at) d, SUM(volume_ml)/1000 liters FROM dispense_events
     WHERE created_at >= CURDATE() - INTERVAL ? DAY GROUP BY DATE(created_at)`, [days - 1]);
  const map = new Map(rows.map(r => [new Date(r.d).toLocaleDateString('en-CA'), +r.liters]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(Date.now() - i * 864e5).toLocaleDateString('en-CA');
    out.push({ date: key, liters: Math.round((map.get(key) || 0) * 100) / 100 });
  }
  return out;
}

// usage per hour of today
async function usageHourly() {
  const [rows] = await pool.query(
    `SELECT HOUR(created_at) h, SUM(volume_ml)/1000 liters FROM dispense_events
     WHERE created_at >= CURDATE() GROUP BY HOUR(created_at)`);
  const map = new Map(rows.map(r => [r.h, +r.liters]));
  return Array.from({ length: 24 }, (_, h) => ({ hour: h, liters: Math.round((map.get(h) || 0) * 100) / 100 }));
}

async function alertList(all) {
  const where = all ? '' : 'WHERE a.resolved=0';
  const [rows] = await pool.query(
    `SELECT a.*, d.name AS dispenser_name FROM alerts a JOIN dispensers d ON d.id=a.dispenser_id
     ${where} ORDER BY a.created_at DESC LIMIT 100`);
  return rows;
}

module.exports = { stats, usageDaily, usageHourly, alertList };
