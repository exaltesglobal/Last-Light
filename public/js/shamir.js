// Shamir's secret sharing over GF(256), byte by byte.
// Each share is [x, y1, y2, ...] where x is the share's index (1..255).
// Runs unchanged in the browser and in Node (both expose crypto.getRandomValues).

const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);

// Build log/exp tables with generator 3 and the AES polynomial x^8 + x^4 + x^3 + x + 1.
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    let doubled = x << 1;
    if (doubled & 0x100) doubled ^= 0x11b;
    x ^= doubled;
  }
  for (let i = 255; i < 510; i++) EXP[i] = EXP[i - 255];
}

function mul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function div(a, b) {
  if (b === 0) throw new Error('division by zero');
  if (a === 0) return 0;
  return EXP[(LOG[a] + 255 - LOG[b]) % 255];
}

/**
 * Split `secret` into `n` shares, any `k` of which can rebuild it.
 * @param {Uint8Array} secret
 * @param {number} n total shares (2..255)
 * @param {number} k threshold (2..n)
 * @returns {Uint8Array[]}
 */
export function split(secret, n, k) {
  if (!(secret instanceof Uint8Array) || secret.length === 0) throw new Error('secret must be a non-empty Uint8Array');
  if (!Number.isInteger(n) || !Number.isInteger(k)) throw new Error('n and k must be integers');
  if (k < 2 || n < k || n > 255) throw new Error('need 2 <= k <= n <= 255');

  const shares = [];
  for (let i = 0; i < n; i++) {
    const share = new Uint8Array(secret.length + 1);
    share[0] = i + 1;
    shares.push(share);
  }

  const coeffs = new Uint8Array(k);
  for (let b = 0; b < secret.length; b++) {
    coeffs[0] = secret[b];
    crypto.getRandomValues(coeffs.subarray(1));
    for (let i = 0; i < n; i++) {
      const x = i + 1;
      // Horner's rule, highest coefficient first.
      let y = 0;
      for (let c = k - 1; c >= 0; c--) y = mul(y, x) ^ coeffs[c];
      shares[i][b + 1] = y;
    }
  }
  coeffs.fill(0);
  return shares;
}

/**
 * Rebuild the secret from at least `k` shares. With fewer than `k` shares the
 * result is random garbage, so callers must verify it (we use AES-GCM for that).
 * @param {Uint8Array[]} shares
 * @returns {Uint8Array}
 */
export function combine(shares) {
  if (!Array.isArray(shares) || shares.length < 2) throw new Error('need at least 2 shares');
  const len = shares[0].length;
  const xs = new Set();
  for (const s of shares) {
    if (!(s instanceof Uint8Array) || s.length !== len || len < 2) throw new Error('shares must be equal-length Uint8Arrays');
    if (s[0] === 0 || xs.has(s[0])) throw new Error('share indexes must be unique and non-zero');
    xs.add(s[0]);
  }

  // Lagrange basis values at x = 0. In GF(2^8) subtraction is XOR.
  const basis = shares.map((si, i) => {
    let l = 1;
    shares.forEach((sj, j) => {
      if (i !== j) l = mul(l, div(sj[0], sj[0] ^ si[0]));
    });
    return l;
  });

  const secret = new Uint8Array(len - 1);
  for (let b = 1; b < len; b++) {
    let v = 0;
    shares.forEach((s, i) => { v ^= mul(s[b], basis[i]); });
    secret[b - 1] = v;
  }
  return secret;
}
