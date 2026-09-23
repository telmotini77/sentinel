#!/usr/bin/env node
'use strict';
// Restore the four previous map credentials without copying unrelated .env secrets.
// prepare <env-file> <private-json>: creates a temporary credentials transport file.
// apply|verify <private-json> [base-url]: runs in the API container using DATABASE_URL.
const fs = require('node:fs');
const crypto = require('node:crypto');
const names = {
  alertas: 'MAP_ALERTS_PASSWORD', vendedores: 'MAP_SELLERS_PASSWORD',
  adminUser: 'SUPER_ADMIN_USERNAME', adminPassword: 'SUPER_ADMIN_PASSWORD',
};
const keys = {
  alertas: 'map_access_alertas_hash', vendedores: 'map_access_vendedores_hash',
  adminUser: 'map_access_admin_user_hash', adminPassword: 'map_access_admin_password_hash',
};
function check(values) {
  for (const key of Object.keys(names)) {
    if (typeof values[key] !== 'string' || !values[key].trim()) throw new Error(`Missing ${key}`);
    if (key !== 'adminUser' && values[key].length < 8) throw new Error(`Short password: ${key}`);
  }
}
function hash(value) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${crypto.scryptSync(value, salt, 64).toString('hex')}`;
}
async function main() {
  const [mode, input, output] = process.argv.slice(2);
  if (mode === 'prepare') {
    const entries = new Map(fs.readFileSync(input, 'utf8').split(/\r?\n/).flatMap(line => {
      const m = /^([A-Z_]+)=(.*)$/.exec(line);
      if (!m) return [];
      const raw = m[2].trim();
      const quoted = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"));
      return [[m[1], quoted ? raw.slice(1, -1) : raw]];
    }));
    const values = Object.fromEntries(Object.entries(names).map(([key, env]) => [key, entries.get(env)]));
    check(values);
    fs.writeFileSync(output, JSON.stringify(values), { mode: 0o600, flag: 'wx' });
    console.log('Private transport file prepared; credential values not displayed.');
    return;
  }
  if (!['apply', 'verify'].includes(mode)) throw new Error('Use prepare, apply or verify');
  const values = JSON.parse(fs.readFileSync(input, 'utf8'));
  check(values);
  if (mode === 'apply') {
    const target = new URL(process.env.DATABASE_URL);
    if (target.hostname !== 'postgres' || target.pathname !== '/omniSentinel_db') {
      throw new Error('Unexpected database destination');
    }
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'");
      for (const [key, databaseKey] of Object.entries(keys)) {
        await client.query(`INSERT INTO zasmaolt.app_meta (key,value) VALUES ($1,$2)
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [databaseKey, hash(values[key])]);
      }
      const stored = await client.query('SELECT key,value FROM zasmaolt.app_meta WHERE key=ANY($1::text[])', [Object.values(keys)]);
      if (stored.rowCount !== 4 || !stored.rows.every(r => r.value.startsWith('scrypt:'))) {
        throw new Error('Incomplete credential restoration');
      }
      await client.query('COMMIT');
      console.log('Four credential hashes restored in PostgreSQL.');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  }
  const base = output || 'http://127.0.0.1:3010';
  const request = (path, options = {}) => fetch(new URL(path, base), {
    redirect: 'manual', signal: AbortSignal.timeout(15000), ...options,
  });
  const post = (path, fields) => request(path, { method: 'POST', body: new URLSearchParams(fields) });
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const report = { base, restoredUser: values.adminUser, checks: [] };
  const feeds = { alertas: '/webhook/naps', vendedores: '/webhook/sales/naps' };
  const cookies = {};
  for (const role of ['alertas', 'vendedores']) {
    const unauth = await request(feeds[role]);
    assert(unauth.status === 401, `${role}: unauthenticated feed is not blocked`);
    const login = await post('/access/login', { role, password: values[role] });
    assert(login.status === 302 && login.headers.get('location') === `/mapa/${role}/`, `${role}: login failed`);
    cookies[role] = login.headers.get('set-cookie')?.split(';')[0];
    assert(cookies[role], `${role}: no session cookie`);
    const headers = { Cookie: cookies[role] };
    const page = await request(`/mapa/${role}/`, { headers });
    assert(page.status === 200 && (page.headers.get('content-type') || '').includes('text/html'), `${role}: map page failed`);
    const feed = await request(feeds[role], { headers });
    assert(feed.status === 200, `${role}: authenticated feed failed`);
    const bad = await post('/access/login', { role, password: crypto.randomBytes(24).toString('hex') });
    assert(bad.status === 302 && (bad.headers.get('location') || '').includes('error=acceso') && !bad.headers.get('set-cookie'), `${role}: incorrect password accepted`);
    report.checks.push({ role, validLogin: true, mapAndFeed: true, incorrectPasswordRejected: true, anonymousBlocked: true });
  }
  const cross = await request(feeds.alertas, { headers: { Cookie: cookies.vendedores } });
  assert(cross.status === 401, 'Seller session can access operational data');
  const admin = await post('/admin/login', { username: values.adminUser, password: values.adminPassword });
  assert(admin.status === 302 && admin.headers.get('location') === '/admin', 'Admin login failed');
  const cookie = admin.headers.get('set-cookie')?.split(';')[0];
  assert(cookie, 'Admin session missing');
  const adminPage = await request('/admin', { headers: { Cookie: cookie } });
  assert(adminPage.status === 200 && (await adminPage.text()).includes('/admin/map-password'), 'Admin controls unavailable');
  const badAdmin = await post('/admin/login', { username: values.adminUser, password: crypto.randomBytes(24).toString('hex') });
  assert(badAdmin.status === 302 && (badAdmin.headers.get('location') || '').includes('error=acceso') && !badAdmin.headers.get('set-cookie'), 'Incorrect admin password accepted');
  report.checks.push({ role: 'admin', validLogin: true, controlsAvailable: true, incorrectPasswordRejected: true });
  report.sellerCannotAccessAlertFeed = true;
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
