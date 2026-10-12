// Creates the schema and (if empty) seeds sample dispensers + 7 days of history.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: +(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });
  await conn.query(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  await conn.query(`USE \`${process.env.DB_NAME || 'smart_water'}\``);

  const [[{ n }]] = await conn.query('SELECT COUNT(*) n FROM dispensers');
  if (n === 0) {
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
          rows.push([r.insertId, [250, 330, 500, 750][Math.floor(Math.random() * 4)],
            new Date(Date.now() - d * 864e5 - (new Date().getHours() - hour) * 36e5 - min * 6e4)]);
        }
      }
      await conn.query('INSERT INTO dispense_events (dispenser_id, volume_ml, created_at) VALUES ?', [rows]);
    }
    console.log(`Seeded ${seed.length} dispensers.`);
  }
  console.log('Database ready.');
  await conn.end();
})().catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
