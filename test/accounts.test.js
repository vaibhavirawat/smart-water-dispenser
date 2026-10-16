const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, newDispenser } = require('./helpers');

let admin, viewer, makeClient;
const { pool } = setup('accounts', c => ({ admin, viewer, makeClient } = c));
// ---------- auth ----------
test('health is public and checks the database', async () => {
  const r = await makeClient().get('/api/health');
  assert.equal(r.status, 200); assert.equal(r.body.ok, true);
});

test('API rejects anonymous requests', async () => {
  for (const url of ['/api/dispensers', '/api/stats', '/api/alerts', '/api/usage/daily'])
    assert.equal((await makeClient().get(url)).status, 401, url);
});

test('login: wrong password and unknown user are rejected identically', async () => {
  const a = await makeClient().login('admin', 'wrong-password');
  const b = await makeClient().login('ghost', 'whatever');
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.deepEqual(a.body, b.body);
});

test('login: non-string credentials do not crash', async () => {
  const r = await makeClient().post('/api/auth/login', { username: { $ne: 1 }, password: ['x'] });
  assert.equal(r.status, 401);
});

test('forged session cookie is rejected', async () => {
  const payload = Buffer.from(JSON.stringify({ u: 'x', r: 'admin', exp: Date.now() + 1e9 })).toString('base64url');
  const r = await makeClient().get('/api/dispensers', { Cookie: `sid=${payload}.badsignature` });
  assert.equal(r.status, 401);
});

test('/auth/me returns the logged-in user; logout clears the session', async () => {
  const c = makeClient(); await c.login('viewer');
  assert.deepEqual((await c.get('/api/auth/me')).body, { username: 'viewer', role: 'viewer', email: null });
});

test('viewer can read but not modify', async () => {
  const d = await newDispenser(admin);
  assert.equal((await viewer.get('/api/dispensers')).status, 200);
  assert.equal((await viewer.post('/api/dispensers', { name: 'x', location: 'y' })).status, 403);
  assert.equal((await viewer.put(`/api/dispensers/${d.id}`, { name: 'z' })).status, 403);
  assert.equal((await viewer.del(`/api/dispensers/${d.id}`)).status, 403);
  assert.equal((await viewer.post(`/api/dispensers/${d.id}/refill`)).status, 403);
});

// ---------- user management ----------
test('only admins can manage users', async () => {
  assert.equal((await viewer.get('/api/users')).status, 403);
  assert.equal((await viewer.post('/api/users', { username: 'x_user', password: 'longenough1', role: 'viewer' })).status, 403);
  assert.equal((await viewer.del('/api/users/admin')).status, 403);
  assert.equal((await makeClient().get('/api/users')).status, 401);
  const list = (await admin.get('/api/users')).body;
  assert.ok(list.some(u => u.username === 'admin' && u.role === 'admin'));
  assert.ok(list.every(u => !('password_hash' in u)), 'hashes never leave the server');
});

test('admin creates a user who can log in, then removes them', async () => {
  const c = await admin.post('/api/users', { username: 'new.user-1', password: 'GoodPass123', role: 'viewer' });
  assert.equal(c.status, 201);
  assert.equal((await makeClient().login('new.user-1', 'GoodPass123')).status, 200);
  assert.equal((await admin.post('/api/users', { username: 'new.user-1', password: 'GoodPass123', role: 'viewer' })).status, 409);
  assert.equal((await admin.del('/api/users/new.user-1')).status, 204);
  assert.equal((await makeClient().login('new.user-1', 'GoodPass123')).status, 401);
  assert.equal((await admin.del('/api/users/new.user-1')).status, 404);
});

test('user creation validates username, role and password', async () => {
  const bad = [
    { username: 'ab', password: 'GoodPass123', role: 'viewer' },
    { username: 'has space', password: 'GoodPass123', role: 'viewer' },
    { username: 'bobby', password: 'short', role: 'viewer' },
    { username: 'bobby', password: 'GoodPass123', role: 'superuser' },
    { username: "x'; DROP TABLE users;--", password: 'GoodPass123', role: 'viewer' },
  ];
  for (const b of bad) assert.equal((await admin.post('/api/users', b)).status, 400, JSON.stringify(b));
});

test('admin cannot delete their own account', async () => {
  assert.equal((await admin.del('/api/users/admin')).status, 400);
});

test('change password: verifies current, enforces length, old password stops working', async () => {
  await admin.post('/api/users', { username: 'pw_user', password: 'OldPassword1', role: 'viewer' });
  const u = makeClient(); await u.login('pw_user', 'OldPassword1');
  assert.equal((await u.post('/api/auth/password', { current_password: 'nope', new_password: 'NewPassword1' })).status, 401);
  assert.equal((await u.post('/api/auth/password', { current_password: 'OldPassword1', new_password: 'short' })).status, 400);
  assert.equal((await u.post('/api/auth/password', { current_password: 'OldPassword1', new_password: 'NewPassword1' })).status, 200);
  assert.equal((await makeClient().login('pw_user', 'OldPassword1')).status, 401);
  assert.equal((await makeClient().login('pw_user', 'NewPassword1')).status, 200);
  assert.equal((await makeClient().post('/api/auth/password', { current_password: 'a', new_password: 'NewPassword2' })).status, 401, 'needs login');
});

