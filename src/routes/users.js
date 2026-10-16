const express = require('express');
const auth = require('../../auth');
const { pool } = require('../db');
const { HttpError, wrap } = require('../http');
const { USERNAME_RE, checkPassword, checkEmail, insertUser } = require('./auth');

const r = express.Router();

// ---------- user management ----------
r.get('/api/users', auth.requireAdmin, wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT username, email, role, created_at FROM users ORDER BY created_at, username');
  res.json(rows);
}));

r.post('/api/users', auth.requireAdmin, wrap(async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!USERNAME_RE.test(username || '')) throw new HttpError(400, 'Username must be 3-30 letters, numbers, . _ -');
  if (!['admin', 'viewer'].includes(role)) throw new HttpError(400, 'Role must be admin or viewer');
  checkPassword(password);
  await insertUser(username, auth.hashPassword(password), role, checkEmail(req.body?.email));
  res.status(201).json({ username, role });
}));

r.delete('/api/users/:username', auth.requireAdmin, wrap(async (req, res) => {
  if (req.params.username === req.user.username) throw new HttpError(400, "You can't delete your own account");
  const [r] = await pool.query('DELETE FROM users WHERE username=?', [req.params.username]);
  if (!r.affectedRows) throw new HttpError(404, 'User not found');
  res.status(204).end();
}));

r.put('/api/users/:username/role', auth.requireAdmin, wrap(async (req, res) => {
  const role = req.body?.role;
  if (!['admin', 'viewer'].includes(role)) throw new HttpError(400, 'Role must be admin or viewer');
  if (req.params.username === req.user.username) throw new HttpError(400, "You can't change your own role");
  const [r] = await pool.query('UPDATE users SET role=? WHERE username=?', [role, req.params.username]);
  if (!r.affectedRows) throw new HttpError(404, 'User not found');
  res.json({ username: req.params.username, role });
}));

module.exports = r;
