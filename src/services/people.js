const { pool, tx } = require('../db');

// A caretaker or technician is leaving that job (demoted or deleted): hand their work back so nothing is orphaned.
async function releaseUser(conn, username, role) {
  if (role === 'caretaker')
    await conn.query('UPDATE dispensers SET caretaker_username=NULL WHERE caretaker_username=?', [username]);
  if (role === 'technician') {
    const [rows] = await conn.query("SELECT id FROM complaints WHERE technician=? AND status IN ('ASSIGNED','IN_PROGRESS')", [username]);
    for (const { id } of rows) {
      await conn.query("UPDATE complaints SET status='OPEN', technician=NULL WHERE id=?", [id]);
      await conn.query("INSERT INTO complaint_events (complaint_id, actor, action, note) VALUES (?,NULL,'REOPENED',?)",
        [id, `Technician ${username} is no longer available; needs a new assignment`]);
    }
  }
}

async function changeRole(username, newRole) {
  return tx(async conn => {
    const [[u]] = await conn.query('SELECT role FROM users WHERE username=? FOR UPDATE', [username]);
    if (!u) return false;
    if (u.role !== newRole) await releaseUser(conn, username, u.role);
    await conn.query('UPDATE users SET role=? WHERE username=?', [newRole, username]);
    return true;
  });
}

async function deleteUser(username) {
  return tx(async conn => {
    const [[u]] = await conn.query('SELECT role FROM users WHERE username=? FOR UPDATE', [username]);
    if (!u) return false;
    await releaseUser(conn, username, u.role);
    await conn.query('DELETE FROM users WHERE username=?', [username]);
    return true;
  });
}

const emailsOf = async (where, params = []) =>
  (await pool.query(`SELECT username, email FROM users WHERE email IS NOT NULL AND (${where})`, params))[0];

module.exports = { releaseUser, changeRole, deleteUser, emailsOf };
