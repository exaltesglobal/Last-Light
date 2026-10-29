'use strict';

const path = require('path');
const express = require('express');
const sec = require('./security');
const { upcoming } = require('./signal');
const { templates } = require('./mailer');
const { tick } = require('./ticker');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const SESSION_DAYS = 14;
const MAX_VAULT_CHARS = 4 * 1024 * 1024;
const MIN_KDF_ITERATIONS = 100000;
const MAX_KDF_ITERATIONS = 5000000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function cleanEmail(v) {
  const email = String(v || '').trim().toLowerCase();
  // Length first: the regex must never see unbounded input.
  if (email.length > 255 || !EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
  return email;
}

function cleanName(v) {
  const name = String(v || '').trim();
  if (!name || name.length > 120) throw new HttpError(400, 'Please enter a name (up to 120 characters).');
  return name;
}

function cleanB64(v, maxLen, label) {
  const s = String(v || '');
  if (!s || s.length > maxLen || !B64_RE.test(s)) throw new HttpError(400, `Invalid ${label}.`);
  return s;
}

function cleanInt(v, min, max, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} must be between ${min} and ${max}.`);
  return n;
}

function cleanAuthKey(v) {
  const s = String(v || '');
  if (!/^[0-9a-f]{64}$/.test(s)) throw new HttpError(400, 'Invalid key.');
  return s;
}

function cleanIterations(v) {
  return cleanInt(v === undefined ? 600000 : v, MIN_KDF_ITERATIONS, MAX_KDF_ITERATIONS, 'KDF iterations');
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('='); // the token is hex; no decoding needed
  }
  return null;
}

function createApp({ pool, mailer, config, log = console, now = () => Date.now() }) {
  const app = express();
  app.set('trust proxy', config.trustProxy); // see TRUST_PROXY in .env.example
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (req.secure || config.production) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  app.use(express.json({ limit: '6mb' }));

  // Every state-changing API call must be JSON with our header. Browsers won't
  // send that cross-site without CORS approval, which this server never gives.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.get('X-Last-Light') !== '1') {
      return next(new HttpError(403, 'Missing request header.'));
    }
    res.set('Cache-Control', 'no-store');
    next();
  });

  const loginLimited = sec.rateLimiter(10, 15 * 60 * 1000);
  const emailLimited = sec.rateLimiter(100, 15 * 60 * 1000);
  const anonLimited = sec.rateLimiter(60, 15 * 60 * 1000);
  const inviteLimited = sec.rateLimiter(5, 60 * 60 * 1000);
  // Verified against unknown emails too, so response time doesn't reveal who has an account.
  const dummyHash = sec.hashAuthKey(sec.newToken());

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  async function loadOwner(id) {
    const [rows] = await pool.query('SELECT * FROM owners WHERE id = ?', [id]);
    return rows[0] || null;
  }

  async function startSession(res, req, ownerId) {
    const token = sec.newToken();
    const expires = now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
    await pool.query('INSERT INTO sessions (token_hash, owner_id, expires_at) VALUES (?, ?, ?)', [sec.sha256(token), ownerId, expires]);
    res.cookie('ll_session', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure || config.production,
      maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
      path: '/',
    });
  }

  const requireOwner = wrap(async (req, res, next) => {
    const token = readCookie(req, 'll_session');
    if (!token || !/^[0-9a-f]{64}$/.test(token)) throw new HttpError(401, 'Please log in.');
    const [rows] = await pool.query('SELECT owner_id FROM sessions WHERE token_hash = ? AND expires_at > ?', [sec.sha256(token), now()]);
    if (!rows[0]) throw new HttpError(401, 'Your session has ended. Please log in again.');
    const owner = await loadOwner(rows[0].owner_id);
    if (!owner) throw new HttpError(401, 'Please log in.');
    req.owner = owner;
    req.sessionHash = sec.sha256(token);
    next();
  });

  // Any deliberate action by the owner proves they're still here. The SQL that
  // records it is shared with the routes that change escalation inputs, so the
  // input change and the signal always land in one statement.
  const SIGNAL_SQL = "last_signal_at = ?, state = 'active', state_since = ?, notified_stage = 'active', announce_claimed_at = NULL, last_reminder_at = NULL";

  async function recordSignal(ownerId, extraSql = '', extraArgs = []) {
    const t = now();
    const [res] = await pool.query(
      `UPDATE owners SET ${SIGNAL_SQL}${extraSql ? ', ' + extraSql : ''} WHERE id = ? AND state <> 'released'`,
      [t, t, ...extraArgs, ownerId],
    );
    if (res.affectedRows !== 1) throw new HttpError(409, 'This vault has already been released.');
  }

  function ownerView(owner, keepers) {
    return {
      name: owner.name,
      email: owner.email,
      salt: owner.salt,
      kdfIterations: owner.kdf_iterations,
      wrappedKey: owner.wrapped_key,
      ciphertext: owner.ciphertext,
      vaultVersion: owner.vault_version,
      threshold: owner.threshold,
      intervalDays: owner.interval_days,
      graceDays: owner.grace_days,
      state: owner.state,
      lastSignalAt: owner.last_signal_at,
      releasedAt: owner.released_at,
      ...upcoming(owner),
      // The owner gets the sealed shares too, so they can rehearse a retrieval
      // with their Keeper Cards. They can't be opened without the cards.
      keepers: keepers.map((k) => ({ name: k.name, email: k.email, shareIndex: k.share_index, encryptedShare: k.encrypted_share })),
    };
  }

  // ---------- health and status ----------

  app.get('/healthz', wrap(async (req, res) => {
    await pool.query('SELECT 1');
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true });
  }));

  app.get('/api/status', wrap(async (req, res) => {
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM owners');
    res.json({ app: config.appName, registrationOpen: config.allowRegistration || n === 0, kdfIterations: 600000 });
  }));

  // ---------- auth ----------

  app.post('/api/prelogin', wrap(async (req, res) => {
    if (anonLimited(`pre:${req.ip}`)) throw new HttpError(429, 'Too many attempts. Please wait a few minutes.');
    const email = cleanEmail(req.body.email);
    const [rows] = await pool.query('SELECT salt, kdf_iterations FROM owners WHERE email = ?', [email]);
    res.json(rows[0]
      ? { salt: rows[0].salt, iterations: rows[0].kdf_iterations }
      : { salt: sec.fakeSalt(config.secret, email), iterations: 600000 });
  }));

  app.post('/api/register', wrap(async (req, res) => {
    if (anonLimited(`reg:${req.ip}`)) throw new HttpError(429, 'Too many attempts. Please wait a few minutes.');
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM owners');
    if (!config.allowRegistration && n > 0) throw new HttpError(403, 'New accounts are turned off on this server.');

    const email = cleanEmail(req.body.email);
    const name = cleanName(req.body.name);
    const salt = cleanB64(req.body.salt, 64, 'salt');
    const iterations = cleanIterations(req.body.iterations);
    const authKey = cleanAuthKey(req.body.authKey);
    const wrappedKey = cleanB64(req.body.wrappedKey, 200, 'wrapped key');
    const ciphertext = cleanB64(req.body.ciphertext, MAX_VAULT_CHARS, 'vault');

    const [exists] = await pool.query('SELECT id FROM owners WHERE email = ?', [email]);
    if (exists[0]) throw new HttpError(409, 'An account with this email already exists.');

    const t = now();
    let result;
    try {
      [result] = await pool.query(
        `INSERT INTO owners (email, name, salt, kdf_iterations, auth_hash, public_id, wrapped_key, ciphertext, last_signal_at, state_since, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [email, name, salt, iterations, await sec.hashAuthKey(authKey), sec.newPublicId(), wrappedKey, ciphertext, t, t, t],
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'An account with this email already exists.');
      throw err;
    }
    await startSession(res, req, result.insertId);
    res.status(201).json({ ok: true });
  }));

  app.post('/api/login', wrap(async (req, res) => {
    const email = cleanEmail(req.body.email);
    // Per-IP buckets stop guessing; the loose per-email bucket cannot be used
    // by a stranger to lock the owner out of their own vault.
    if (loginLimited(`login:${req.ip}`) || loginLimited(`login:${req.ip}:${email}`) || emailLimited(`login:${email}`)) {
      throw new HttpError(429, 'Too many attempts. Please wait 15 minutes.');
    }
    const authKey = String(req.body.authKey || '');
    const [rows] = await pool.query('SELECT id, auth_hash FROM owners WHERE email = ?', [email]);
    const stored = rows[0] ? rows[0].auth_hash : await dummyHash;
    const verified = /^[0-9a-f]{64}$/.test(authKey) && (await sec.verifyAuthKey(authKey, stored));
    if (!rows[0] || !verified) throw new HttpError(401, 'Email or password is incorrect.');
    await startSession(res, req, rows[0].id);
    try {
      await recordSignal(rows[0].id);
    } catch (err) {
      if (err.status !== 409) throw err; // a released vault can still be viewed
    }
    res.json({ ok: true });
  }));

  app.post('/api/logout', requireOwner, wrap(async (req, res) => {
    await pool.query('DELETE FROM sessions WHERE token_hash = ?', [req.sessionHash]);
    res.clearCookie('ll_session', { path: '/' });
    res.json({ ok: true });
  }));

  // ---------- owner ----------

  app.get('/api/me', requireOwner, wrap(async (req, res) => {
    const [keepers] = await pool.query('SELECT * FROM keepers WHERE owner_id = ? ORDER BY share_index', [req.owner.id]);
    res.json(ownerView(req.owner, keepers));
  }));

  // Saves carry the version they were based on, so two devices can never
  // silently overwrite each other: the second one gets a 409 and reloads.
  app.put('/api/vault', requireOwner, wrap(async (req, res) => {
    if (req.owner.state === 'released') throw new HttpError(409, 'This vault has already been released.');
    const ciphertext = cleanB64(req.body.ciphertext, MAX_VAULT_CHARS, 'vault');
    const version = cleanInt(req.body.version, 1, 2147483647, 'Vault version');
    const [result] = await pool.query(
      "UPDATE owners SET ciphertext = ?, vault_version = vault_version + 1 WHERE id = ? AND vault_version = ? AND state <> 'released'",
      [ciphertext, req.owner.id, version],
    );
    if (result.affectedRows !== 1) throw new HttpError(409, 'Your vault was changed somewhere else since you opened it. Unlock it again to load the latest version.');
    await recordSignal(req.owner.id);
    res.json({ ok: true, version: version + 1 });
  }));

  app.put('/api/settings', requireOwner, wrap(async (req, res) => {
    const intervalDays = cleanInt(req.body.intervalDays, 7, 365, 'Signal interval (days)');
    const graceDays = cleanInt(req.body.graceDays, 1, 60, 'Grace period (days)');
    await recordSignal(req.owner.id, 'interval_days = ?, grace_days = ?', [intervalDays, graceDays]);
    res.json({ ok: true });
  }));

  // Replaces the whole set of Lightkeepers. The browser also sends a vault
  // re-encrypted under a fresh key, so old Keeper Cards cannot open anything
  // even if someone kept a copy of the old database.
  app.put('/api/keepers', requireOwner, wrap(async (req, res) => {
    if (req.owner.state === 'released') throw new HttpError(409, 'This vault has already been released.');
    if (inviteLimited(`keepers:${req.owner.id}`)) throw new HttpError(429, 'You have changed your Lightkeepers several times in the last hour. Please wait a little.');
    const list = Array.isArray(req.body.keepers) ? req.body.keepers : [];
    if (list.length < 2 || list.length > 10) throw new HttpError(400, 'Choose between 2 and 10 Lightkeepers.');
    const threshold = cleanInt(req.body.threshold, 2, list.length, 'Keepers needed');
    const keepers = list.map((k) => {
      if (!k || typeof k !== 'object' || Array.isArray(k)) throw new HttpError(400, 'Invalid Lightkeeper.');
      return {
        name: cleanName(k.name),
        email: cleanEmail(k.email),
        shareIndex: cleanInt(k.shareIndex, 1, 255, 'Share index'),
        encryptedShare: cleanB64(k.encryptedShare, 200, 'keeper share'),
      };
    });
    if (new Set(keepers.map((k) => k.shareIndex)).size !== keepers.length) throw new HttpError(400, 'Share indexes must be unique.');
    if (new Set(keepers.map((k) => k.email)).size !== keepers.length) throw new HttpError(400, 'Each Lightkeeper needs their own email address.');

    const rekey = req.body.ciphertext !== undefined || req.body.wrappedKey !== undefined;
    const ciphertext = rekey ? cleanB64(req.body.ciphertext, MAX_VAULT_CHARS, 'vault') : null;
    const wrappedKey = rekey ? cleanB64(req.body.wrappedKey, 200, 'wrapped key') : null;
    const version = rekey ? cleanInt(req.body.version, 1, 2147483647, 'Vault version') : null;

    const t = now();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [upd] = await conn.query(
        `UPDATE owners SET ${SIGNAL_SQL}, threshold = ?${rekey ? ', ciphertext = ?, wrapped_key = ?, vault_version = vault_version + 1' : ''}
         WHERE id = ? AND state <> 'released'${rekey ? ' AND vault_version = ?' : ''}`,
        rekey ? [t, t, threshold, ciphertext, wrappedKey, req.owner.id, version] : [t, t, threshold, req.owner.id],
      );
      if (upd.affectedRows !== 1) {
        await conn.rollback();
        throw new HttpError(409, rekey
          ? 'Your vault was changed somewhere else since you opened it. Unlock it again to load the latest version.'
          : 'This vault has already been released.');
      }
      await conn.query('DELETE FROM keepers WHERE owner_id = ?', [req.owner.id]);
      for (const k of keepers) {
        await conn.query(
          'INSERT INTO keepers (owner_id, name, email, share_index, encrypted_share, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [req.owner.id, k.name, k.email, k.shareIndex, k.encryptedShare, t],
        );
      }
      await conn.commit();
    } catch (err) {
      try { await conn.rollback(); } catch { /* already rolled back */ }
      throw err;
    } finally {
      conn.release();
    }

    if (req.body.notify !== false) {
      for (const keeper of keepers) {
        const mail = templates.keeperInvite({ app: config.appName, owner: req.owner, keeper, threshold, count: keepers.length });
        mailer.send({ to: keeper.email, ...mail }).catch((err) => log.error(`[mail] invite to keeper failed: ${err.message}`));
      }
    }
    res.json({ ok: true, version: rekey ? version + 1 : req.owner.vault_version });
  }));

  app.post('/api/signal', requireOwner, wrap(async (req, res) => {
    await recordSignal(req.owner.id);
    res.json({ ok: true });
  }));

  // Changing the password re-wraps the same vault key, so the vault and the
  // Keeper Cards keep working. The browser proves it knows the old password.
  app.put('/api/password', requireOwner, wrap(async (req, res) => {
    if (loginLimited(`pw:${req.owner.id}`)) throw new HttpError(429, 'Too many attempts. Please wait 15 minutes.');
    const currentAuthKey = String(req.body.currentAuthKey || '');
    const ok = /^[0-9a-f]{64}$/.test(currentAuthKey) && (await sec.verifyAuthKey(currentAuthKey, req.owner.auth_hash));
    if (!ok) throw new HttpError(401, 'Your current password is incorrect.');
    const salt = cleanB64(req.body.salt, 64, 'salt');
    const iterations = cleanIterations(req.body.iterations);
    const authKey = cleanAuthKey(req.body.authKey);
    const wrappedKey = cleanB64(req.body.wrappedKey, 200, 'wrapped key');
    await pool.query('UPDATE owners SET salt = ?, kdf_iterations = ?, auth_hash = ?, wrapped_key = ? WHERE id = ?',
      [salt, iterations, await sec.hashAuthKey(authKey), wrappedKey, req.owner.id]);
    // Sign out every other device.
    await pool.query('DELETE FROM sessions WHERE owner_id = ? AND token_hash <> ?', [req.owner.id, req.sessionHash]);
    try { await recordSignal(req.owner.id); } catch (err) { if (err.status !== 409) throw err; }
    res.json({ ok: true });
  }));

  // Lets the owner confirm email delivery works, since every warning depends on it.
  app.post('/api/test-email', requireOwner, wrap(async (req, res) => {
    if (anonLimited(`mail:${req.owner.id}`)) throw new HttpError(429, 'Too many test emails. Please wait a few minutes.');
    try {
      await mailer.send({ to: req.owner.email, ...templates.testEmail({ app: config.appName, owner: req.owner }) });
    } catch (err) {
      log.error(`[mail] test email failed: ${err.message}`);
      throw new HttpError(502, 'The email could not be sent. Check the SMTP settings on the server.');
    }
    res.json({ ok: true });
  }));

  app.delete('/api/account', requireOwner, wrap(async (req, res) => {
    if (loginLimited(`del:${req.owner.id}`)) throw new HttpError(429, 'Too many attempts. Please wait 15 minutes.');
    const currentAuthKey = String(req.body.currentAuthKey || '');
    const ok = /^[0-9a-f]{64}$/.test(currentAuthKey) && (await sec.verifyAuthKey(currentAuthKey, req.owner.auth_hash));
    if (!ok) throw new HttpError(401, 'Your password is incorrect.');
    await pool.query('DELETE FROM owners WHERE id = ?', [req.owner.id]);
    res.clearCookie('ll_session', { path: '/' });
    res.json({ ok: true });
  }));

  // ---------- one-click signal from email ----------

  app.post('/api/signal/token', wrap(async (req, res) => {
    if (anonLimited(`sig:${req.ip}`)) throw new HttpError(429, 'Too many attempts. Please wait a few minutes.');
    const parsed = sec.parseSignalToken(config.secret, req.body.token);
    if (!parsed) throw new HttpError(400, 'This link is not valid.');
    const owner = await loadOwner(parsed.ownerId);
    if (!owner) throw new HttpError(400, 'This link is not valid.');
    if (owner.state === 'released') throw new HttpError(409, 'This vault has already been released.');
    if (owner.last_signal_at !== parsed.lastSignalAt) {
      return res.json({ ok: true, alreadyUsed: true, name: owner.name });
    }
    await recordSignal(owner.id);
    res.json({ ok: true, name: owner.name });
  }));

  // ---------- retrieval by Lightkeepers ----------

  app.get('/api/retrieve/:publicId', wrap(async (req, res) => {
    if (anonLimited(`ret:${req.ip}`)) throw new HttpError(429, 'Too many attempts. Please wait a few minutes.');
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.publicId);
    if (!/^[0-9a-f]{32}$/.test(id)) throw new HttpError(404, 'Not found.');
    const [rows] = await pool.query('SELECT * FROM owners WHERE public_id = ?', [id]);
    const owner = rows[0];
    if (!owner) throw new HttpError(404, 'Not found.');
    if (owner.state !== 'released') return res.json({ released: false });
    const [keepers] = await pool.query('SELECT encrypted_share FROM keepers WHERE owner_id = ?', [owner.id]);
    res.json({
      released: true,
      ownerName: owner.name,
      threshold: owner.threshold,
      releasedAt: owner.released_at,
      shares: keepers.map((k) => k.encrypted_share),
      ciphertext: owner.ciphertext,
    });
  }));

  // ---------- cron ----------

  // For a Hostinger cron job, e.g. every hour:
  //   curl -fsS -H "Authorization: Bearer YOUR_CRON_TOKEN" https://your-domain/cron/tick
  // It lives outside /api so it doesn't need the browser-only request header.
  // The token is accepted in the header only; query strings end up in logs.
  app.all('/cron/tick', wrap(async (req, res) => {
    const given = String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!config.cronToken || !sec.safeEqual(given, config.cronToken)) throw new HttpError(401, 'Bad cron token.');
    res.set('Cache-Control', 'no-store');
    res.json(await tick({ pool, mailer, config, log, now: now() }));
  }));

  // ---------- pages ----------

  const pub = path.join(__dirname, '..', 'public');
  app.get('/app', (req, res) => res.sendFile(path.join(pub, 'app.html')));
  app.get('/signal', (req, res) => res.sendFile(path.join(pub, 'signal.html')));
  app.get('/r/:publicId', (req, res) => res.sendFile(path.join(pub, 'retrieve.html')));
  app.use(express.static(pub, { extensions: ['html'], index: 'index.html', maxAge: '1h' }));

  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    if (err.type === 'entity.too.large') status = 413;
    if (status >= 500) {
      // Never log the raw error: database errors carry the full SQL with bound values.
      const where = (err.stack || '').split('\n').slice(1, 4).map((l) => l.trim()).join(' <- ');
      log.error(`[${req.method} ${req.path}] ${err.code || err.name || 'Error'}: ${String(err.message).slice(0, 200)} ${where}`);
    }
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
  });

  return app;
}

module.exports = { createApp };
