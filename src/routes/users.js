const express = require('express');
const auth = require('../../auth');
const { pool } = require('../db');
const { HttpError, wrap } = require('../http');
const { USERNAME_RE, checkPassword, checkEmail, insertUser } = require('./auth');
const { isRole, ROLES } = require('../roles');
const people = require('../services/people');

const r = express.Router();

// ---------- user management ----------
r.get('/api/users', auth.requireAdmin, wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT username, email, role, created_at FROM users ORDER BY created_at, username');
  res.json(rows);
}));

r.post('/api/users', auth.requireAdmin, wrap(async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!USERNAME_RE.test(username || '')) throw new HttpError(400, 'Username must be 3-30 letters, numbers, . _ -');
  if (!isRole(role)) throw new HttpError(400, `Role must be one of: ${ROLES.join(', ')}`);
  checkPassword(password);
  await insertUser(username, auth.hashPassword(password), role, checkEmail(req.body?.email));
  res.status(201).json({ username, role });
}));

r.delete('/api/users/:username', auth.requireAdmin, wrap(async (req, res) => {
  if (req.params.username === req.user.username) throw new HttpError(400, "You can't delete your own account");
  if (!await people.deleteUser(req.params.username)) throw new HttpError(404, 'User not found');
  res.status(204).end();
}));

r.put('/api/users/:username/role', auth.requireAdmin, wrap(async (req, res) => {
  const role = req.body?.role;
  if (!isRole(role)) throw new HttpError(400, `Role must be one of: ${ROLES.join(', ')}`);
  if (req.params.username === req.user.username) throw new HttpError(400, "You can't change your own role");
  if (!await people.changeRole(req.params.username, role)) throw new HttpError(404, 'User not found');
  res.json({ username: req.params.username, role });
}));

// Technicians a caretaker can hand work to, with how many open jobs each already has.
r.get('/api/technicians', auth.requireRole('caretaker'), wrap(async (req, res) => {
  const [rows] = await pool.query(`
    SELECT u.username, u.email, COALESCE(j.n, 0) AS open_jobs
    FROM users u
    LEFT JOIN (SELECT technician, COUNT(*) n FROM complaints WHERE status IN ('ASSIGNED','IN_PROGRESS') GROUP BY technician) j ON j.technician = u.username
    WHERE u.role='technician' ORDER BY open_jobs, u.username`);
  res.json(rows);
}));

module.exports = r;
