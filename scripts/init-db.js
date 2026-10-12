// Creates the schema and (if empty) seeds sample dispensers + 7 days of history.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { hashPassword } = require('../auth');
const { dbConfig } = require('../db-config');

(async () => {
  const cfg = dbConfig();
  const { database, ...server } = cfg;

  // Connect to the database directly (hosted DBs often forbid CREATE DATABASE); create it only if missing.
  let conn;
  try {
    conn = await mysql.createConnection({ ...cfg, multipleStatements: true });
  } catch (e) {
    if (e.code !== 'ER_BAD_DB_ERROR') throw e;
    const root = await mysql.createConnection(server);
    await root.query(`CREATE DATABASE \`${database}\``);
    await root.end();
    conn = await mysql.createConnection({ ...cfg, multipleStatements: true });
  }

  // schema.sql starts with CREATE DATABASE / USE for convenience; we're already connected, so drop those lines
  const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8')
    .replace(/^CREATE DATABASE.*$/m, '').replace(/^USE .*$/m, '');
  await conn.query(schema);

  // migration: databases created before password reset existed have no email column
  const [cols] = await conn.query("SHOW COLUMNS FROM users LIKE 'email'");
  if (!cols.length) {
    await conn.query('ALTER TABLE users ADD COLUMN email VARCHAR(120) NULL UNIQUE AFTER username');
    console.log('Migrated: added users.email');
  }

  const [[{ n }]] = await conn.query('SELECT COUNT(*) n FROM dispensers');
  if (n === 0 && process.env.SEED_DEMO !== 'false') { // set SEED_DEMO=false in production to start empty
    const seed = [
      ['Lobby Dispenser', 'Main Building - Lobby', 20, 17.5, 8.2],
      ['Library Dispenser', 'Library - 2nd Floor', 20, 11.0, 9.0],
      ['Cafeteria Dispenser', 'Cafeteria', 30, 4.2, 10.5],
      ['Gym Dispenser', 'Sports Complex', 30, 25.0, 7.8],
      ['Lab Dispenser', 'Science Block - Lab 3', 20, 14.3, 8.9],
    ];
    for (const [name, loc, cap, lvl, temp] of seed) {
      const [r] = await conn.query(
        'INSERT INTO dispensers (name, location, capacity_l, level_l, temperature_c, last_seen) VALUES (?,?,?,?,?,NOW())',
        [name, loc, cap, lvl, temp]);
      // 7 days of random dispense history
      const rows = [];
      for (let d = 0; d < 7; d++) {
        const count = 20 + Math.floor(Math.random() * 40);
        for (let i = 0; i < count; i++) {
          const hour = 7 + Math.floor(Math.random() * 13);
          const min = Math.floor(Math.random() * 60);
          const when = new Date(); when.setDate(when.getDate() - d); when.setHours(hour, min, 0, 0);
          if (when <= new Date()) // never create events in the future
            rows.push([r.insertId, [250, 330, 500, 750][Math.floor(Math.random() * 4)], when]);
        }
      }
      await conn.query('INSERT INTO dispense_events (dispenser_id, volume_ml, created_at) VALUES ?', [rows]);
    }
    console.log(`Seeded ${seed.length} dispensers.`);
  }
  // Demo level history (last 24 h, every 15 min) so charts aren't empty
  const [[{ h }]] = await conn.query('SELECT COUNT(*) h FROM level_readings');
  if (h === 0) {
    const [ds] = await conn.query('SELECT id, capacity_l, level_l, temperature_c FROM dispensers');
    const rows = [];
    for (const d of ds) {
      let level = Math.min(d.capacity_l, Number(d.level_l) + 6 + Math.random() * 4); // walk forward to "now"
      const pts = [];
      for (let i = 0; i < 96; i++) {
        level -= Math.random() * 0.15;
        if (level < d.capacity_l * 0.12) level = d.capacity_l * (0.85 + Math.random() * 0.1); // refilled
        pts.push(level);
      }
      pts.reverse(); // oldest first; scale so the newest point lands on the current level
      const shift = Number(d.level_l) - pts[pts.length - 1];
      pts.forEach((v, i) => rows.push([d.id, Math.max(0, Math.min(d.capacity_l, v + shift * (i / 95))).toFixed(2),
        (Number(d.temperature_c ?? 9) + Math.sin(i / 8) * 0.8).toFixed(1), new Date(Date.now() - (95 - i) * 15 * 6e4)]));
    }
    if (rows.length) await conn.query('INSERT INTO level_readings (dispenser_id, level_l, temperature_c, created_at) VALUES ?', [rows]);
    console.log('Seeded level history.');
  }

  // Optional first admin from env (used by Docker): only if there are no users yet.
  const [[{ u }]] = await conn.query('SELECT COUNT(*) u FROM users');
  if (u === 0 && process.env.ADMIN_PASSWORD) {
    if (process.env.ADMIN_PASSWORD.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters');
    await conn.query('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)',
      [process.env.ADMIN_USERNAME || 'admin', hashPassword(process.env.ADMIN_PASSWORD), 'admin']);
    console.log(`Created admin user "${process.env.ADMIN_USERNAME || 'admin'}".`);
  }
  // Recovery switch: ADMIN_RESET=true makes the admin account (ADMIN_USERNAME) exist with ADMIN_PASSWORD,
  // creating it or overwriting its password. Use once, then remove the variable.
  if (process.env.ADMIN_RESET === 'true') {
    const name = process.env.ADMIN_USERNAME || 'admin', pw = process.env.ADMIN_PASSWORD || '';
    if (pw.length < 8) throw new Error('ADMIN_RESET needs ADMIN_PASSWORD of at least 8 characters');
    await conn.query(
      "INSERT INTO users (username, password_hash, role) VALUES (?,?,'admin') ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), role='admin'",
      [name, hashPassword(pw)]);
    console.log(`ADMIN_RESET: "${name}" now has the password from ADMIN_PASSWORD. Remove ADMIN_RESET from your variables.`);
  }
  console.log('Database ready.');
  await conn.end();
})().catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
