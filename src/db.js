const mysql = require('mysql2/promise');
const { dbConfig } = require('../db-config');

const pool = mysql.createPool({
  ...dbConfig(),
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true,
  dateStrings: false,
});

// Run fn inside a transaction on a dedicated connection. Callbacks pushed to conn.afterCommit run
// once the transaction has committed (used to send emails only for alerts that really got saved).
async function tx(fn) {
  const conn = await pool.getConnection();
  conn.afterCommit = [];
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    for (const cb of conn.afterCommit) Promise.resolve().then(cb).catch(e => console.error('after-commit hook failed:', e.message));
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = { pool, tx };
