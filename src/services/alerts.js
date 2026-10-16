const { OFFLINE_AFTER_MIN } = require('../config');
const { pool, tx } = require('../db');
const { lowThreshold, hotThreshold } = require('./dispensers');
const { notifyAlert } = require('./notify');

// Open an alert only if there isn't already an unresolved one (dedupe); resolve when condition clears.
async function syncAlert(conn, d, type, active, message) {
  const [rows] = await conn.query(
    'SELECT id FROM alerts WHERE dispenser_id=? AND type=? AND resolved=0 LIMIT 1 FOR UPDATE', [d.id, type]);
  if (active && !rows.length) {
    await conn.query('INSERT INTO alerts (dispenser_id, type, message) VALUES (?,?,?)', [d.id, type, message]);
    conn.afterCommit?.push(() => notifyAlert(d.id, d.name, type, message)); // emailed only if the transaction commits
  }
  else if (!active && rows.length)
    await conn.query('UPDATE alerts SET resolved=1, resolved_at=NOW() WHERE id=?', [rows[0].id]);
}

// Append a point to the level history (powers the detail chart)
const logLevel = (conn, d) =>
  conn.query('INSERT INTO level_readings (dispenser_id, level_l, temperature_c) VALUES (?,?,?)',
    [d.id, d.level_l, d.temperature_c]);

async function evaluateAlerts(conn, d) {
  const pct = (d.level_l / d.capacity_l) * 100;
  await syncAlert(conn, d, 'EMPTY', d.level_l <= 0, `${d.name} is empty`);
  await syncAlert(conn, d, 'LOW_LEVEL', d.level_l > 0 && pct < lowThreshold(d),
    `${d.name} is low (${pct.toFixed(0)}%)`);
  await syncAlert(conn, d, 'HIGH_TEMP', d.temperature_c != null && d.temperature_c > hotThreshold(d),
    `${d.name} water temperature is ${d.temperature_c}°C`);
  await syncAlert(conn, d, 'OFFLINE', false, '');
}

// Background job: raise/clear OFFLINE alerts and prune old level history.
let lastPrune = 0;
async function checkOffline() {
  try {
    if (Date.now() - lastPrune > 3600e3) { // retention cleanup is hourly, not every 30 s
      await pool.query('DELETE FROM level_readings WHERE created_at < NOW() - INTERVAL 30 DAY');
      lastPrune = Date.now();
    }
    const [rows] = await pool.query('SELECT * FROM dispensers WHERE enabled=1');
    for (const d of rows) {
      const stale = !d.last_seen || (Date.now() - new Date(d.last_seen).getTime()) / 60000 > OFFLINE_AFTER_MIN;
      await tx(conn => syncAlert(conn, d, 'OFFLINE', stale, `${d.name} has stopped reporting`));
    }
  } catch (e) {
    console.error('offline check failed:', e.message);
  }
}

module.exports = { syncAlert, evaluateAlerts, logLevel, checkOffline };
