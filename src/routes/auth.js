const crypto = require('crypto');
const express = require('express');
const auth = require('../../auth');
const { sendMail } = require('../../mailer');
const { PORT, signupEnabled } = require('../config');
const { pool, tx } = require('../db');
const { HttpError, wrap } = require('../http');

const r = express.Router();

// ---------- auth ----------
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,30}$/;
const checkPassword = pw => {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 100)
    throw new HttpError(400, 'Password must be 8-100 characters');
  return pw;
};

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
// optional email: returns null when blank, lower-cased address when valid
const checkEmail = v => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 120 || !EMAIL_RE.test(v.trim())) throw new HttpError(400, 'Enter a valid email address');
  return v.trim().toLowerCase();
};
async function insertUser(username, passwordHash, role, email) {
  try {
    await pool.query('INSERT INTO users (username, email, password_hash, role) VALUES (?,?,?,?)', [username, email, passwordHash, role]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY')
      throw new HttpError(409, /email/.test(e.sqlMessage || '') ? 'That email is already registered' : 'That username is already taken');
    throw e;
  }
}

r.get('/api/auth/config', (req, res) => res.json({ signup: signupEnabled() }));

// Public self-registration. Always creates a read-only 'viewer'; the role can't be chosen by the caller.
r.post('/api/auth/register', wrap(async (req, res) => {
  if (!signupEnabled()) throw new HttpError(403, 'Sign-up is disabled. Ask an administrator for an account.');
  if (auth.signupLimiter.blocked(req.ip)) throw new HttpError(429, 'Too many sign-ups from this address. Try again later.');
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username))
    throw new HttpError(400, 'Username must be 3-30 letters, numbers, . _ -');
  checkPassword(password);
  const email = checkEmail(req.body?.email);
  auth.signupLimiter.record(req.ip);
  const password_hash = auth.hashPassword(password);
  await insertUser(username, password_hash, 'viewer', email);
  auth.setSession(res, { username, role: 'viewer', password_hash });
  res.status(201).json({ username, role: 'viewer' });
}));

r.post('/api/auth/login', wrap(async (req, res) => {
  const ip = req.ip;
  if (auth.throttled(ip)) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
  const { username, password } = req.body || {};
  const [rows] = typeof username === 'string' && typeof password === 'string'
    ? await pool.query('SELECT * FROM users WHERE username=?', [username]) : [[]];
  const u = rows[0];
  if (!u || !auth.verifyPassword(password, u.password_hash)) {
    auth.recordFail(ip);
    throw new HttpError(401, 'Invalid username or password');
  }
  auth.setSession(res, u);
  res.json({ username: u.username, role: u.role });
}));
r.post('/api/auth/logout', (req, res) => { auth.clearSession(res); res.json({ ok: true }); });
r.get('/api/auth/me', auth.requireAuth, (req, res) => res.json(req.user));

// Account email (used for password reset)
r.put('/api/auth/email', auth.requireAuth, wrap(async (req, res) => {
  const email = checkEmail(req.body?.email);
  try {
    await pool.query('UPDATE users SET email=? WHERE username=?', [email, req.user.username]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'That email is already registered');
    throw e;
  }
  res.json({ email });
}));

// ---------- password reset ----------
const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const baseUrl = () => (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, ''); // never trust the Host header here

r.post('/api/auth/forgot', wrap(async (req, res) => {
  if (auth.forgotLimiter.blocked(req.ip)) throw new HttpError(429, 'Too many requests. Try again later.');
  const id = typeof req.body?.identifier === 'string' ? req.body.identifier.trim().toLowerCase() : '';
  if (!id) throw new HttpError(400, 'Enter your username or email');
  auth.forgotLimiter.record(req.ip);

  const [rows] = await pool.query('SELECT username, email FROM users WHERE (username=? OR email=?) AND email IS NOT NULL LIMIT 1', [id, id]);
  if (rows[0]) {
    const token = crypto.randomBytes(32).toString('hex'); // only its hash is stored
    await tx(async conn => {
      await conn.query('DELETE FROM password_resets WHERE username=?', [rows[0].username]);
      await conn.query('INSERT INTO password_resets (username, token_hash, expires_at) VALUES (?,?, NOW() + INTERVAL 1 HOUR)',
        [rows[0].username, sha256(token)]);
    });
    try {
      await sendMail({
        to: rows[0].email,
        subject: 'Reset your Smart Water Dispenser password',
        text: `Hi ${rows[0].username},\n\nUse this link to choose a new password (valid for 1 hour, works once):\n\n${baseUrl()}/login.html#reset=${token}\n\nIf you didn't ask for this, you can ignore this email.`,
      });
    } catch (e) { console.error('reset email failed:', e.message); }
  }
  // identical answer whether or not the account exists, so this can't be used to find usernames/emails
  res.json({ ok: true, message: 'If that account has an email address on file, a reset link is on its way.' });
}));

r.post('/api/auth/reset', wrap(async (req, res) => {
  const { token, password } = req.body || {};
  checkPassword(password);
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new HttpError(400, 'This reset link is invalid or has expired');
  await tx(async conn => {
    const [rows] = await conn.query('SELECT username FROM password_resets WHERE token_hash=? AND expires_at > NOW() FOR UPDATE', [sha256(token)]);
    if (!rows[0]) throw new HttpError(400, 'This reset link is invalid or has expired');
    await conn.query('UPDATE users SET password_hash=? WHERE username=?', [auth.hashPassword(password), rows[0].username]);
    await conn.query('DELETE FROM password_resets WHERE username=?', [rows[0].username]); // single use
  });
  res.json({ ok: true });
}));


r.post('/api/auth/password', auth.requireAuth, wrap(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  checkPassword(new_password);
  const [rows] = await pool.query('SELECT * FROM users WHERE username=?', [req.user.username]);
  if (!rows[0] || typeof current_password !== 'string' || !auth.verifyPassword(current_password, rows[0].password_hash))
    throw new HttpError(401, 'Current password is incorrect');
  const password_hash = auth.hashPassword(new_password);
  await pool.query('UPDATE users SET password_hash=? WHERE username=?', [password_hash, req.user.username]);
  auth.setSession(res, { username: req.user.username, role: req.user.role, password_hash }); // keep this device signed in; all others are signed out
  res.json({ ok: true });
}));

module.exports = { router: r, USERNAME_RE, checkPassword, checkEmail, insertUser };
