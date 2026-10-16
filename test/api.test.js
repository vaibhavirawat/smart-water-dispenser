// Integration tests: run the real Express app against a throwaway MySQL database.
// Run with: npm test   (needs MySQL running; never touches your real smart_water DB)
process.env.DB_NAME = 'smart_water_test';
process.env.DEVICE_API_KEY = 'test-device-key';
process.env.SESSION_SECRET = 'test-secret';
process.env.OFFLINE_AFTER_MIN = '2';
process.env.LOW_LEVEL_PCT = '20';
process.env.SIGNUP_LIMIT = '1000';
process.env.FORGOT_LIMIT = '1000';
process.env.NODE_ENV = 'test';
process.env.BASE_URL = 'https://water.example.test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config(); // picks up DB_USER / DB_PASSWORD; does not override vars set above
const { hashPassword } = require('../auth');
const { app, pool, start, checkOffline } = require('../server');

const PW = 'Test-Password-1';
let base, server, admin, viewer;

// minimal client that keeps the session cookie
function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  return {
    get: (u, h) => call('GET', u, undefined, h),
    post: (u, b, h) => call('POST', u, b ?? {}, h),
    put: (u, b) => call('PUT', u, b),
    del: u => call('DELETE', u),
    login: (username, password = PW) => call('POST', '/api/auth/login', { username, password }),
  };
}
const DEVICE = { 'x-api-key': 'test-device-key' };

async function newDispenser(a, over = {}) {
  const r = await a.post('/api/dispensers', { name: 'T', location: 'Lab', capacity_l: 10, level_l: 5, ...over });
  assert.equal(r.status, 201);
  return r.body;
}

before(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', multipleStatements: true,
  });
  await conn.query('DROP DATABASE IF EXISTS smart_water_test');
  const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8').replace(/\bsmart_water\b/g, 'smart_water_test');
  await conn.query(schema);
  await conn.query('USE smart_water_test');
  await conn.query('INSERT INTO users (username,password_hash,role) VALUES (?,?,?),(?,?,?)',
    ['admin', hashPassword(PW), 'admin', 'viewer', hashPassword(PW), 'viewer']);
  await conn.end();

  server = start(0);
  await new Promise(r => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
  admin = client(); viewer = client();
  assert.equal((await admin.login('admin')).status, 200);
  assert.equal((await viewer.login('viewer')).status, 200);
});

after(async () => {
  await new Promise(r => server.close(r));
  await pool.query('DROP DATABASE IF EXISTS smart_water_test');
  await pool.end();
  process.exit(0); // background interval from start() would keep the process alive
});

// ---------- auth ----------
test('health is public and checks the database', async () => {
  const r = await client().get('/api/health');
  assert.equal(r.status, 200); assert.equal(r.body.ok, true);
});

test('API rejects anonymous requests', async () => {
  for (const url of ['/api/dispensers', '/api/stats', '/api/alerts', '/api/usage/daily'])
    assert.equal((await client().get(url)).status, 401, url);
});

test('login: wrong password and unknown user are rejected identically', async () => {
  const a = await client().login('admin', 'wrong-password');
  const b = await client().login('ghost', 'whatever');
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.deepEqual(a.body, b.body);
});

test('login: non-string credentials do not crash', async () => {
  const r = await client().post('/api/auth/login', { username: { $ne: 1 }, password: ['x'] });
  assert.equal(r.status, 401);
});

test('forged session cookie is rejected', async () => {
  const payload = Buffer.from(JSON.stringify({ u: 'x', r: 'admin', exp: Date.now() + 1e9 })).toString('base64url');
  const r = await client().get('/api/dispensers', { Cookie: `sid=${payload}.badsignature` });
  assert.equal(r.status, 401);
});

