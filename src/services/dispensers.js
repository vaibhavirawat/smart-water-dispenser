const { OFFLINE_AFTER_MIN, LOW_LEVEL_PCT, HIGH_TEMP_C } = require('../config');
const { pool } = require('../db');
const { HttpError } = require('../http');

const lowThreshold = d => d.low_level_pct ?? LOW_LEVEL_PCT; // per-dispenser override, else the global default
const hotThreshold = d => d.high_temp_c ?? HIGH_TEMP_C;

// status is derived, not stored, so it can never go stale
function withStatus(d) {
  const pct = d.capacity_l > 0 ? (d.level_l / d.capacity_l) * 100 : 0;
  const ageMin = d.last_seen ? (Date.now() - new Date(d.last_seen).getTime()) / 60000 : Infinity;
  let status = 'OK';
  if (!d.enabled) status = 'DISABLED';
  else if (ageMin > OFFLINE_AFTER_MIN) status = 'OFFLINE';
  else if (d.level_l <= 0) status = 'EMPTY';
  else if (pct < lowThreshold(d)) status = 'LOW';
  const out = {
    ...d, enabled: !!d.enabled, level_pct: Math.round(pct * 10) / 10, status,
    effective_low_pct: lowThreshold(d), effective_high_temp_c: hotThreshold(d),
  };
  if (d.used_24h_ml !== undefined) { // forecast from the last 24 h of draws (list queries only)
    const perHour = d.used_24h_ml / 24;
    out.avg_ml_per_hour = Math.round(perHour);
    out.hours_to_empty = d.enabled && perHour > 0 && d.level_l > 0 ? Math.round((d.level_l * 1000 / perHour) * 10) / 10 : null;
  }
  return out;
}

async function getDispenser(conn, id, lock = false) {
  const [rows] = await conn.query(`SELECT * FROM dispensers WHERE id=? ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!rows.length) throw new HttpError(404, 'Dispenser not found');
  return rows[0];
}

// Dispensers with today's usage and a time-to-empty forecast, status derived. Pass an id for just one.
async function listDispensers(id) {
  const [rows] = await pool.query(`
    SELECT d.*, COALESCE(t.ml, 0) AS today_ml, COALESCE(u.ml, 0) AS used_24h_ml
    FROM dispensers d
    LEFT JOIN (SELECT dispenser_id, SUM(volume_ml) ml FROM dispense_events
               WHERE created_at >= CURDATE() GROUP BY dispenser_id) t ON t.dispenser_id = d.id
    LEFT JOIN (SELECT dispenser_id, SUM(volume_ml) ml FROM dispense_events
               WHERE created_at >= NOW() - INTERVAL 24 HOUR GROUP BY dispenser_id) u ON u.dispenser_id = d.id
    ${id === undefined ? '' : 'WHERE d.id = ?'}
    ORDER BY d.id`, id === undefined ? [] : [id]);
  if (id !== undefined && !rows.length) throw new HttpError(404, 'Dispenser not found');
  return rows.map(withStatus);
}

module.exports = { withStatus, getDispenser, listDispensers, lowThreshold, hotThreshold };
