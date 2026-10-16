const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, newDispenser, DEVICE } = require('./helpers');
const { outbox } = require('../mailer');

let admin, viewer, makeClient, base;
setup('features', c => ({ admin, viewer, makeClient, base } = c));

const alertTypes = async id =>
  (await admin.get('/api/alerts')).body.filter(a => a.dispenser_id === id).map(a => a.type).sort();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 2000) {
  for (let t = 0; t < ms; t += 50) { const v = fn(); if (v) return v; await sleep(50); }
  return fn();
}

test('per-dispenser low-level threshold overrides the server default', async () => {
  const d = await newDispenser(admin, { capacity_l: 10, level_l: 4, low_level_pct: 50 }); // 40% < 50%
  assert.equal(d.status, 'LOW');
  assert.equal(d.low_level_pct, 50);
  assert.equal(d.effective_low_pct, 50);
  await makeClient().post(`/api/dispensers/${d.id}/readings`, { level_l: 4 }, DEVICE);
  assert.deepEqual(await alertTypes(d.id), ['LOW_LEVEL']);

  const back = await admin.put(`/api/dispensers/${d.id}`, { low_level_pct: null }); // back to the 20% default
  assert.equal(back.status, 200);
  assert.equal(back.body.status, 'OK');
  assert.equal(back.body.effective_low_pct, 20);
  assert.deepEqual(await alertTypes(d.id), [], 'raising the bar then clearing it resolves the alert at once');
});

test('editing a threshold opens an alert immediately', async () => {
  const d = await newDispenser(admin, { capacity_l: 10, level_l: 4 });
  assert.deepEqual(await alertTypes(d.id), []);
  assert.equal((await admin.put(`/api/dispensers/${d.id}`, { low_level_pct: 60 })).status, 200);
  assert.deepEqual(await alertTypes(d.id), ['LOW_LEVEL']);
});

test('per-dispenser temperature threshold raises HIGH_TEMP', async () => {
  const d = await newDispenser(admin, { high_temp_c: 10 });
  await makeClient().post(`/api/dispensers/${d.id}/readings`, { temperature_c: 12 }, DEVICE);
  assert.deepEqual(await alertTypes(d.id), ['HIGH_TEMP']);
  const other = await newDispenser(admin); // default 25 °C
  await makeClient().post(`/api/dispensers/${other.id}/readings`, { temperature_c: 12 }, DEVICE);
  assert.deepEqual(await alertTypes(other.id), []);
});

test('threshold input is validated', async () => {
  for (const bad of [{ low_level_pct: 0 }, { low_level_pct: 100 }, { low_level_pct: 5.5 }, { low_level_pct: 'x' }, { high_temp_c: 101 }, { high_temp_c: -1 }])
    assert.equal((await admin.post('/api/dispensers', { name: 'B', location: 'x', ...bad })).status, 400, JSON.stringify(bad));
  const d = await newDispenser(admin);
  assert.equal((await admin.put(`/api/dispensers/${d.id}`, { low_level_pct: 150 })).status, 400);
  assert.equal((await viewer.put(`/api/dispensers/${d.id}`, { low_level_pct: 30 })).status, 403);
});

test('time-to-empty forecast comes from the last 24 hours of draws', async () => {
  const d = await newDispenser(admin, { capacity_l: 20, level_l: 5 });
  assert.equal((await admin.get(`/api/dispensers/${d.id}`)).body.hours_to_empty, null, 'no draws, no forecast');
  const c = makeClient();
  await c.post(`/api/dispensers/${d.id}/dispense`, { volume_ml: 500 }, DEVICE);
  await c.post(`/api/dispensers/${d.id}/dispense`, { volume_ml: 500 }, DEVICE);
  const got = (await admin.get('/api/dispensers')).body.find(x => x.id === d.id);
  assert.equal(got.avg_ml_per_hour, 42); // 1000 ml / 24 h
  assert.ok(Math.abs(got.hours_to_empty - 96) < 1, `expected ~96 h, got ${got.hours_to_empty}`); // 4 L left at ~41.7 ml/h
  await admin.put(`/api/dispensers/${d.id}`, { enabled: false });
  assert.equal((await admin.get(`/api/dispensers/${d.id}`)).body.hours_to_empty, null, 'disabled dispensers have no forecast');
});

