// Usage: npm run create-user -- <username> <admin|viewer> [password]
// Without a password, a random one is generated and printed once in this terminal.
require('dotenv').config();
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { hashPassword } = require('../auth');

(async () => {
  const [username, role = 'viewer', given] = process.argv.slice(2);
  if (!username || !['admin', 'viewer'].includes(role)) {
    console.error('Usage: npm run create-user -- <username> <admin|viewer> [password]'); process.exit(1);
  }
  const password = given || crypto.randomBytes(9).toString('base64url');
  if (password.length < 8) { console.error('Password must be at least 8 characters'); process.exit(1); }
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'smart_water',
  });
  await conn.query(
    'INSERT INTO users (username, password_hash, role) VALUES (?,?,?) ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), role=VALUES(role)',
    [username, hashPassword(password), role]);
  console.log(`User "${username}" (${role}) saved.`);
  if (!given) console.log(`Password: ${password}   <- shown once, store it somewhere safe`);
  await conn.end();
})().catch(e => { console.error(e.message); process.exit(1); });
