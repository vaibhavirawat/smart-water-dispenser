const { OFFLINE_AFTER_MIN, LOW_LEVEL_PCT } = require('../config');
const { pool } = require('../db');
const { HttpError } = require('../http');

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

async function getDispenser(conn, id, lock = false) {
  const [rows] = await conn.query(`SELECT * FROM dispensers WHERE id=? ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!rows.length) throw new HttpError(404, 'Dispenser not found');
  return rows[0];
}

// All dispensers with today's usage, status derived.
async function listDispensers() {
  const [rows] = await pool.query(`
    SELECT d.*, COALESCE(t.ml, 0) AS today_ml
    FROM dispensers d
    LEFT JOIN (SELECT dispenser_id, SUM(volume_ml) ml FROM dispense_events
               WHERE created_at >= CURDATE() GROUP BY dispenser_id) t ON t.dispenser_id = d.id
    ORDER BY d.id`);
  return rows.map(withStatus);
}

module.exports = { withStatus, getDispenser, listDispensers };