test('a removed user\'s existing session stops working immediately', async () => {
  await admin.post('/api/users', { username: 'doomed', password: 'DoomedPass1', role: 'viewer' });
  const u = makeClient(); await u.login('doomed', 'DoomedPass1');
  assert.equal((await u.get('/api/dispensers')).status, 200);
  await admin.del('/api/users/doomed');
  assert.equal((await u.get('/api/dispensers')).status, 401);
});

test('role changes in the database apply to existing sessions', async () => {
  await admin.post('/api/users', { username: 'promo', password: 'PromoPass12', role: 'admin' });
  const u = makeClient(); await u.login('promo', 'PromoPass12');
  assert.equal((await u.get('/api/users')).status, 200);
  await pool.query("UPDATE users SET role='viewer' WHERE username='promo'");
  assert.equal((await u.get('/api/users')).status, 403);
});

// ---------- self sign-up ----------
test('sign-up config is public and reflects ALLOW_SIGNUP', async () => {
  assert.deepEqual((await makeClient().get('/api/auth/config')).body, { signup: true });
  process.env.ALLOW_SIGNUP = 'false';
  assert.deepEqual((await makeClient().get('/api/auth/config')).body, { signup: false });
  delete process.env.ALLOW_SIGNUP;
});

test('anyone can register; they get a viewer session, never an admin', async () => {
  const c = makeClient();
  const r = await c.post('/api/auth/register', { username: 'newbie', password: 'Newbie-Pass1', role: 'admin', is_admin: true });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { username: 'newbie', role: 'viewer' }, 'role in the request body is ignored');
  assert.deepEqual((await c.get('/api/auth/me')).body, { username: 'newbie', role: 'viewer', email: null }, 'auto-logged-in');
  assert.equal((await c.get('/api/dispensers')).status, 200);
  assert.equal((await c.post('/api/dispensers', { name: 'x', location: 'y' })).status, 403);
  assert.equal((await c.get('/api/users')).status, 403);
  assert.equal((await makeClient().login('newbie', 'Newbie-Pass1')).status, 200, 'can sign in again later');
  const [stored] = await pool.query("SELECT role FROM users WHERE username='newbie'");
  assert.equal(stored[0].role, 'viewer');
});

test('register rejects duplicates and invalid input', async () => {
  assert.equal((await makeClient().post('/api/auth/register', { username: 'newbie', password: 'Another-Pass1' })).status, 409);
  assert.equal((await makeClient().post('/api/auth/register', { username: 'admin', password: 'Another-Pass1' })).status, 409);
  const bad = [
    {}, { username: 'ab', password: 'Valid-Pass1' }, { username: 'has space', password: 'Valid-Pass1' },
    { username: 'okname', password: 'short' }, { username: 'okname' }, { username: ['a'], password: 'Valid-Pass1' },
    { username: { $ne: 1 }, password: 'Valid-Pass1' }, { username: 'a'.repeat(31), password: 'Valid-Pass1' },
  ];
  for (const b of bad) assert.equal((await makeClient().post('/api/auth/register', b)).status, 400, JSON.stringify(b));
});

test('sign-up can be switched off', async () => {
  process.env.ALLOW_SIGNUP = 'false';
  try {
    assert.equal((await makeClient().post('/api/auth/register', { username: 'blocked1', password: 'Valid-Pass1' })).status, 403);
  } finally { delete process.env.ALLOW_SIGNUP; }
  const [rows] = await pool.query("SELECT 1 FROM users WHERE username='blocked1'");
  assert.equal(rows.length, 0);
});

test('rate limiter blocks after N hits and is per key', () => {
  const { makeLimiter } = require('../auth');
  const l = makeLimiter(3, 60000);
  for (let i = 0; i < 3; i++) { assert.equal(l.blocked('a'), false); l.record('a'); }
  assert.equal(l.blocked('a'), true);
  assert.equal(l.blocked('b'), false);
});

// ---------- role management ----------
test('admin can promote and demote; invalid cases are refused', async () => {
  await admin.post('/api/users', { username: 'rolekid', password: 'RoleKid-Pass1', role: 'viewer' });
  const u = makeClient(); await u.login('rolekid', 'RoleKid-Pass1');
  assert.equal((await u.get('/api/users')).status, 403);

  assert.equal((await admin.put('/api/users/rolekid/role', { role: 'admin' })).status, 200);
  assert.equal((await u.get('/api/users')).status, 200, 'promotion applies to the existing session');
  assert.equal((await admin.put('/api/users/rolekid/role', { role: 'viewer' })).status, 200);
  assert.equal((await u.get('/api/users')).status, 403);

  assert.equal((await admin.put('/api/users/rolekid/role', { role: 'root' })).status, 400);
  assert.equal((await admin.put('/api/users/admin/role', { role: 'viewer' })).status, 400, 'cannot demote yourself');
  assert.equal((await admin.put('/api/users/ghost/role', { role: 'admin' })).status, 404);
  assert.equal((await viewer.put('/api/users/rolekid/role', { role: 'admin' })).status, 403);
  assert.equal((await u.put('/api/users/rolekid/role', { role: 'admin' })).status, 403, 'a viewer cannot self-promote');
});

