# Last Light security model

This document is for people who want to check that the server really can't read
anything. The whole cryptographic surface is two files:
[`public/js/shamir.js`](../public/js/shamir.js) and
[`public/js/llcrypto.js`](../public/js/llcrypto.js), about 250 lines together,
using only the browser's WebCrypto API.

## Keys

```
password ──PBKDF2-SHA256 (600 000 rounds, 16-byte salt)──▶ 64 bytes
                                                     ├─ authKey (32 B) ──▶ sent to server ──scrypt──▶ stored hash
                                                     └─ wrapKey (32 B) ──▶ stays in browser

vaultKey  = 32 random bytes (per account, never changes)
wrappedKey = AES-256-GCM(wrapKey, vaultKey)            ──▶ stored on server
ciphertext = AES-256-GCM(vaultKey, JSON vault)         ──▶ stored on server
```

The server sees `authKey` only. It cannot derive `wrapKey` from it (they're
independent halves of the PBKDF2 output), so it cannot unwrap `vaultKey`.

Changing the password re-wraps the same `vaultKey` under a new `wrapKey`, so Keeper
Cards keep working.

## Lightkeepers

```
shares[1..n] = Shamir-split(vaultKey, n, k)   in GF(2^8), per byte, random coefficients
code_i       = 16 random bytes, shown once as LL-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX
sealed_i     = AES-128-GCM(code_i, shares[i])   ──▶ stored on server
```

- The server holds `sealed_i` but never `code_i`. Codes are never emailed.
- A Lightkeeper's code opens exactly one share. `k` shares rebuild `vaultKey`.
- Fewer than `k` shares reveal nothing about `vaultKey` (information-theoretic
  property of Shamir's scheme).
- AES-GCM authentication means a wrong or mistyped code fails cleanly rather than
  producing garbage.
- Replacing the Lightkeepers deletes all `sealed_i`, which invalidates old cards even
  if someone kept a copy.

## Release

The server decides *when* a vault is released (state machine in
[`src/signal.js`](../src/signal.js)), but has nothing to release except ciphertext
and sealed shares. After release it serves those to anyone with the per-account
retrieval link; the link is 128 random bits and is only emailed to Lightkeepers. Even
with the link, opening the vault requires `k` Keeper Cards.

The state machine moves one step per tick and each warning stage lasts at least one
full grace period, so a server that was down for a long time cannot jump straight to
release when it comes back.

## Server-side protections

- Login: `authKey` hashed with scrypt (N=16384, r=8, p=1) and compared in constant time.
- Rate limits per IP and per email on login, prelogin, signal links and retrieval.
- `prelogin` returns an HMAC-derived fake salt for unknown emails, so it doesn't reveal
  who has an account.
- Sessions: 256-bit random token, SHA-256 stored, `HttpOnly; SameSite=Strict; Secure`.
- CSRF: every non-GET `/api` request must carry `X-Last-Light: 1`; no CORS is ever
  granted, so browsers won't send it cross-site.
- Content-Security-Policy with `script-src 'self'`, no inline scripts, no third-party
  resources. No analytics, no CDN, no fonts from elsewhere.
- Signal links are HMAC-signed and bound to `last_signal_at`, so a link works once.
  The token travels in the URL fragment, which browsers don't send to the server in
  the page request, and the signal is only recorded on a click, so email scanners
  that pre-fetch links can't send it.
- Password change signs out other sessions. Account deletion needs the password.

## What Last Light does not protect against

- **A compromised browser or device** while the vault is unlocked.
- **A malicious server operator serving modified JavaScript.** This is inherent to
  web apps. Run your own instance (that's the point) and check the source.
- **Lightkeepers colluding** at or above the threshold the owner chose.
- **A lost password and lost cards.** There is no recovery. That is the price of the
  server knowing nothing.
- **Traffic analysis**: the server knows the owner's email, Lightkeepers' names and
  emails, and when signals happen.

## Choosing n and k

| People | Suggested k | Why |
|---|---|---|
| 2 | 2 | Both must agree. Risky if one card is lost. |
| 3 | 2 | Survives one lost card; no single person can open. Good default. |
| 4–5 | 3 | Survives two lost cards; needs a real majority. |
| 6+ | about half | Spread across family, a friend, a lawyer or accountant. |

Give cards in person where possible, and keep a sealed copy of one card with a
trusted professional if your Lightkeepers are all in one household.
