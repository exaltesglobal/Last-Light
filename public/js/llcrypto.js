// All Last Light encryption happens here, in the browser. The server only ever
// stores ciphertext, a wrapped vault key it cannot unwrap, and keeper shares it
// cannot open. Also imported by the Node test suite.

import { split, combine } from './shamir.js';

const subtle = crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITERATIONS = 600000;

// ---------- encoding helpers ----------

export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

// Crockford base32: no I, L, O or U, so codes survive being read aloud or handwritten.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function toBase32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(str, byteLength) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('invalid character');
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (out.length < byteLength) throw new Error('code too short');
  return new Uint8Array(out.slice(0, byteLength));
}

// ---------- keeper codes ----------

/** A keeper code is 16 random bytes shown as LL-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX. */
export function newKeeperCode() {
  const raw = randomBytes(16);
  return { raw, text: formatKeeperCode(raw) };
}

export function formatKeeperCode(raw) {
  const s = toBase32(raw); // 26 characters
  return 'LL-' + [s.slice(0, 5), s.slice(5, 10), s.slice(10, 15), s.slice(15, 20), s.slice(20)].join('-');
}

/** Accepts sloppy input: lowercase, spaces, missing dashes, O for 0, I/L for 1. */
export function parseKeeperCode(text) {
  let s = String(text).toUpperCase().replace(/^\s*LL[-\s]*/, '').replace(/[^0-9A-Z]/g, '');
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== 26) throw new Error('A keeper code has 26 characters after "LL-".');
  return fromBase32(s, 16);
}

// ---------- AES-GCM ----------

async function aesKey(raw) {
  return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Encrypt bytes with a raw 16- or 32-byte key. Output is base64(iv || ciphertext). */
export async function seal(rawKey, plaintext) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(rawKey), plaintext));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toB64(out);
}

/** Inverse of seal(). Throws if the key is wrong or the data was tampered with. */
export async function open(rawKey, sealedB64) {
  const data = fromB64(sealedB64);
  const iv = data.subarray(0, 12);
  const ct = data.subarray(12);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, await aesKey(rawKey), ct));
}

export async function sealJSON(rawKey, value) {
  return seal(rawKey, enc.encode(JSON.stringify(value)));
}

export async function openJSON(rawKey, sealedB64) {
  return JSON.parse(dec.decode(await open(rawKey, sealedB64)));
}

// ---------- account keys ----------

/**
 * Stretch the owner's password into two independent keys:
 *  - authKey (hex) is sent to the server to log in; the server hashes it again.
 *  - wrapKey (raw bytes) never leaves the browser; it unwraps the vault key.
 */
export async function deriveAccountKeys(password, saltB64, iterations = PBKDF2_ITERATIONS) {
  const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations },
    base,
    512,
  ));
  return { authKey: toHex(bits.subarray(0, 32)), wrapKey: bits.slice(32) };
}

export function newSalt() {
  return toB64(randomBytes(16));
}

export function newVaultKey() {
  return randomBytes(32);
}

// ---------- lightkeepers ----------

/**
 * Split the vault key among keepers. Returns, per keeper, the code to hand them
 * (never sent to the server) and their share sealed under that code (stored on the server).
 */
export async function makeKeeperShares(vaultKey, count, threshold) {
  const shares = split(vaultKey, count, threshold);
  const out = [];
  for (const share of shares) {
    const code = newKeeperCode();
    out.push({ codeText: code.text, shareIndex: share[0], encryptedShare: await seal(code.raw, share) });
    share.fill(0);
  }
  return out;
}

/**
 * Try each code against each sealed share. Returns the shares that opened, plus
 * which codes matched nothing (typos, or a card from an older set of keepers).
 */
export async function openKeeperShares(codeTexts, encryptedShares) {
  const opened = new Map(); // share index -> share bytes
  const unmatched = [];
  for (const text of codeTexts) {
    let raw;
    try {
      raw = parseKeeperCode(text);
    } catch {
      unmatched.push(text);
      continue;
    }
    let hit = false;
    for (const sealed of encryptedShares) {
      try {
        const share = await open(raw, sealed);
        opened.set(share[0], share);
        hit = true;
        break;
      } catch {
        // wrong code for this share; try the next one
      }
    }
    if (!hit) unmatched.push(text);
  }
  return { shares: [...opened.values()], unmatched };
}

export function rebuildVaultKey(shares) {
  return combine(shares);
}
