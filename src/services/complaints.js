const { pool, tx } = require('../db');
const { HttpError } = require('../http');
const { sendMail } = require('../../mailer');
const { emailsOf } = require('./people');

const CATEGORIES = ['NO_WATER', 'LEAK', 'DIRTY', 'BROKEN', 'OTHER'];
const CATEGORY_LABEL = { NO_WATER: 'No water', LEAK: 'Leak', DIRTY: 'Dirty / unhygienic', BROKEN: 'Broken or not working', OTHER: 'Other' };
const OPEN_STATES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS'];

const isStaff = u => u.role === 'admin' || u.role === 'caretaker';

// Which complaints a person may see: admins all, caretakers those for dispensers they look after (or that nobody does),
// technicians the jobs assigned to them, everyone else only their own.
function scope(user) {
  if (user.role === 'admin') return { sql: '1=1', params: [] };
  if (user.role === 'caretaker') return { sql: '(d.caretaker_username = ? OR d.caretaker_username IS NULL)', params: [user.username] };
  if (user.role === 'technician') return { sql: 'c.technician = ?', params: [user.username] };
  return { sql: 'c.reporter = ?', params: [user.username] };
}

const SELECT = `SELECT c.*, d.name AS dispenser_name, d.location AS dispenser_location, d.caretaker_username
                FROM complaints c JOIN dispensers d ON d.id = c.dispenser_id`;
const ORDER = "ORDER BY FIELD(c.status,'OPEN','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED'), c.created_at DESC, c.id DESC";

async function list(user, { status, limit = 100 } = {}) {
  const sc = scope(user);
  const [rows] = await pool.query(
    `${SELECT} WHERE ${sc.sql} ${status ? 'AND c.status=?' : ''} ${ORDER} LIMIT ?`,
    [...sc.params, ...(status ? [status] : []), limit]);
  return rows;
}

// One complaint the person is allowed to see (404 otherwise, so ids can't be probed), with its timeline.
async function getVisible(user, id, conn = pool, lock = false) {
  const sc = scope(user);
  const [rows] = await conn.query(`${SELECT} WHERE c.id=? AND ${sc.sql} ${lock ? 'FOR UPDATE' : ''}`, [id, ...sc.params]);
  if (!rows.length) throw new HttpError(404, 'Complaint not found');
  return rows[0];
}
async function timeline(id) {
  const [rows] = await pool.query('SELECT actor, action, note, created_at FROM complaint_events WHERE complaint_id=? ORDER BY created_at, id', [id]);
  return rows;
}
const logEvent = (conn, id, actor, action, note) =>
  conn.query('INSERT INTO complaint_events (complaint_id, actor, action, note) VALUES (?,?,?,?)', [id, actor, action, note ?? null]);

// ---- notifications (sent only after the transaction commits, see tx in db.js) ----
const base = () => (process.env.BASE_URL || '').replace(/\/+$/, '');
const dashboardLink = () => (base() ? `\n\nOpen the dashboard: ${base()}/` : '');

async function mailAll(recipients, subject, text) {
  const seen = new Set();
  for (const r of recipients) {
    if (!r?.email || seen.has(r.email)) continue;
    seen.add(r.email);
    try { await sendMail({ to: r.email, subject, text: text + dashboardLink() }); }
    catch (e) { console.error('complaint email failed:', e.message); }
  }
}
const summary = c => `Dispenser: ${c.dispenser_name} (${c.dispenser_location})\nProblem: ${CATEGORY_LABEL[c.category]}\nDetails: ${c.description}`;

// The dispenser's own caretaker; when it has none (or they have no email), every caretaker and admin with an address.
async function caretakerRecipients(c) {
  if (c.caretaker_username) {
    const own = await emailsOf('username=?', [c.caretaker_username]);
    if (own.length) return own;
  }
  return emailsOf("role IN ('caretaker','admin')");
}

const notify = {
  raised: async c => mailAll(await caretakerRecipients(c), `[Smart Water] New complaint #${c.id}: ${c.dispenser_name}`,
    `${c.reporter} reported a problem.\n\n${summary(c)}\n\nOpen the Complaints panel to assign a technician.`),
  assigned: async (c, by) => {
    await mailAll(await emailsOf('username=?', [c.technician]), `[Smart Water] Job #${c.id} assigned to you: ${c.dispenser_name}`,
      `${by} assigned you a repair.\n\n${summary(c)}\n\nMark it In progress when you start and Resolved (with a note) when it is fixed.`);
    if (c.reporter) await mailAll(await emailsOf('username=?', [c.reporter]), `[Smart Water] Your complaint #${c.id} is being handled`,
      `A technician (${c.technician}) has been assigned to your complaint about ${c.dispenser_name}.`);
  },
  resolved: async (c, by, note) => {
    const to = [...(c.reporter ? await emailsOf('username=?', [c.reporter]) : []), ...await caretakerRecipients(c)];
    return mailAll(to, `[Smart Water] Complaint #${c.id} resolved: ${c.dispenser_name}`,
      `${by} marked this complaint as resolved.\n\nNote: ${note}\n\n${summary(c)}\n\nIf it is still not fixed the reporter can reopen it from the dashboard.`);
  },
  reopened: async (c, by, note) => {
    const to = c.technician ? await emailsOf('username=?', [c.technician]) : await caretakerRecipients(c);
    return mailAll(to, `[Smart Water] Complaint #${c.id} reopened: ${c.dispenser_name}`, `${by} says the problem is not fixed.\n\nNote: ${note}\n\n${summary(c)}`);
  },
};

