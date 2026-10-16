const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, PW, DEVICE } = require('./helpers');

let base, admin, makeClient;
const { pool } = setup('recovery', c => ({ base, admin, makeClient } = c));
// ---------- email + password reset ----------
const { outbox } = require('../mailer');
const lastToken = () => outbox[outbox.length - 1].text.match(/#reset=([a-f0-9]{64})/)[1];

test('email is optional, validated, lower-cased and unique', async () => {
  const ok = await makeClient().post('/api/auth/register', { username: 'mailer1', password: 'Mailer-Pass1', email: ' Mailer1@Example.COM ' });
  assert.equal(ok.status, 201);
  const [rows] = await pool.query("SELECT email FROM users WHERE username='mailer1'");
  assert.equal(rows[0].email, 'mailer1@example.com');
  for (const email of ['nope', 'a@b', 'a b@c.com', 123, 'x'.repeat(130) + '@a.com'])
    assert.equal((await makeClient().post('/api/auth/register', { username: 'mailer2', password: 'Mailer-Pass1', email })).status, 400, String(email));
  assert.equal((await makeClient().post('/api/auth/register', { username: 'mailer3', password: 'Mailer-Pass1', email: 'MAILER1@example.com' })).status, 409);
  assert.equal((await makeClient().post('/api/auth/register', { username: 'noemail', password: 'Mailer-Pass1' })).status, 201);
});

test('admin can add a user with an email and see it in the list', async () => {
  assert.equal((await admin.post('/api/users', { username: 'staff1', password: 'Staff-Pass12', role: 'viewer', email: 'staff1@example.com' })).status, 201);
  assert.equal((await admin.get('/api/users')).body.find(u => u.username === 'staff1').email, 'staff1@example.com');
});

test('logged-in users can set their email', async () => {
  const c = makeClient(); await c.login('viewer');
  assert.equal((await c.put('/api/auth/email', { email: 'viewer@example.com' })).status, 200);
  assert.equal((await c.get('/api/auth/me')).body.email, 'viewer@example.com');
  assert.equal((await c.put('/api/auth/email', { email: 'bad' })).status, 400);
  assert.equal((await makeClient().put('/api/auth/email', { email: 'x@y.com' })).status, 401);
});

test('forgot password gives the same answer for unknown, email-less and real accounts', async () => {
  const before = outbox.length;
  const a = await makeClient().post('/api/auth/forgot', { identifier: 'nobody-here' });
  const b = await makeClient().post('/api/auth/forgot', { identifier: 'noemail' });   // exists but no email
  const c = await makeClient().post('/api/auth/forgot', { identifier: 'mailer1' });   // real
  assert.equal(a.status, 200); assert.deepEqual(a.body, b.body); assert.deepEqual(b.body, c.body);
  assert.equal(outbox.length, before + 1, 'only the real account gets an email');
  assert.equal(outbox.at(-1).to, 'mailer1@example.com');
  assert.equal((await makeClient().post('/api/auth/forgot', { identifier: '' })).status, 400);
  assert.equal((await makeClient().post('/api/auth/forgot', { identifier: ['x'] })).status, 400);
});

test('reset link uses BASE_URL, never the Host header, and works by email too', async () => {
  const r = await fetch(base + '/api/auth/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'evil.test' },
    body: JSON.stringify({ identifier: 'MAILER1@example.com' }) });
  assert.equal(r.status, 200);
  assert.match(outbox.at(-1).text, /https:\/\/water\.example\.test\/login\.html#reset=[a-f0-9]{64}/);
  assert.ok(!outbox.at(-1).text.includes('evil.test'));
});

test('reset: sets the new password, link is single-use, tokens are stored hashed', async () => {
  await makeClient().post('/api/auth/forgot', { identifier: 'mailer1' });
  const token = lastToken();
  const [stored] = await pool.query('SELECT token_hash FROM password_resets');
  assert.ok(stored.every(r => r.token_hash !== token), 'raw token is never stored');

  assert.equal((await makeClient().post('/api/auth/reset', { token, password: 'short' })).status, 400);
  assert.equal((await makeClient().post('/api/auth/reset', { token, password: 'Brand-New-Pass1' })).status, 200);
  assert.equal((await makeClient().login('mailer1', 'Mailer-Pass1')).status, 401, 'old password dead');
  assert.equal((await makeClient().login('mailer1', 'Brand-New-Pass1')).status, 200);
  assert.equal((await makeClient().post('/api/auth/reset', { token, password: 'Another-Pass12' })).status, 400, 'second use refused');
});

test('reset: expired, malformed and superseded tokens are refused', async () => {
  await makeClient().post('/api/auth/forgot', { identifier: 'mailer1' });
  const first = lastToken();
  await makeClient().post('/api/auth/forgot', { identifier: 'mailer1' });
  const second = lastToken();
  assert.equal((await makeClient().post('/api/auth/reset', { token: first, password: 'Whatever-Pass1' })).status, 400, 'newer request replaces older');

  await pool.query("UPDATE password_resets SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE username='mailer1'");
  assert.equal((await makeClient().post('/api/auth/reset', { token: second, password: 'Whatever-Pass1' })).status, 400, 'expired');

  for (const token of ['', 'abc', 'g'.repeat(64), null, 42, "' OR 1=1 --"])
    assert.equal((await makeClient().post('/api/auth/reset', { token, password: 'Whatever-Pass1' })).status, 400, String(token));
});

test('changing or resetting a password signs out every other session', async () => {
  await admin.post('/api/users', { username: 'sess_user', password: 'Sess-Pass-123', role: 'viewer', email: 'sess@example.com' });
  const phone = makeClient(), laptop = makeClient();
  await phone.login('sess_user', 'Sess-Pass-123'); await laptop.login('sess_user', 'Sess-Pass-123');
  assert.equal((await phone.get('/api/dispensers')).status, 200);

  // change on laptop: laptop stays signed in, phone is signed out
  assert.equal((await laptop.post('/api/auth/password', { current_password: 'Sess-Pass-123', new_password: 'Sess-Pass-456' })).status, 200);
  assert.equal((await laptop.get('/api/dispensers')).status, 200);
  assert.equal((await phone.get('/api/dispensers')).status, 401);

  // reset: laptop session dies too
  await makeClient().post('/api/auth/forgot', { identifier: 'sess@example.com' });
  await makeClient().post('/api/auth/reset', { token: lastToken(), password: 'Sess-Pass-789' });
  assert.equal((await laptop.get('/api/dispensers')).status, 401);
});

// ---------- hardening ----------
test('security headers are set and the app does not advertise Express', async () => {
  const r = await fetch(base + '/login.html');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal(r.headers.get('strict-transport-security'), null, 'no HSTS over plain http');
});

test('cross-origin requests get no CORS permission', async () => {
  const r = await fetch(base + '/api/health', { headers: { Origin: 'https://evil.test' } });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('COOKIE_SECURE adds the Secure flag and HSTS', async () => {
  const login = () => fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'viewer', password: PW }) });
  let r = await login();
  assert.ok(!/;\s*Secure/i.test(r.headers.get('set-cookie')));
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  process.env.COOKIE_SECURE = 'true';
  try {
    r = await login();
    assert.match(r.headers.get('set-cookie'), /; Secure/);
    assert.match((await fetch(base + '/api/health')).headers.get('strict-transport-security'), /max-age=/);
  } finally { delete process.env.COOKIE_SECURE; }
});