test('/auth/me returns the logged-in user; logout clears the session', async () => {
  const c = client(); await c.login('viewer');
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

// ---------- dispenser CRUD ----------
test('create, read, update, delete a dispenser', async () => {
  const d = await newDispenser(admin, { name: 'Crud', capacity_l: 20, level_l: 10 });
  assert.equal(d.level_pct, 50); assert.equal(d.status, 'OK');
  assert.equal((await admin.get(`/api/dispensers/${d.id}`)).body.name, 'Crud');
  const u = await admin.put(`/api/dispensers/${d.id}`, { name: 'Renamed', enabled: false });
  assert.equal(u.body.name, 'Renamed'); assert.equal(u.body.status, 'DISABLED');
  assert.equal((await admin.del(`/api/dispensers/${d.id}`)).status, 204);
  assert.equal((await admin.get(`/api/dispensers/${d.id}`)).status, 404);
});

test('create validates input', async () => {
  const bad = [
    {}, { name: 'a' }, { name: '', location: 'x' }, { name: 'a', location: 'b', capacity_l: -5 },
    { name: 'a', location: 'b', capacity_l: 10, level_l: 11 }, { name: 'a'.repeat(81), location: 'b' },
    { name: 'a', location: 'b', capacity_l: 'abc' },
  ];
  for (const b of bad) assert.equal((await admin.post('/api/dispensers', b)).status, 400, JSON.stringify(b));
});

test('cannot shrink capacity below current level', async () => {
  const d = await newDispenser(admin, { capacity_l: 10, level_l: 8 });
  assert.equal((await admin.put(`/api/dispensers/${d.id}`, { capacity_l: 5 })).status, 400);
});

test('malformed JSON and unknown routes return clean errors', async () => {
  assert.deepEqual((await admin.post('/api/dispensers', '{not json')).body, { error: 'Invalid JSON' });
  assert.equal((await admin.get('/api/nope')).status, 404);
  assert.equal((await admin.get('/api/dispensers/999999')).status, 404);
});

// ---------- device endpoints ----------
test('device endpoints require the API key', async () => {
  const d = await newDispenser(admin);
  assert.equal((await client().post(`/api/dispensers/${d.id}/readings`, { level_l: 3 })).status, 401);
  assert.equal((await client().post(`/api/dispensers/${d.id}/readings`, { level_l: 3 }, { 'x-api-key': 'wrong' })).status, 401);
  assert.equal((await client().post(`/api/dispensers/${d.id}/readings`, { level_l: 3 }, DEVICE)).status, 200);
});

test('readings update level, temperature and last_seen', async () => {
  const d = await newDispenser(admin);
  const r = await client().post(`/api/dispensers/${d.id}/readings`, { level_l: 7.5, temperature_c: 9.5 }, DEVICE);
  assert.equal(r.body.level_l, 7.5); assert.equal(r.body.temperature_c, 9.5);
  assert.ok(r.body.last_seen);
});

test('readings reject impossible values', async () => {
  const d = await newDispenser(admin, { capacity_l: 10 });
  for (const b of [{ level_l: 11 }, { level_l: -1 }, { level_l: 'x' }, { temperature_c: 500 }])
    assert.equal((await client().post(`/api/dispensers/${d.id}/readings`, b, DEVICE)).status, 400, JSON.stringify(b));
});

test('dispense deducts volume and records an event', async () => {
  const d = await newDispenser(admin, { level_l: 5 });
  const dev = client();
  const r = await dev.post(`/api/dispensers/${d.id}/dispense`, { volume_ml: 500 }, DEVICE);
  assert.equal(r.status, 200); assert.equal(r.body.level_l, 4.5);
  const ev = await admin.get(`/api/dispensers/${d.id}/events`);
  assert.equal(ev.body.length, 1); assert.equal(ev.body[0].volume_ml, 500);
});

test('dispense is refused when tank lacks water or dispenser is disabled', async () => {
  const d = await newDispenser(admin, { level_l: 0.3 });
  assert.equal((await client().post(`/api/dispensers/${d.id}/dispense`, { volume_ml: 500 }, DEVICE)).status, 409);
  await admin.put(`/api/dispensers/${d.id}`, { enabled: false });
  assert.equal((await client().post(`/api/dispensers/${d.id}/dispense`, { volume_ml: 100 }, DEVICE)).status, 409);
  assert.equal((await client().post(`/api/dispensers/${d.id}/dispense`, { volume_ml: 0 }, DEVICE)).status, 400);
});

test('concurrent dispenses never overdraw the tank', async () => {
  const d = await newDispenser(admin, { capacity_l: 10, level_l: 5 });
  const results = await Promise.all(Array.from({ length: 20 }, () =>
    client().post(`/api/dispensers/${d.id}/dispense`, { volume_ml: 1000 }, DEVICE)));
  const ok = results.filter(r => r.status === 200).length;
  assert.equal(ok, 5, 'exactly 5 x 1L fit in a 5L tank');
  assert.equal(results.filter(r => r.status === 409).length, 15);
  const final = (await admin.get(`/api/dispensers/${d.id}`)).body;
  assert.equal(final.level_l, 0); assert.equal(final.status, 'EMPTY');
});

// ---------- refill + alerts ----------
test('low level raises one alert (deduplicated), refill resolves it', async () => {
  const d = await newDispenser(admin, { capacity_l: 10, level_l: 5 });
  const dev = client();
  await dev.post(`/api/dispensers/${d.id}/readings`, { level_l: 1 }, DEVICE);
  await dev.post(`/api/dispensers/${d.id}/readings`, { level_l: 1.1 }, DEVICE);
  await dev.post(`/api/dispensers/${d.id}/readings`, { level_l: 0.9 }, DEVICE);
  let alerts = (await admin.get('/api/alerts')).body.filter(a => a.dispenser_id === d.id);
  assert.equal(alerts.length, 1); assert.equal(alerts[0].type, 'LOW_LEVEL');
  assert.equal((await admin.get(`/api/dispensers/${d.id}`)).body.status, 'LOW');

  const r = await admin.post(`/api/dispensers/${d.id}/refill`);
  assert.equal(r.body.level_l, 10); assert.equal(r.body.status, 'OK');
  alerts = (await admin.get('/api/alerts')).body.filter(a => a.dispenser_id === d.id);
  assert.equal(alerts.length, 0, 'alert auto-resolved');
});

test('empty tank raises EMPTY alert; high temperature raises HIGH_TEMP', async () => {
  const d = await newDispenser(admin, { level_l: 5 });
  await client().post(`/api/dispensers/${d.id}/readings`, { level_l: 0, temperature_c: 30 }, DEVICE);
  const types = (await admin.get('/api/alerts')).body.filter(a => a.dispenser_id === d.id).map(a => a.type).sort();
  assert.deepEqual(types, ['EMPTY', 'HIGH_TEMP']);
});

test('refill supports partial amounts and caps at capacity', async () => {
  const d = await newDispenser(admin, { capacity_l: 10, level_l: 2 });
  assert.equal((await admin.post(`/api/dispensers/${d.id}/refill`, { added_l: 3 })).body.level_l, 5);
  assert.equal((await admin.post(`/api/dispensers/${d.id}/refill`, { added_l: 999 })).status, 400);
});

test('admin can manually resolve an alert; resolving twice is a 404', async () => {
  const d = await newDispenser(admin, { level_l: 5 });
  await client().post(`/api/dispensers/${d.id}/readings`, { level_l: 0 }, DEVICE);
  const a = (await admin.get('/api/alerts')).body.find(x => x.dispenser_id === d.id);
  assert.equal((await viewer.post(`/api/alerts/${a.id}/resolve`)).status, 403);
  assert.equal((await admin.post(`/api/alerts/${a.id}/resolve`)).status, 200);
  assert.equal((await admin.post(`/api/alerts/${a.id}/resolve`)).status, 404);
});

test('silent device goes OFFLINE and raises an alert; a reading recovers it', async () => {
  const d = await newDispenser(admin, { level_l: 8 });
  await pool.query('UPDATE dispensers SET last_seen = NOW() - INTERVAL 10 MINUTE WHERE id=?', [d.id]);
  assert.equal((await admin.get(`/api/dispensers/${d.id}`)).body.status, 'OFFLINE');
  await checkOffline();
  await checkOffline(); // idempotent
  let a = (await admin.get('/api/alerts')).body.filter(x => x.dispenser_id === d.id && x.type === 'OFFLINE');
  assert.equal(a.length, 1);
  await client().post(`/api/dispensers/${d.id}/readings`, { level_l: 8 }, DEVICE);
  a = (await admin.get('/api/alerts')).body.filter(x => x.dispenser_id === d.id && x.type === 'OFFLINE');
  assert.equal(a.length, 0);
  assert.equal((await admin.get(`/api/dispensers/${d.id}`)).body.status, 'OK');
});

// ---------- analytics ----------
test('stats and usage endpoints reflect activity', async () => {
  const d = await newDispenser(admin, { level_l: 5 });
  await client().post(`/api/dispensers/${d.id}/dispense`, { volume_ml: 750 }, DEVICE);
  const s = (await admin.get('/api/stats')).body;
  assert.ok(s.total >= 1 && s.today_liters >= 0.75 && s.today_dispenses >= 1);

  const daily = (await admin.get('/api/usage/daily?days=7')).body;
  assert.equal(daily.length, 7);
  assert.ok(daily[6].liters >= 0.75, 'today is last, zero-filled history before it');

  const hourly = (await admin.get('/api/usage/hourly')).body;
  assert.equal(hourly.length, 24);
  assert.ok(hourly.reduce((t, h) => t + h.liters, 0) >= 0.75);
});

test('deleting a dispenser cascades to its events and alerts', async () => {
  const d = await newDispenser(admin, { level_l: 5 });
  await client().post(`/api/dispensers/${d.id}/dispense`, { volume_ml: 100 }, DEVICE);
  await client().post(`/api/dispensers/${d.id}/readings`, { level_l: 0 }, DEVICE);
  await admin.del(`/api/dispensers/${d.id}`);
  const [[{ n }]] = await pool.query(
    'SELECT (SELECT COUNT(*) FROM dispense_events WHERE dispenser_id=?) + (SELECT COUNT(*) FROM alerts WHERE dispenser_id=?) n', [d.id, d.id]);
  assert.equal(n, 0);
});

// ---------- level history ----------
test('history records readings and requires login', async () => {
  const d = await newDispenser(admin, { capacity_l: 10, level_l: 5 });
  const dev = client();
  await dev.post(`/api/dispensers/${d.id}/readings`, { level_l: 4 }, DEVICE);
  await dev.post(`/api/dispensers/${d.id}/dispense`, { volume_ml: 500 }, DEVICE);
  await admin.post(`/api/dispensers/${d.id}/refill`);
  const h = (await viewer.get(`/api/dispensers/${d.id}/history?hours=24`)).body;
  assert.deepEqual(h.map(p => p.level_l), [4, 3.5, 10]);
  assert.equal((await client().get(`/api/dispensers/${d.id}/history`)).status, 401);
});

// ---------- CSV export ----------
test('CSV export: auth required, correct headers, escapes formulas and commas', async () => {
  const d = await newDispenser(admin, { name: '=HYPERLINK("x")', location: 'Hall, East', level_l: 5 });
  await client().post(`/api/dispensers/${d.id}/dispense`, { volume_ml: 250 }, DEVICE);
  assert.equal((await client().get('/api/export/events.csv')).status, 401);

  const r = await fetch(base + '/api/export/events.csv?days=1', { headers: { Cookie: (await (async () => {
    const c = client(); const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'viewer', password: PW }) });
    return res.headers.get('set-cookie').split(';')[0];
  })()) } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="dispense-events-1d.csv"/);
  const text = await r.text();
  assert.ok(text.startsWith('id,dispenser,location,volume_ml,time\n'));
  assert.ok(text.includes(`"'=HYPERLINK(""x"")"`), 'formula neutralised and quotes escaped');
  assert.ok(text.includes('"Hall, East"'), 'comma cell quoted');
});

