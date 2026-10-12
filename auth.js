// Password hashing (scrypt) and stateless signed-cookie sessions. No external dependencies.
const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET not set: logins will reset on every restart.');
const SESSION_HOURS = 12;
const COOKIE = 'sid';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}

function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const a = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const sign = payload => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

function makeToken(user) {
  const payload = Buffer.from(JSON.stringify({
    u: user.username, r: user.role, exp: Date.now() + SESSION_HOURS * 3600e3,
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return d.exp > Date.now() ? { username: d.u, role: d.r } : null;
  } catch { return null; }
}

function cookieFrom(req, name) {
  const m = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

function setSession(res, user) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${makeToken(user)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`);
}
const clearSession = res => res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);

const requireAuth = (req, res, next) => {
  const user = readToken(cookieFrom(req, COOKIE));
  if (!user) return res.status(401).json({ error: 'Login required' });
  req.user = user;
  next();
};
const requireAdmin = (req, res, next) =>
  requireAuth(req, res, () =>
    req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }));

// tiny in-memory login throttle: 8 failures per IP per 10 minutes
const fails = new Map();
const throttled = ip => (fails.get(ip) || []).filter(t => Date.now() - t < 600e3).length >= 8;
const recordFail = ip => fails.set(ip, [...(fails.get(ip) || []).filter(t => Date.now() - t < 600e3), Date.now()]);

module.exports = { hashPassword, verifyPassword, setSession, clearSession, requireAuth, requireAdmin, readToken, cookieFrom, throttled, recordFail, COOKIE };
