// End-to-end: real HTTP, real MySQL/MariaDB, real browser crypto module.
// Needs TEST_DB_* env vars (see package.json "test:db"); skips otherwise.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as llc from '../public/js/llcrypto.js';

const require = createRequire(import.meta.url);
const { createPool, migrate } = require('../src/db');
const { createApp } = require('../src/app');
const { tick } = require('../src/ticker');
const { DAY } = require('../src/signal');

const dbEnv = process.env.TEST_DB_NAME;
const config = {
  appName: 'Last Light',
  baseUrl: 'http://test.local',
  secret: 'x'.repeat(40),
  cronToken: 'c'.repeat(30),
  allowRegistration: true,
  reminderHours: 24,
  production: false,
  trustProxy: 1,
};

let pool, server, base, clock, mails;
let failMail = false;

async function login(email, password) {
  const { data } = await call('POST', '/api/prelogin', { body: { email } });
  const { authKey } = await llc.deriveAccountKeys(password, data.salt, 1000);
  const r = await call('POST', '/api/login', { body: { email, authKey } });
  assert.equal(r.status, 200);
  return r.cookie;
}
const now = () => clock;
const log = { error() {}, info() {} };
const mailer = { async send(m) { if (failMail) throw new Error('smtp down'); mails.push(m); } };