// ---- actions ----
async function create(user, { dispenser_id, category, description }) {
  if (!Number.isInteger(dispenser_id) || dispenser_id < 1) throw new HttpError(400, 'dispenser_id must be a dispenser id');
  if (!CATEGORIES.includes(category)) throw new HttpError(400, `category must be one of: ${CATEGORIES.join(', ')}`);
  const text = typeof description === 'string' ? description.trim() : '';
  if (text.length < 5 || text.length > 500) throw new HttpError(400, 'Describe the problem in 5-500 characters');
  const id = await tx(async conn => {
    const [[d]] = await conn.query('SELECT id FROM dispensers WHERE id=?', [dispenser_id]);
    if (!d) throw new HttpError(404, 'Dispenser not found');
    const [dupes] = await conn.query(
      `SELECT id FROM complaints WHERE reporter=? AND dispenser_id=? AND category=? AND status IN (${OPEN_STATES.map(() => '?').join(',')}) LIMIT 1`,
      [user.username, d.id, category, ...OPEN_STATES]);
    if (dupes.length) throw new HttpError(409, `You already reported this (complaint #${dupes[0].id}). We are on it.`);
    const [r] = await conn.query('INSERT INTO complaints (dispenser_id, reporter, category, description) VALUES (?,?,?,?)',
      [d.id, user.username, category, text]);
    await logEvent(conn, r.insertId, user.username, 'CREATED', text);
    conn.afterCommit.push(async () => notify.raised(await getVisible({ role: 'admin' }, r.insertId)));
    return r.insertId;
  });
  return getVisible(user, id);
}

// staff = admin, or the caretaker looking after this dispenser (or any caretaker when it has none)
function assertStaff(user, c) {
  if (!isStaff(user)) throw new HttpError(403, 'Only caretakers can do this');
  if (user.role === 'caretaker' && c.caretaker_username && c.caretaker_username !== user.username)
    throw new HttpError(403, 'This dispenser is looked after by another caretaker');
}

async function assign(user, id, technician) {
  const out = await tx(async conn => {
    const c = await getVisible(user, id, conn, true);
    assertStaff(user, c);
    if (!OPEN_STATES.includes(c.status)) throw new HttpError(409, `A ${c.status.toLowerCase()} complaint cannot be assigned`);
    const [[t]] = await conn.query("SELECT username FROM users WHERE username=? AND role='technician'", [String(technician ?? '')]);
    if (!t) throw new HttpError(400, 'Choose an existing technician');
    await conn.query("UPDATE complaints SET status='ASSIGNED', technician=? WHERE id=?", [t.username, c.id]);
    await logEvent(conn, c.id, user.username, 'ASSIGNED', `Assigned to ${t.username}`);
    const updated = await getVisible(user, c.id, conn);
    conn.afterCommit.push(() => notify.assigned(updated, user.username));
    return updated;
  });
  return out;
}

const NEXT = { IN_PROGRESS: ['ASSIGNED'], RESOLVED: ['ASSIGNED', 'IN_PROGRESS'], CLOSED: [...OPEN_STATES, 'RESOLVED'], OPEN: ['RESOLVED'] };

async function setStatus(user, id, status, rawNote) {
  if (!NEXT[status]) throw new HttpError(400, 'status must be IN_PROGRESS, RESOLVED, CLOSED or OPEN (reopen)');
  const note = typeof rawNote === 'string' ? rawNote.trim() : '';
  if (note.length > 500) throw new HttpError(400, 'note is too long (max 500)');
  return tx(async conn => {
    const c = await getVisible(user, id, conn, true);
    if (!NEXT[status].includes(c.status)) throw new HttpError(409, `Cannot go from ${c.status} to ${status}`);
    const isAssignedTech = user.role === 'technician' && c.technician === user.username;
    const staff = (() => { try { assertStaff(user, c); return true; } catch { return false; } })();

    if (status === 'IN_PROGRESS' || status === 'RESOLVED') {
      if (!isAssignedTech && !staff) throw new HttpError(403, 'Only the assigned technician or a caretaker can do this');
      if (status === 'RESOLVED' && note.length < 3) throw new HttpError(400, 'Add a short note about what was done');
      await conn.query('UPDATE complaints SET status=?, resolution_note=COALESCE(?, resolution_note) WHERE id=?', [status, status === 'RESOLVED' ? note : null, c.id]);
      await logEvent(conn, c.id, user.username, status, note || null);
    } else if (status === 'CLOSED') {
      if (!staff) throw new HttpError(403, 'Only caretakers can close a complaint');
      if (c.status !== 'RESOLVED' && note.length < 3) throw new HttpError(400, 'Say why you are closing it without a fix');
      await conn.query("UPDATE complaints SET status='CLOSED' WHERE id=?", [c.id]);
      await logEvent(conn, c.id, user.username, 'CLOSED', note || null);
    } else { // reopen
      if (c.reporter !== user.username && !staff) throw new HttpError(403, 'Only the person who reported it can reopen it');
      if (note.length < 3) throw new HttpError(400, 'Tell us what is still wrong');
      await conn.query('UPDATE complaints SET status=? WHERE id=?', [c.technician ? 'ASSIGNED' : 'OPEN', c.id]);
      await logEvent(conn, c.id, user.username, 'REOPENED', note);
    }
    const updated = await getVisible(user, c.id, conn);
    if (status === 'RESOLVED') conn.afterCommit.push(() => notify.resolved(updated, user.username, note));
    if (status === 'OPEN') conn.afterCommit.push(() => notify.reopened(updated, user.username, note));
    return updated;
  });
}

module.exports = { CATEGORIES, CATEGORY_LABEL, list, getVisible, timeline, create, assign, setStatus };
