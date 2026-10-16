const { pool } = require('../db');
const { sendMail } = require('../../mailer');

const COOLDOWN_MS = +(process.env.ALERT_COOLDOWN_MIN || 30) * 60e3;
const lastSent = new Map(); // "dispenserId:type" -> timestamp, so a flapping sensor can't flood inboxes

const TITLES = { EMPTY: 'is empty', LOW_LEVEL: 'is running low', HIGH_TEMP: 'is too warm', OFFLINE: 'went offline' };

// Email every admin who has an address on file about a newly opened alert. Set ALERT_EMAILS=false to turn off.
async function notifyAlert(dispenserId, dispenserName, type, message) {
  if ((process.env.ALERT_EMAILS ?? 'true').toLowerCase() === 'false') return;
  const key = `${dispenserId}:${type}`;
  if (Date.now() - (lastSent.get(key) ?? 0) < COOLDOWN_MS) return;
  lastSent.set(key, Date.now());
  const [admins] = await pool.query("SELECT email FROM users WHERE role='admin' AND email IS NOT NULL");
  const base = (process.env.BASE_URL || '').replace(/\/+$/, '');
  for (const { email } of admins) {
    try {
      await sendMail({
        to: email,
        subject: `[Smart Water] ${dispenserName} ${TITLES[type] ?? 'needs attention'}`,
        text: `${message}\n\n${base ? `Open the dashboard: ${base}/\n\n` : ''}You get this because you are an administrator. Set ALERT_EMAILS=false on the server to stop these emails.`,
      });
    } catch (e) { console.error('alert email failed:', e.message); }
  }
}

module.exports = { notifyAlert };
