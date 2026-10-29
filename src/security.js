'use strict';

const crypto = require('crypto');

// scrypt cost kept modest (16 MB) so it fits shared-hosting memory limits.
// The browser already ran 600k rounds of PBKDF2 before the key got here.
const SCRYPT = { N: 16384, r: 8, p: 1 };

function scrypt(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { ...params, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashAuthKey(authKey) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(authKey, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyAuthKey(authKey, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(authKey, Buffer.from(salt, 'base64'), { N: +N, r: +r, p: +p });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

/** A stable, believable salt for emails that have no account, so prelogin doesn't reveal who is registered. */
function fakeSalt(secret, email) {
  return hmac(secret, `salt:${email}`).subarray(0, 16).toString('base64');
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function newPublicId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Check-in links. The token is bound to the owner's last signal time, so it
 * works once: after a signal is recorded, older links stop working.
 */
function signalToken(secret, owner) {
  const body = `${owner.id}.${owner.last_signal_at}`;
  const sig = hmac(secret, `signal:${body}`).toString('base64url');
  return `${body}.${sig}`;
}

function parseSignalToken(secret, token) {
  const m = /^(\d+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(String(token || ''));
  if (!m) return null;
  const expected = hmac(secret, `signal:${m[1]}.${m[2]}`);
  const given = Buffer.from(m[3], 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return { ownerId: Number(m[1]), lastSignalAt: Number(m[2]) };
}

/** Small in-memory limiter: `max` hits per key per `windowMs`. Enough for one app process. */
function rateLimiter(max, windowMs) {
  const hits = new Map();
  return function limited(key, now = Date.now()) {
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      if (hits.size > 10000) {
        for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
      }
      return false;
    }
    entry.count += 1;
    return entry.count > max;
  };
}

module.exports = {
  hashAuthKey, verifyAuthKey, fakeSalt, newToken, sha256, newPublicId,
  signalToken, parseSignalToken, rateLimiter,
};