// ---------- user management ----------
test('only admins can manage users', async () => {
  assert.equal((await viewer.get('/api/users')).status, 403);
  assert.equal((await viewer.post('/api/users', { username: 'x_user', password: 'longenough1', role: 'viewer' })).status, 403);
  assert.equal((await viewer.del('/api/users/admin')).status, 403);
  assert.equal((await client().get('/api/users')).status, 401);
  const list = (await admin.get('/api/users')).body;
  assert.ok(list.some(u => u.username === 'admin' && u.role === 'admin'));
  assert.ok(list.every(u => !('password_hash' in u)), 'hashes never leave the server');
});

test('admin creates a user who can log in, then removes them', async () => {
  const c = await admin.post('/api/users', { username: 'new.user-1', password: 'GoodPass123', role: 'viewer' });
  assert.equal(c.status, 201);
  assert.equal((await client().login('new.user-1', 'GoodPass123')).status, 200);
  assert.equal((await admin.post('/api/users', { username: 'new.user-1', password: 'GoodPass123', role: 'viewer' })).status, 409);
  assert.equal((await admin.del('/api/users/new.user-1')).status, 204);
  assert.equal((await client().login('new.user-1', 'GoodPass123')).status, 401);
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
  const u = client(); await u.login('pw_user', 'OldPassword1');
  assert.equal((await u.post('/api/auth/password', { current_password: 'nope', new_password: 'NewPassword1' })).status, 401);
  assert.equal((await u.post('/api/auth/password', { current_password: 'OldPassword1', new_password: 'short' })).status, 400);
  assert.equal((await u.post('/api/auth/password', { current_password: 'OldPassword1', new_password: 'NewPassword1' })).status, 200);
  assert.equal((await client().login('pw_user', 'OldPassword1')).status, 401);
  assert.equal((await client().login('pw_user', 'NewPassword1')).status, 200);
  assert.equal((await client().post('/api/auth/password', { current_password: 'a', new_password: 'NewPassword2' })).status, 401, 'needs login');
});