async function call(method, path, { body, cookie, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Last-Light': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : cookie };
}

before(async () => {
  if (!dbEnv) return;
  pool = createPool({ host: process.env.TEST_DB_HOST || '127.0.0.1', port: 3306, user: process.env.TEST_DB_USER, password: process.env.TEST_DB_PASSWORD, database: dbEnv });
  await pool.query('DROP TABLE IF EXISTS sessions, keepers, owners');
  await migrate(pool);
  clock = 1_700_000_000_000;
  mails = [];
  const app = createApp({ pool, mailer, config, log, now });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
});

test('whole life of a vault', { skip: !dbEnv && 'set TEST_DB_* to run' }, async (t) => {
  const password = 'a long password for testing';
  const email = 'owner@example.com';
  let cookie;
  let vaultKey;

  await t.test('register with a browser-encrypted vault', async () => {
    const salt = llc.newSalt();
    const { authKey, wrapKey } = await llc.deriveAccountKeys(password, salt, 1000);
    vaultKey = llc.newVaultKey();
    const r = await call('POST', '/api/register', { body: {
      name: 'Asha', email, salt, authKey, iterations: 600000,
      wrappedKey: await llc.seal(wrapKey, vaultKey),
      ciphertext: await llc.sealJSON(vaultKey, { version: 1, letter: 'Be kind.', items: [{ id: '1', title: 'Email', body: 'pw: hunter2' }] }),
    } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    cookie = r.cookie;
    assert.ok(cookie.startsWith('ll_session='));
  });

  await t.test('rejects writes without the custom header (CSRF guard)', async () => {
    const res = await fetch(`${base}/api/signal`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(res.status, 403);
  });

  await t.test('prelogin returns a stable salt for unknown emails too', async () => {
    const a = await call('POST', '/api/prelogin', { body: { email: 'nobody@example.com' } });
    const b = await call('POST', '/api/prelogin', { body: { email: 'nobody@example.com' } });
    assert.equal(a.status, 200);
    assert.equal(a.data.salt, b.data.salt);
    assert.equal(a.data.iterations, 600000);
  });

  await t.test('login works with the derived auth key only', async () => {
    const { data } = await call('POST', '/api/prelogin', { body: { email } });
    const good = await llc.deriveAccountKeys(password, data.salt, 1000);
    const bad = await llc.deriveAccountKeys('wrong password here', data.salt, 1000);
    assert.equal((await call('POST', '/api/login', { body: { email, authKey: bad.authKey } })).status, 401);
    const r = await call('POST', '/api/login', { body: { email, authKey: good.authKey } });
    assert.equal(r.status, 200);
    cookie = r.cookie;
  });

  await t.test('vault saves carry a version; a stale save is refused', async () => {
    let me = await call('GET', '/api/me', { cookie });
    assert.equal(me.data.vaultVersion, 1);
    const ct = await llc.sealJSON(vaultKey, { version: 1, letter: 'v2', items: [] });
    let r = await call('PUT', '/api/vault', { cookie, body: { ciphertext: ct, version: 1 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.version, 2);
    r = await call('PUT', '/api/vault', { cookie, body: { ciphertext: ct, version: 1 } });
    assert.equal(r.status, 409);
    assert.equal((await call('PUT', '/api/vault', { cookie, body: { ciphertext: ct } })).status, 400);
    me = await call('GET', '/api/me', { cookie });
    assert.equal(me.data.vaultVersion, 2);
  });

  await t.test('bad input gets 400, not 500', async () => {
    assert.equal((await call('PUT', '/api/keepers', { cookie, body: { threshold: 2, keepers: [null, null] } })).status, 400);
    const longEmail = 'a@' + '.'.repeat(5000) + '@';
    const t0 = Date.now();
    assert.equal((await call('POST', '/api/prelogin', { body: { email: longEmail } })).status, 400);
    assert.ok(Date.now() - t0 < 500, 'long email must be rejected quickly');
    const res = await fetch(`${base}/api/me`, { headers: { Cookie: 'll_session=%E0%A4%A' } });
    assert.equal(res.status, 401);
  });

  await t.test('no keepers yet: ticks never advance', async () => {
    clock += 100 * DAY;
    const s = await tick({ pool, mailer, config, log, now: clock });
    assert.equal(s.checked, 0);
    assert.equal((await call('GET', '/api/me', { cookie })).status, 401, 'sessions expire after 14 days');
    cookie = await login(email, password);
    const me = await call('GET', '/api/me', { cookie });
    assert.equal(me.data.state, 'active');
  });

  let keeperCodes;
  await t.test('set 2-of-3 lightkeepers; invites are sent, codes are not', async () => {
    const shares = await llc.makeKeeperShares(vaultKey, 3, 2);
    keeperCodes = shares.map((s) => s.codeText);
    const keepers = [['Ravi', 'ravi@example.com'], ['Meera', 'meera@example.com'], ['Dev', 'dev@example.com']]
      .map(([name, em], i) => ({ name, email: em, shareIndex: shares[i].shareIndex, encryptedShare: shares[i].encryptedShare }));
    mails = [];
    // re-key: the vault moves to a fresh key that only the new cards can rebuild
    const me0 = await call('GET', '/api/me', { cookie });
    const r = await call('PUT', '/api/keepers', { cookie, body: {
      threshold: 2, keepers,
      ciphertext: await llc.sealJSON(vaultKey, { version: 1, letter: 'Be kind.', items: [{ id: '1', title: 'Email', body: 'pw: hunter2' }] }),
      wrappedKey: me0.data.wrappedKey, version: me0.data.vaultVersion,
    } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.version, me0.data.vaultVersion + 1);
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(mails.length, 3);
    for (const m of mails) assert.doesNotMatch(m.text, /LL-[0-9A-Z]{5}-/);
    const me = await call('GET', '/api/me', { cookie });
    assert.equal(me.data.threshold, 2);
    assert.equal(me.data.keepers.length, 3);
  });

  await t.test('retrieval page says sealed before release', async () => {
    const [[row]] = await pool.query('SELECT public_id FROM owners');
    const r = await call('GET', `/api/retrieve/${row.public_id}`);
    assert.deepEqual(r.data, { released: false });
    assert.equal((await call('GET', '/api/retrieve/0000000000000000000000000000ffff')).status, 404);
  });

  let publicId;
  await t.test('silence walks through overdue → going dark → released, emails at each step', async () => {
    const signalAt = clock; // keepers PUT recorded a signal
    mails = [];
    clock = signalAt + 30 * DAY;
    let s = await tick({ pool, mailer, config, log, now: clock });
    assert.equal(s.advanced, 1);
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /send your signal/);
    assert.match(mails[0].text, /\/signal#\d+\.\d+\./);

    // same tick again: nothing more happens
    assert.equal((await tick({ pool, mailer, config, log, now: clock })).advanced, 0);

    // reminder after 24 h
    clock += DAY;
    s = await tick({ pool, mailer, config, log, now: clock });
    assert.equal(s.reminded, 1);

    clock = signalAt + 37 * DAY;
    mails = [];
    s = await tick({ pool, mailer, config, log, now: clock });
    assert.equal(s.advanced, 1);
    assert.equal(mails.filter((m) => /gone quiet/.test(m.subject)).length, 3);

    clock = signalAt + 44 * DAY;
    mails = [];
    s = await tick({ pool, mailer, config, log, now: clock });
    assert.equal(s.advanced, 1);
    const releaseMails = mails.filter((m) => /ready for you/.test(m.subject));
    assert.equal(releaseMails.length, 3);
    publicId = releaseMails[0].text.match(/\/r\/([0-9a-f]{32})/)[1];
  });

  await t.test('email signal link: cron endpoint auth and used-link handling', async () => {
    assert.equal((await call('POST', '/cron/tick')).status, 401);
    const r = await call('POST', '/cron/tick', { headers: { Authorization: `Bearer ${config.cronToken}` } });
    assert.equal(r.status, 200);
    assert.equal((await call('POST', '/api/signal/token', { body: { token: '1.2.bad' } })).status, 400);
    assert.equal((await call('GET', `/cron/tick?token=${config.cronToken}`)).status, 401, 'token in the query string is refused');
  });

  await t.test('lightkeepers open the vault with 2 cards, not 1', async () => {
    const r = await call('GET', `/api/retrieve/${publicId}`);
    assert.equal(r.data.released, true);
    assert.equal(r.data.threshold, 2);
    const one = await llc.openKeeperShares([keeperCodes[0]], r.data.shares);
    assert.equal(one.shares.length, 1);
    const two = await llc.openKeeperShares([keeperCodes[0], keeperCodes[2]], r.data.shares);
    const key = llc.rebuildVaultKey(two.shares);
    const vault = await llc.openJSON(key, r.data.ciphertext);
    assert.equal(vault.letter, 'Be kind.');
    assert.equal(vault.items[0].body, 'pw: hunter2');
  });

  await t.test('released vault refuses edits and new signals', async () => {
    cookie = await login(email, password);
    assert.equal((await call('POST', '/api/signal', { cookie })).status, 409);
    assert.equal((await call('PUT', '/api/vault', { cookie, body: { ciphertext: 'QUJD', version: 1 } })).status, 409);
    assert.equal((await call('PUT', '/api/settings', { cookie, body: { intervalDays: 30, graceDays: 7 } })).status, 409);
  });
});

test('owner signal before release resets everything', { skip: !dbEnv && 'set TEST_DB_* to run' }, async () => {
  const password = 'another long password';
  const email = 'second@example.com';
  const salt = llc.newSalt();
  const { authKey, wrapKey } = await llc.deriveAccountKeys(password, salt, 1000);
  const vaultKey = llc.newVaultKey();
  let r = await call('POST', '/api/register', { body: {
    name: 'Bo', email, salt, authKey, wrappedKey: await llc.seal(wrapKey, vaultKey), ciphertext: await llc.sealJSON(vaultKey, { version: 1, items: [] }),
  } });
  assert.equal(r.status, 201);
  const cookie = r.cookie;
  const shares = await llc.makeKeeperShares(vaultKey, 2, 2);
  r = await call('PUT', '/api/keepers', { cookie, body: { threshold: 2, notify: false, keepers: [
    { name: 'A', email: 'a@example.com', shareIndex: shares[0].shareIndex, encryptedShare: shares[0].encryptedShare },
    { name: 'B', email: 'b@example.com', shareIndex: shares[1].shareIndex, encryptedShare: shares[1].encryptedShare },
  ] } });
  assert.equal(r.status, 200);

  const start = clock;
  clock = start + 38 * DAY;
  await tick({ pool, mailer, config, log, now: clock }); // overdue
  clock += 7 * DAY;
  mails = [];
  await tick({ pool, mailer, config, log, now: clock }); // going dark
  const link = mails.find((m) => m.to === email).text.match(/\/signal#(\S+)/)[1];

  // owner clicks the email link
  r = await call('POST', '/api/signal/token', { body: { token: link } });
  assert.equal(r.status, 200);
  assert.equal(r.data.alreadyUsed, undefined);
  // the same link again is harmless
  r = await call('POST', '/api/signal/token', { body: { token: link } });
  assert.equal(r.data.alreadyUsed, true);

  const me = await call('GET', '/api/me', { cookie: await login(email, password) });
  assert.equal(me.data.state, 'active');
  clock += 7 * DAY;
  assert.equal((await tick({ pool, mailer, config, log, now: clock })).advanced, 0);
});

test('announcements are retried until the emails go out', { skip: !dbEnv && 'set TEST_DB_* to run' }, async () => {
  const email = 'third@example.com';
  const salt = llc.newSalt();
  const { authKey, wrapKey } = await llc.deriveAccountKeys('a third long password', salt, 1000);
  const vaultKey = llc.newVaultKey();
  let r = await call('POST', '/api/register', { body: {
    name: 'Cy', email, salt, authKey, wrappedKey: await llc.seal(wrapKey, vaultKey), ciphertext: await llc.sealJSON(vaultKey, { version: 1, items: [] }),
  } });
  assert.equal(r.status, 201);
  const cookie = r.cookie;
  const shares = await llc.makeKeeperShares(vaultKey, 2, 2);
  r = await call('PUT', '/api/keepers', { cookie, body: { threshold: 2, notify: false, keepers: [
    { name: 'A', email: 'a3@example.com', shareIndex: shares[0].shareIndex, encryptedShare: shares[0].encryptedShare },
    { name: 'B', email: 'b3@example.com', shareIndex: shares[1].shareIndex, encryptedShare: shares[1].encryptedShare },
  ] } });
  assert.equal(r.status, 200);

  const start = clock;
  clock = start + 30 * DAY;
  failMail = true;
  mails = [];
  // (owners from earlier tests may move in the same ticks; count only Cy's mail)
  const mine = () => mails.filter((m) => m.to === email);
  let s = await tick({ pool, mailer, config, log, now: clock });
  assert.ok(s.advanced >= 1);
  assert.ok(s.errors >= 1, 'the failed send is reported');
  assert.equal(mine().length, 0);

  // mail is still down an hour later: the retry fails again, nothing is lost
  clock += 60 * 60 * 1000;
  s = await tick({ pool, mailer, config, log, now: clock });
  assert.ok(s.errors >= 1);

  failMail = false;
  clock += 60 * 60 * 1000;
  s = await tick({ pool, mailer, config, log, now: clock });
  assert.ok(s.announced >= 1, 'the overdue email is sent once mail is back');
  assert.equal(mine().length, 1);
  assert.match(mine()[0].subject, /send your signal/);

  // a successful announcement is not repeated
  clock += 60 * 60 * 1000;
  s = await tick({ pool, mailer, config, log, now: clock });
  assert.equal(s.announced, 0);
});