test('db-config understands URLs and hosted-provider variables', () => {
  const { dbConfig } = require('../db-config');
  const keep = { ...process.env };
  try {
    for (const k of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) delete process.env[k];
    process.env.MYSQL_URL = 'mysql://app:p%40ss@db.example.com:3307/prod_db';
    assert.deepEqual(dbConfig(), { host: 'db.example.com', port: 3307, user: 'app', password: 'p@ss', database: 'prod_db' });
    delete process.env.MYSQL_URL;
    Object.assign(process.env, { MYSQLHOST: 'h', MYSQLPORT: '3310', MYSQLUSER: 'u', MYSQLPASSWORD: 'pw', MYSQLDATABASE: 'railway' });
    assert.deepEqual(dbConfig(), { host: 'h', port: 3310, user: 'u', password: 'pw', database: 'railway' });
    process.env.DB_NAME = 'bad name; DROP';
    assert.throws(() => dbConfig(), /Database name/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
});

test('CSP forbids inline scripts and pages ship no inline script', async () => {
  const r = await fetch(base + '/login.html');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self';/);
  for (const page of ['/login.html', '/']) {
    const html = await (await fetch(base + page)).text();
    assert.doesNotMatch(html, /<script>/, page);
  }
});

test('device key check rejects wrong keys of any length', async () => {
  const a = await admin.post('/api/dispensers', { name: 'K', location: 'x', capacity_l: 10, level_l: 5 });
  for (const key of ['', 'x', 'test-device-key-and-more', 'a'.repeat(500)])
    assert.equal((await makeClient().post(`/api/dispensers/${a.body.id}/readings`, { level_l: 4 }, { 'x-api-key': key })).status, 401);
  assert.equal((await makeClient().post(`/api/dispensers/${a.body.id}/readings`, { level_l: 4 }, DEVICE)).status, 200);
});