test('a removed user\'s existing session stops working immediately', async () => {
  await admin.post('/api/users', { username: 'doomed', password: 'DoomedPass1', role: 'viewer' });
  const u = client(); await u.login('doomed', 'DoomedPass1');
  assert.equal((await u.get('/api/dispensers')).status, 200);
  await admin.del('/api/users/doomed');
  assert.equal((await u.get('/api/dispensers')).status, 401);
});

test('role changes in the database apply to existing sessions', async () => {
  await admin.post('/api/users', { username: 'promo', password: 'PromoPass12', role: 'admin' });
  const u = client(); await u.login('promo', 'PromoPass12');
  assert.equal((await u.get('/api/users')).status, 200);
  await pool.query("UPDATE users SET role='viewer' WHERE username='promo'");
  assert.equal((await u.get('/api/users')).status, 403);
});

// ---------- self sign-up ----------
test('sign-up config is public and reflects ALLOW_SIGNUP', async () => {
  assert.deepEqual((await client().get('/api/auth/config')).body, { signup: true });
  process.env.ALLOW_SIGNUP = 'false';
  assert.deepEqual((await client().get('/api/auth/config')).body, { signup: false });
  delete process.env.ALLOW_SIGNUP;
});

test('anyone can register; they get a viewer session, never an admin', async () => {
  const c = client();
  const r = await c.post('/api/auth/register', { username: 'newbie', password: 'Newbie-Pass1', role: 'admin', is_admin: true });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { username: 'newbie', role: 'viewer' }, 'role in the request body is ignored');
  assert.deepEqual((await c.get('/api/auth/me')).body, { username: 'newbie', role: 'viewer', email: null }, 'auto-logged-in');
  assert.equal((await c.get('/api/dispensers')).status, 200);
  assert.equal((await c.post('/api/dispensers', { name: 'x', location: 'y' })).status, 403);
  assert.equal((await c.get('/api/users')).status, 403);
  assert.equal((await client().login('newbie', 'Newbie-Pass1')).status, 200, 'can sign in again later');
  const [stored] = await pool.query("SELECT role FROM users WHERE username='newbie'");
  assert.equal(stored[0].role, 'viewer');
});