test('dashboard endpoint bundles everything and needs login', async () => {
  assert.equal((await makeClient().get('/api/dashboard')).status, 401);
  await newDispenser(admin);
  const r = await viewer.get('/api/dashboard');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['alerts', 'complaints', 'daily', 'dispensers', 'hourly', 'stats']);
  assert.equal(r.body.stats.total, r.body.dispensers.length);
  assert.equal(r.body.daily.length, 7);
  assert.equal(r.body.hourly.length, 24);
});

test('refill history endpoint lists refills; unknown dispensers are 404', async () => {
  const d = await newDispenser(admin, { capacity_l: 10, level_l: 2 });
  await admin.post(`/api/dispensers/${d.id}/refill`, { added_l: 3 });
  await admin.post(`/api/dispensers/${d.id}/refill`, {});
  const r = await viewer.get(`/api/dispensers/${d.id}/refills`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map(x => x.added_l), [5, 3]); // newest first; the second tops up to 10 L
  for (const sub of ['events', 'history', 'refills'])
    assert.equal((await admin.get(`/api/dispensers/99999/${sub}`)).status, 404, sub);
  assert.equal((await admin.get('/api/dispensers/99999')).status, 404);
});

test('admins with an email get one message per new alert, with a cooldown', async () => {
  assert.equal((await admin.put('/api/auth/email', { email: 'Ops@Example.test' })).status, 200);
  const d = await newDispenser(admin, { name: 'Mail Me', capacity_l: 10, level_l: 9 });
  const before = outbox.length;
  const dev = makeClient();
  await dev.post(`/api/dispensers/${d.id}/readings`, { level_l: 1 }, DEVICE); // -> LOW_LEVEL
  const mail = await waitFor(() => outbox.slice(before).find(m => /Mail Me/.test(m.subject)));
  assert.ok(mail, 'an alert email was sent');
  assert.equal(mail.to, 'ops@example.test');
  assert.match(mail.subject, /running low/);
  assert.match(mail.text, /Mail Me is low/);

  const sent = outbox.length;
  await dev.post(`/api/dispensers/${d.id}/readings`, { level_l: 1 }, DEVICE); // same alert still open: no new mail
  await admin.post(`/api/dispensers/${d.id}/refill`, {});
  await dev.post(`/api/dispensers/${d.id}/readings`, { level_l: 1 }, DEVICE); // reopened within the cooldown: suppressed
  await sleep(300);
  assert.equal(outbox.length, sent, 'no repeat mail for the same alert type inside the cooldown');
  await admin.put('/api/auth/email', { email: '' });
});

test('offline sample data has exactly the shape of the real dashboard API', async () => {
  const SAMPLE = require('../public/sample.js');
  const d = await newDispenser(admin, { capacity_l: 10, level_l: 1 });
  const dev = makeClient();
  await dev.post(`/api/dispensers/${d.id}/readings`, { level_l: 1 }, DEVICE); // opens a LOW_LEVEL alert
  await dev.post(`/api/dispensers/${d.id}/dispense`, { volume_ml: 100 }, DEVICE);
  const real = (await viewer.get('/api/dashboard')).body, sample = SAMPLE.dashboard();
  assert.deepEqual(Object.keys(sample).sort(), Object.keys(real).sort());
  for (const k of Object.keys(real.stats)) assert.ok(k in sample.stats, `stats.${k}`);
  for (const k of Object.keys(real.dispensers[0])) assert.ok(k in sample.dispensers[0], `dispenser.${k}`);
  for (const k of Object.keys(real.alerts[0])) assert.ok(k in sample.alerts[0], `alert.${k}`);
  assert.deepEqual(Object.keys(sample.daily[0]), Object.keys(real.daily[0]));
  assert.deepEqual(Object.keys(sample.hourly[0]), Object.keys(real.hourly[0]));
  assert.equal(sample.daily.length, real.daily.length);
  assert.equal(sample.hourly.length, real.hourly.length);
  const id = sample.dispensers[0].id;
  assert.ok(SAMPLE.history(id).length > 50 && 'level_l' in SAMPLE.history(id)[0]);
  assert.ok('volume_ml' in SAMPLE.events(id)[0] && 'added_l' in SAMPLE.refills(id)[0]);
});

test('the service worker and sample data are served as scripts', async () => {
  for (const f of ['/sw.js', '/sample.js', '/app.js']) {
    const r = await fetch(base + f);
    assert.equal(r.status, 200, f);
    assert.match(r.headers.get('content-type'), /javascript/, f);
  }
});
