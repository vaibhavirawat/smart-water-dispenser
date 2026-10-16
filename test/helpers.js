// Shared test plumbing: each test file gets its own throwaway MySQL database, started and dropped
// automatically, so files can run in parallel and never touch your real smart_water DB.
process.env.DEVICE_API_KEY = 'test-device-key';
process.env.SESSION_SECRET = 'test-secret';
process.env.OFFLINE_AFTER_MIN = '2';
process.env.LOW_LEVEL_PCT = '20';
process.env.SIGNUP_LIMIT = '1000';
process.env.FORGOT_LIMIT = '1000';
process.env.NODE_ENV = 'test';
process.env.BASE_URL = 'https://water.example.test';

const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config(); // picks up DB_USER / DB_PASSWORD; does not override vars set above
const { hashPassword } = require('../auth');

const PW = 'Test-Password-1';
const DEVICE = { 'x-api-key': 'test-device-key' };

// minimal client that keeps the session cookie
function client(getBase) {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const r = await fetch(getBase() + url, {
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

async function newDispenser(a, over = {}) {
  const r = await a.post('/api/dispensers', { name: 'T', location: 'Lab', capacity_l: 10, level_l: 5, ...over });
  assert.equal(r.status, 201);
  return r.body;
}

/**
 * Call once at the top of a test file. Creates database smart_water_test_<name>, starts the server on a free port
 * and signs in an admin and a viewer. onReady({ base, admin, viewer, makeClient }) runs once the server is up.
 * Returns { pool, checkOffline } immediately (they are safe to use inside tests).
 */
function setup(name, onReady) {
  const dbName = `smart_water_test_${name}`;
  process.env.DB_NAME = dbName;
  const { pool, start, checkOffline } = require('../server');
  let server, base;
  const makeClient = () => client(() => base);

  before(async () => {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', multipleStatements: true,
    });
    await conn.query(`DROP DATABASE IF EXISTS ${dbName}`);
    const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8').replace(/\bsmart_water\b/g, dbName);
    await conn.query(schema);
    await conn.query(`USE ${dbName}`);
    await conn.query('INSERT INTO users (username,password_hash,role) VALUES (?,?,?),(?,?,?)',
      ['admin', hashPassword(PW), 'admin', 'viewer', hashPassword(PW), 'viewer']);
    await conn.end();

    server = start(0);
    await new Promise(r => server.once('listening', r));
    base = `http://localhost:${server.address().port}`;
    const admin = makeClient(), viewer = makeClient();
    assert.equal((await admin.login('admin')).status, 200);
    assert.equal((await viewer.login('viewer')).status, 200);
    onReady({ base, admin, viewer, makeClient });
  });

  after(async () => {
    await new Promise(r => server.close(r));
    await pool.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await pool.end();
    process.exit(0); // the background interval from start() would keep the process alive
  });

  return { pool, checkOffline };
}

module.exports = { setup, newDispenser, PW, DEVICE };