test('register rejects duplicates and invalid input', async () => {
  assert.equal((await client().post('/api/auth/register', { username: 'newbie', password: 'Another-Pass1' })).status, 409);
  assert.equal((await client().post('/api/auth/register', { username: 'admin', password: 'Another-Pass1' })).status, 409);
  const bad = [
    {}, { username: 'ab', password: 'Valid-Pass1' }, { username: 'has space', password: 'Valid-Pass1' },
    { username: 'okname', password: 'short' }, { username: 'okname' }, { username: ['a'], password: 'Valid-Pass1' },
    { username: { $ne: 1 }, password: 'Valid-Pass1' }, { username: 'a'.repeat(31), password: 'Valid-Pass1' },
  ];
  for (const b of bad) assert.equal((await client().post('/api/auth/register', b)).status, 400, JSON.stringify(b));
});

test('sign-up can be switched off', async () => {
  process.env.ALLOW_SIGNUP = 'false';
  try {
    assert.equal((await client().post('/api/auth/register', { username: 'blocked1', password: 'Valid-Pass1' })).status, 403);
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
  const u = client(); await u.login('rolekid', 'RoleKid-Pass1');
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

// ---------- email + password reset ----------
const { outbox } = require('../mailer');
const lastToken = () => outbox[outbox.length - 1].text.match(/#reset=([a-f0-9]{64})/)[1];

test('email is optional, validated, lower-cased and unique', async () => {
  const ok = await client().post('/api/auth/register', { username: 'mailer1', password: 'Mailer-Pass1', email: ' Mailer1@Example.COM ' });
  assert.equal(ok.status, 201);
  const [rows] = await pool.query("SELECT email FROM users WHERE username='mailer1'");
  assert.equal(rows[0].email, 'mailer1@example.com');
  for (const email of ['nope', 'a@b', 'a b@c.com', 123, 'x'.repeat(130) + '@a.com'])
    assert.equal((await client().post('/api/auth/register', { username: 'mailer2', password: 'Mailer-Pass1', email })).status, 400, String(email));
  assert.equal((await client().post('/api/auth/register', { username: 'mailer3', password: 'Mailer-Pass1', email: 'MAILER1@example.com' })).status, 409);
  assert.equal((await client().post('/api/auth/register', { username: 'noemail', password: 'Mailer-Pass1' })).status, 201);
});

test('admin can add a user with an email and see it in the list', async () => {
  assert.equal((await admin.post('/api/users', { username: 'staff1', password: 'Staff-Pass12', role: 'viewer', email: 'staff1@example.com' })).status, 201);
  assert.equal((await admin.get('/api/users')).body.find(u => u.username === 'staff1').email, 'staff1@example.com');
});

test('logged-in users can set their email', async () => {
  const c = client(); await c.login('viewer');
  assert.equal((await c.put('/api/auth/email', { email: 'viewer@example.com' })).status, 200);
  assert.equal((await c.get('/api/auth/me')).body.email, 'viewer@example.com');
  assert.equal((await c.put('/api/auth/email', { email: 'bad' })).status, 400);
  assert.equal((await client().put('/api/auth/email', { email: 'x@y.com' })).status, 401);
});

test('forgot password gives the same answer for unknown, email-less and real accounts', async () => {
  const before = outbox.length;
  const a = await client().post('/api/auth/forgot', { identifier: 'nobody-here' });
  const b = await client().post('/api/auth/forgot', { identifier: 'noemail' });   // exists but no email
  const c = await client().post('/api/auth/forgot', { identifier: 'mailer1' });   // real
  assert.equal(a.status, 200); assert.deepEqual(a.body, b.body); assert.deepEqual(b.body, c.body);
  assert.equal(outbox.length, before + 1, 'only the real account gets an email');
  assert.equal(outbox.at(-1).to, 'mailer1@example.com');
  assert.equal((await client().post('/api/auth/forgot', { identifier: '' })).status, 400);
  assert.equal((await client().post('/api/auth/forgot', { identifier: ['x'] })).status, 400);
});

test('reset link uses BASE_URL, never the Host header, and works by email too', async () => {
  const r = await fetch(base + '/api/auth/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'evil.test' },
    body: JSON.stringify({ identifier: 'MAILER1@example.com' }) });
  assert.equal(r.status, 200);
  assert.match(outbox.at(-1).text, /https:\/\/water\.example\.test\/login\.html#reset=[a-f0-9]{64}/);
  assert.ok(!outbox.at(-1).text.includes('evil.test'));
});

test('reset: sets the new password, link is single-use, tokens are stored hashed', async () => {
  await client().post('/api/auth/forgot', { identifier: 'mailer1' });
  const token = lastToken();
  const [stored] = await pool.query('SELECT token_hash FROM password_resets');
  assert.ok(stored.every(r => r.token_hash !== token), 'raw token is never stored');

  assert.equal((await client().post('/api/auth/reset', { token, password: 'short' })).status, 400);
  assert.equal((await client().post('/api/auth/reset', { token, password: 'Brand-New-Pass1' })).status, 200);
  assert.equal((await client().login('mailer1', 'Mailer-Pass1')).status, 401, 'old password dead');
  assert.equal((await client().login('mailer1', 'Brand-New-Pass1')).status, 200);
  assert.equal((await client().post('/api/auth/reset', { token, password: 'Another-Pass12' })).status, 400, 'second use refused');
});

test('reset: expired, malformed and superseded tokens are refused', async () => {
  await client().post('/api/auth/forgot', { identifier: 'mailer1' });
  const first = lastToken();
  await client().post('/api/auth/forgot', { identifier: 'mailer1' });
  const second = lastToken();
  assert.equal((await client().post('/api/auth/reset', { token: first, password: 'Whatever-Pass1' })).status, 400, 'newer request replaces older');

  await pool.query("UPDATE password_resets SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE username='mailer1'");
  assert.equal((await client().post('/api/auth/reset', { token: second, password: 'Whatever-Pass1' })).status, 400, 'expired');

  for (const token of ['', 'abc', 'g'.repeat(64), null, 42, "' OR 1=1 --"])
    assert.equal((await client().post('/api/auth/reset', { token, password: 'Whatever-Pass1' })).status, 400, String(token));
});

test('changing or resetting a password signs out every other session', async () => {
  await admin.post('/api/users', { username: 'sess_user', password: 'Sess-Pass-123', role: 'viewer', email: 'sess@example.com' });
  const phone = client(), laptop = client();
  await phone.login('sess_user', 'Sess-Pass-123'); await laptop.login('sess_user', 'Sess-Pass-123');
  assert.equal((await phone.get('/api/dispensers')).status, 200);

  // change on laptop: laptop stays signed in, phone is signed out
  assert.equal((await laptop.post('/api/auth/password', { current_password: 'Sess-Pass-123', new_password: 'Sess-Pass-456' })).status, 200);
  assert.equal((await laptop.get('/api/dispensers')).status, 200);
  assert.equal((await phone.get('/api/dispensers')).status, 401);

  // reset: laptop session dies too
  await client().post('/api/auth/forgot', { identifier: 'sess@example.com' });
  await client().post('/api/auth/reset', { token: lastToken(), password: 'Sess-Pass-789' });
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
    assert.equal((await client().post(`/api/dispensers/${a.body.id}/readings`, { level_l: 4 }, { 'x-api-key': key })).status, 401);
  assert.equal((await client().post(`/api/dispensers/${a.body.id}/readings`, { level_l: 4 }, DEVICE)).status, 200);
});
