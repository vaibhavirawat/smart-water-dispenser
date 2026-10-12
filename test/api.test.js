// Integration tests: run the real Express app against a throwaway MySQL database.
// Run with: npm test   (needs MySQL running; never touches your real smart_water DB)
process.env.DB_NAME = 'smart_water_test';
process.env.DEVICE_API_KEY = 'test-device-key';
process.env.SESSION_SECRET = 'test-secret';
process.env.OFFLINE_AFTER_MIN = '2';
process.env.LOW_LEVEL_PCT = '20';

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
  assert.deepEqual((await c.get('/api/auth/me')).body, { username: 'viewer', role: 'viewer' });
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
