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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function cleanEmail(v) {
  const email = String(v || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 255) throw new HttpError(400, 'Please enter a valid email address.');
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

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function createApp({ pool, mailer, config, log = console, now = () => Date.now() }) {
  const app = express();
  app.set('trust proxy', 1); // Hostinger serves Node apps behind a proxy
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
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
  const anonLimited = sec.rateLimiter(60, 15 * 60 * 1000);

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
    if (!token) throw new HttpError(401, 'Please log in.');
    const [rows] = await pool.query('SELECT owner_id FROM sessions WHERE token_hash = ? AND expires_at > ?', [sec.sha256(token), now()]);
    if (!rows[0]) throw new HttpError(401, 'Your session has ended. Please log in again.');
    const owner = await loadOwner(rows[0].owner_id);
    if (!owner) throw new HttpError(401, 'Please log in.');
    req.owner = owner;
    req.sessionHash = sec.sha256(token);
    next();
  });

  /** Any deliberate action by the owner proves they're still here. */
  async function recordSignal(ownerId) {
    const t = now();
    await pool.query(
      "UPDATE owners SET last_signal_at = ?, state = 'active', state_since = ?, last_reminder_at = NULL WHERE id = ? AND state <> 'released'",
      [t, t, ownerId],
    );
  }

  function ownerView(owner, keepers) {
    return {
      name: owner.name,
      email: owner.email,
      salt: owner.salt,
      wrappedKey: owner.wrapped_key,
      ciphertext: owner.ciphertext,
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

  // ---------- auth ----------

  app.get('/healthz', wrap(async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  }));

  app.get('/api/status', wrap(async (req, res) => {
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM owners');
    res.json({ app: config.appName, registrationOpen: config.allowRegistration || n === 0 });
  }));

  app.post('/api/prelogin', wrap(async (req, res) => {
    if (anonLimited(`pre:${req.ip}`)) throw new HttpError(429, 'Too many attempts. Please wait a few minutes.');
    const email = cleanEmail(req.body.email);
    const [rows] = await pool.query('SELECT salt FROM owners WHERE email = ?', [email]);
    res.json({ salt: rows[0] ? rows[0].salt : sec.fakeSalt(config.secret, email) });
  }));

  app.post('/api/register', wrap(async (req, res) => {
    if (anonLimited(`reg:${req.ip}`)) throw new HttpError(429, 'Too many attempts. Please wait a few minutes.');
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM owners');
    if (!config.allowRegistration && n > 0) throw new HttpError(403, 'New accounts are turned off on this server.');

    const email = cleanEmail(req.body.email);
    const name = cleanName(req.body.name);
    const salt = cleanB64(req.body.salt, 64, 'salt');
    const authKey = String(req.body.authKey || '');
    if (!/^[0-9a-f]{64}$/.test(authKey)) throw new HttpError(400, 'Invalid key.');
    const wrappedKey = cleanB64(req.body.wrappedKey, 200, 'wrapped key');
    const ciphertext = cleanB64(req.body.ciphertext, MAX_VAULT_CHARS, 'vault');

    const [exists] = await pool.query('SELECT id FROM owners WHERE email = ?', [email]);
    if (exists[0]) throw new HttpError(409, 'An account with this email already exists.');

    const t = now();
    const [result] = await pool.query(
      `INSERT INTO owners (email, name, salt, auth_hash, public_id, wrapped_key, ciphertext, last_signal_at, state_since, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [email, name, salt, await sec.hashAuthKey(authKey), sec.newPublicId(), wrappedKey, ciphertext, t, t, t],
    );
    await startSession(res, req, result.insertId);
    res.status(201).json({ ok: true });
  }));

  app.post('/api/login', wrap(async (req, res) => {
    const email = cleanEmail(req.body.email);
    if (loginLimited(`login:${req.ip}`) || loginLimited(`login:${email}`)) {
      throw new HttpError(429, 'Too many attempts. Please wait 15 minutes.');
    }
    const authKey = String(req.body.authKey || '');
    const [rows] = await pool.query('SELECT id, auth_hash FROM owners WHERE email = ?', [email]);
    const ok = rows[0] && /^[0-9a-f]{64}$/.test(authKey) && (await sec.verifyAuthKey(authKey, rows[0].auth_hash));
    if (!ok) throw new HttpError(401, 'Email or password is incorrect.');
    await startSession(res, req, rows[0].id);
    await recordSignal(rows[0].id);
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

  app.put('/api/vault', requireOwner, wrap(async (req, res) => {
    if (req.owner.state === 'released') throw new HttpError(409, 'This vault has already been released.');
    const ciphertext = cleanB64(req.body.ciphertext, MAX_VAULT_CHARS, 'vault');
    await pool.query('UPDATE owners SET ciphertext = ? WHERE id = ?', [ciphertext, req.owner.id]);
    await recordSignal(req.owner.id);
    res.json({ ok: true });
  }));

  app.put('/api/settings', requireOwner, wrap(async (req, res) => {
    const intervalDays = cleanInt(req.body.intervalDays, 7, 365, 'Signal interval (days)');
    const graceDays = cleanInt(req.body.graceDays, 1, 60, 'Grace period (days)');
    await pool.query('UPDATE owners SET interval_days = ?, grace_days = ? WHERE id = ?', [intervalDays, graceDays, req.owner.id]);
    await recordSignal(req.owner.id);
    res.json({ ok: true });
  }));

  // Replaces the whole set of Lightkeepers. Old Keeper Cards stop working,
  // because the shares they opened are deleted here.
  app.put('/api/keepers', requireOwner, wrap(async (req, res) => {
    if (req.owner.state === 'released') throw new HttpError(409, 'This vault has already been released.');
    const list = Array.isArray(req.body.keepers) ? req.body.keepers : [];
    if (list.length < 2 || list.length > 10) throw new HttpError(400, 'Choose between 2 and 10 Lightkeepers.');
    const threshold = cleanInt(req.body.threshold, 2, list.length, 'Keepers needed');
    const keepers = list.map((k) => ({
      name: cleanName(k.name),
      email: cleanEmail(k.email),
      shareIndex: cleanInt(k.shareIndex, 1, 255, 'Share index'),
      encryptedShare: cleanB64(k.encryptedShare, 200, 'keeper share'),
    }));
    if (new Set(keepers.map((k) => k.shareIndex)).size !== keepers.length) throw new HttpError(400, 'Share indexes must be unique.');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM keepers WHERE owner_id = ?', [req.owner.id]);
      for (const k of keepers) {
        await conn.query(
          'INSERT INTO keepers (owner_id, name, email, share_index, encrypted_share, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [req.owner.id, k.name, k.email, k.shareIndex, k.encryptedShare, now()],
        );
      }
      await conn.query('UPDATE owners SET threshold = ? WHERE id = ?', [threshold, req.owner.id]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    await recordSignal(req.owner.id);

    if (req.body.notify !== false) {
      for (const keeper of keepers) {
        const mail = templates.keeperInvite({ app: config.appName, owner: req.owner, keeper, threshold, count: keepers.length });
        mailer.send({ to: keeper.email, ...mail }).catch((err) => log.error(`[mail] invite to keeper failed: ${err.message}`));
      }
    }
    res.json({ ok: true });
  }));

  app.post('/api/signal', requireOwner, wrap(async (req, res) => {
    if (req.owner.state === 'released') throw new HttpError(409, 'This vault has already been released.');
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
    const authKey = String(req.body.authKey || '');
    if (!/^[0-9a-f]{64}$/.test(authKey)) throw new HttpError(400, 'Invalid key.');
    const wrappedKey = cleanB64(req.body.wrappedKey, 200, 'wrapped key');
    await pool.query('UPDATE owners SET salt = ?, auth_hash = ?, wrapped_key = ? WHERE id = ?',
      [salt, await sec.hashAuthKey(authKey), wrappedKey, req.owner.id]);
    // Sign out every other device.
    await pool.query('DELETE FROM sessions WHERE owner_id = ? AND token_hash <> ?', [req.owner.id, req.sessionHash]);
    await recordSignal(req.owner.id);
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
  app.all('/cron/tick', wrap(async (req, res) => {
    const given = String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '') || String(req.query.token || '');
    if (!config.cronToken || sec.sha256(given) !== sec.sha256(config.cronToken)) throw new HttpError(401, 'Bad cron token.');
    res.set('Cache-Control', 'no-store');
    res.json(await tick({ pool, mailer, config, log, now: now() }));
  }));

  // ---------- pages ----------

  const pub = path.join(__dirname, '..', 'public');
  app.get('/app', (req, res) => res.sendFile(path.join(pub, 'app.html')));
  app.get('/signal', (req, res) => res.sendFile(path.join(pub, 'signal.html')));
  app.get('/r/:publicId', (req, res) => res.sendFile(path.join(pub, 'retrieve.html')));
  app.use(express.static(pub, { extensions: ['html'], index: 'index.html' }));

  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    if (err.type === 'entity.too.large') status = 413;
    if (status >= 500) log.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
  });

  return app;
}

module.exports = { createApp };
