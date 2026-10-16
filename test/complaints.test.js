const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, newDispenser, PW } = require('./helpers');
const { outbox } = require('../mailer');

let admin, viewer, makeClient;
setup('complaints', c => ({ admin, viewer, makeClient } = c));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 2000) {
  for (let t = 0; t < ms; t += 50) { const v = fn(); if (v) return v; await sleep(50); }
  return fn();
}
const mailTo = (to, since) => outbox.slice(since).filter(m => m.to === to);
let n = 0;
// create a user of a given role (with an email) through the admin API and return a signed-in client
async function person(role) {
  const username = `${role}${++n}`;
  const r = await admin.post('/api/users', { username, password: PW, role, email: `${username}@example.test` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = makeClient();
  assert.equal((await c.login(username)).status, 200);
  return Object.assign(c, { username, email: `${username}@example.test` });
}
const report = (c, dispenser, over = {}) =>
  c.post('/api/complaints', { dispenser_id: dispenser.id, category: 'NO_WATER', description: 'Nothing comes out of the tap', ...over });

test('anyone signed in can raise a complaint; input is validated', async () => {
  const d = await newDispenser(admin);
  assert.equal((await makeClient().post('/api/complaints', { dispenser_id: d.id })).status, 401);
  const u = await person('viewer');
  const ok = await report(u, d);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.status, 'OPEN'); assert.equal(ok.body.reporter, u.username); assert.equal(ok.body.dispenser_name, d.name);
  for (const bad of [{ category: 'NOPE' }, { description: 'x' }, { description: 'y'.repeat(501) }, { dispenser_id: 99999 }, { dispenser_id: 'abc' }]) {
    const r = await report(u, d, bad);
    assert.ok([400, 404].includes(r.status), JSON.stringify(bad) + ' -> ' + r.status);
  }
});

test('the same open complaint cannot be filed twice, but a different problem can', async () => {
  const d = await newDispenser(admin);
  const u = await person('viewer');
  assert.equal((await report(u, d)).status, 201);
  assert.equal((await report(u, d)).status, 409);
  assert.equal((await report(u, d, { category: 'LEAK', description: 'Water on the floor' })).status, 201);
  assert.equal((await report(await person('viewer'), d)).status, 201, 'another person may report the same thing');
});

test('who can see which complaints', async () => {
  const mine = await person('caretaker'), other = await person('caretaker'), tech = await person('technician');
  const d = await newDispenser(admin, { caretaker: mine.username });
  const u = await person('viewer'), stranger = await person('viewer');
  const c = (await report(u, d)).body;

  const ids = async who => (await who.get('/api/complaints')).body.map(x => x.id);
  assert.ok((await ids(u)).includes(c.id));
  assert.ok(!(await ids(stranger)).includes(c.id), 'other users never see it');
  assert.ok((await ids(mine)).includes(c.id));
  assert.ok(!(await ids(other)).includes(c.id), 'a caretaker of another dispenser does not');
  assert.ok(!(await ids(tech)).includes(c.id), 'technicians only see jobs assigned to them');
  assert.ok((await ids(admin)).includes(c.id));
  assert.equal((await stranger.get(`/api/complaints/${c.id}`)).status, 404);
  assert.equal((await u.get(`/api/complaints/${c.id}`)).body.events[0].action, 'CREATED');
  assert.ok((await u.get('/api/dashboard')).body.complaints.some(x => x.id === c.id), 'the dashboard carries them too');
});

test('the dispenser\'s caretaker is emailed; with none set every caretaker is', async () => {
  const mine = await person('caretaker'), other = await person('caretaker');
  const d1 = await newDispenser(admin, { name: 'Owned', caretaker: mine.username });
  const before = outbox.length;
  await report(await person('viewer'), d1);
  await waitFor(() => mailTo(mine.email, before).length);
  assert.equal(mailTo(mine.email, before).length, 1);
  assert.match(mailTo(mine.email, before)[0].subject, /New complaint.*Owned/);
  assert.equal(mailTo(other.email, before).length, 0, 'not the other caretaker');

  const d2 = await newDispenser(admin, { name: 'Nobody' });
  const before2 = outbox.length;
  await report(await person('viewer'), d2);
  await waitFor(() => mailTo(mine.email, before2).length && mailTo(other.email, before2).length);
  assert.equal(mailTo(mine.email, before2).length, 1); assert.equal(mailTo(other.email, before2).length, 1);
});

test('caretaker assigns a technician, who works it through to resolved; the reporter is told', async () => {
  const care = await person('caretaker'), tech = await person('technician'), u = await person('viewer');
  const d = await newDispenser(admin, { caretaker: care.username });
  const c = (await report(u, d)).body;

  const before = outbox.length;
  const a = await care.post(`/api/complaints/${c.id}/assign`, { technician: tech.username });
  assert.equal(a.status, 200); assert.equal(a.body.status, 'ASSIGNED'); assert.equal(a.body.technician, tech.username);
  await waitFor(() => mailTo(tech.email, before).length && mailTo(u.email, before).length);
  assert.match(mailTo(tech.email, before)[0].subject, /assigned to you/);
  assert.match(mailTo(u.email, before)[0].subject, /being handled/);

  assert.ok((await tech.get('/api/complaints')).body.some(x => x.id === c.id), 'the technician now sees the job');
  assert.equal((await tech.post(`/api/complaints/${c.id}/status`, { status: 'RESOLVED' })).status, 400, 'a note is required');
  assert.equal((await tech.post(`/api/complaints/${c.id}/status`, { status: 'IN_PROGRESS' })).body.status, 'IN_PROGRESS');
  const mark = outbox.length;
  const done = await tech.post(`/api/complaints/${c.id}/status`, { status: 'RESOLVED', note: 'Replaced the filter' });
  assert.equal(done.status, 200); assert.equal(done.body.status, 'RESOLVED'); assert.equal(done.body.resolution_note, 'Replaced the filter');
  await waitFor(() => mailTo(u.email, mark).length && mailTo(care.email, mark).length);
  assert.match(mailTo(u.email, mark)[0].text, /Replaced the filter/);

  const events = (await u.get(`/api/complaints/${c.id}`)).body.events.map(e => e.action);
  assert.deepEqual(events, ['CREATED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED']);
});

test('assignment rules: right caretaker, real technician, open complaint', async () => {
  const care = await person('caretaker'), other = await person('caretaker'), tech = await person('technician');
  const u = await person('viewer');
  const d = await newDispenser(admin, { caretaker: care.username });
  const c = (await report(u, d)).body;
  assert.equal((await u.post(`/api/complaints/${c.id}/assign`, { technician: tech.username })).status, 403, 'users cannot assign');
  assert.equal((await tech.post(`/api/complaints/${c.id}/assign`, { technician: tech.username })).status, 403, 'nor can technicians');
  assert.equal((await other.post(`/api/complaints/${c.id}/assign`, { technician: tech.username })).status, 404, 'another caretaker cannot even see it');
  assert.equal((await care.post(`/api/complaints/${c.id}/assign`, { technician: care.username })).status, 400, 'must be a technician');
  assert.equal((await care.post(`/api/complaints/${c.id}/assign`, { technician: 'ghost' })).status, 400);
  assert.equal((await admin.post(`/api/complaints/${c.id}/assign`, { technician: tech.username })).status, 200, 'admins can');
  const tech2 = await person('technician');
  assert.equal((await care.post(`/api/complaints/${c.id}/assign`, { technician: tech2.username })).body.technician, tech2.username, 'reassignment works');
  assert.equal((await tech.get(`/api/complaints/${c.id}`)).status, 404, 'the previous technician loses access');
});

test('only the assigned technician (or a caretaker) can progress a job', async () => {
  const care = await person('caretaker'), tech = await person('technician'), tech2 = await person('technician'), u = await person('viewer');
  const d = await newDispenser(admin, { caretaker: care.username });
  const c = (await report(u, d)).body;
  assert.equal((await care.post(`/api/complaints/${c.id}/status`, { status: 'IN_PROGRESS' })).status, 409, 'cannot start before assigning');
  await care.post(`/api/complaints/${c.id}/assign`, { technician: tech.username });
  assert.equal((await tech2.post(`/api/complaints/${c.id}/status`, { status: 'IN_PROGRESS' })).status, 404);
  assert.equal((await u.post(`/api/complaints/${c.id}/status`, { status: 'IN_PROGRESS' })).status, 403);
  assert.equal((await u.post(`/api/complaints/${c.id}/status`, { status: 'CLOSED', note: 'never mind' })).status, 403, 'users cannot close');
  assert.equal((await tech.post(`/api/complaints/${c.id}/status`, { status: 'WHATEVER' })).status, 400);
  assert.equal((await tech.post(`/api/complaints/${c.id}/status`, { status: 'RESOLVED', note: 'Fixed the tap' })).status, 200);
  assert.equal((await tech.post(`/api/complaints/${c.id}/status`, { status: 'IN_PROGRESS' })).status, 409, 'resolved jobs do not go backwards');
});

test('the reporter can reopen a resolved complaint; caretakers can close', async () => {
  const care = await person('caretaker'), tech = await person('technician'), u = await person('viewer'), v2 = await person('viewer');
  const d = await newDispenser(admin, { caretaker: care.username });
  const c = (await report(u, d)).body;
  await care.post(`/api/complaints/${c.id}/assign`, { technician: tech.username });
  await tech.post(`/api/complaints/${c.id}/status`, { status: 'RESOLVED', note: 'Cleaned it' });

  assert.equal((await v2.post(`/api/complaints/${c.id}/status`, { status: 'OPEN', note: 'still bad' })).status, 404, 'only the reporter');
  assert.equal((await u.post(`/api/complaints/${c.id}/status`, { status: 'OPEN' })).status, 400, 'a note is required');
  const before = outbox.length;
  const re = await u.post(`/api/complaints/${c.id}/status`, { status: 'OPEN', note: 'Still dirty this morning' });
  assert.equal(re.status, 200); assert.equal(re.body.status, 'ASSIGNED', 'back to the same technician');
  await waitFor(() => mailTo(tech.email, before).length);
  assert.match(mailTo(tech.email, before)[0].subject, /reopened/);

  assert.equal((await care.post(`/api/complaints/${c.id}/status`, { status: 'CLOSED' })).status, 400, 'closing an unfixed one needs a reason');
  assert.equal((await care.post(`/api/complaints/${c.id}/status`, { status: 'CLOSED', note: 'Duplicate of another report' })).body.status, 'CLOSED');
  assert.equal((await u.post(`/api/complaints/${c.id}/status`, { status: 'OPEN', note: 'again' })).status, 409, 'closed is final');
});

test('removing or demoting a technician returns their open jobs to the caretaker', async () => {
  const care = await person('caretaker'), tech = await person('technician'), u = await person('viewer');
  const d = await newDispenser(admin, { caretaker: care.username });
  const c = (await report(u, d)).body;
  await care.post(`/api/complaints/${c.id}/assign`, { technician: tech.username });
  assert.equal((await admin.put(`/api/users/${tech.username}/role`, { role: 'viewer' })).status, 200);
  const after = (await care.get(`/api/complaints/${c.id}`)).body;
  assert.equal(after.status, 'OPEN'); assert.equal(after.technician, null);
  assert.equal(after.events.at(-1).action, 'REOPENED');

  assert.equal((await admin.del(`/api/users/${care.username}`)).status, 204);
  assert.equal((await admin.get(`/api/dispensers/${d.id}`)).body.caretaker_username, null, 'the dispenser falls back to all caretakers');
});

test('caretaker and technician cannot use admin features; roles are validated', async () => {
  const care = await person('caretaker'), tech = await person('technician');
  for (const who of [care, tech]) {
    assert.equal((await who.post('/api/dispensers', { name: 'X', location: 'y' })).status, 403);
    assert.equal((await who.get('/api/users')).status, 403);
    assert.equal((await who.get('/api/dispensers')).status, 200, 'but they can look at dispensers');
  }
  assert.equal((await tech.get('/api/technicians')).status, 403);
  assert.ok((await care.get('/api/technicians')).body.some(t => t.username === tech.username));
  assert.equal((await admin.post('/api/users', { username: 'badrole1', password: PW, role: 'boss' })).status, 400);
  assert.equal((await admin.put(`/api/users/${tech.username}/role`, { role: 'caretaker' })).status, 200);
  const d = await newDispenser(admin);
  assert.equal((await admin.put(`/api/dispensers/${d.id}`, { caretaker: 'viewer' })).status, 400, 'a dispenser caretaker must hold the caretaker role');
  assert.equal((await admin.put(`/api/dispensers/${d.id}`, { caretaker: tech.username })).status, 200);
  assert.equal((await admin.put(`/api/dispensers/${d.id}`, { caretaker: null })).body.caretaker_username, null);
});

test('self sign-up still only creates ordinary users', async () => {
  const c = makeClient();
  const r = await c.post('/api/auth/register', { username: 'newcomer', password: PW, role: 'admin' });
  assert.equal(r.status, 201); assert.equal(r.body.role, 'viewer');
  assert.equal((await c.post('/api/complaints', { dispenser_id: (await newDispenser(admin)).id, category: 'LEAK', description: 'Water pooling below' })).status, 201);
  assert.equal((await viewer.get('/api/technicians')).status, 403);
});
