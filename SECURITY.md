# Security policy

Last Light holds the most sensitive things a person owns, so we take reports seriously.

## Reporting a problem

Please **do not** open a public issue for a security problem. Email
**hello@exaltesglobal.com** with a description and, if you can, steps to reproduce.
We aim to reply within 3 working days and to ship a fix before any public disclosure.
We'll credit you in the release notes unless you'd rather we didn't.

## What's in scope

- Anything that lets the server, a database leak, or another user read a vault
- Anything that lets fewer than `threshold` Lightkeepers open a vault
- Anything that releases a vault early, or stops a legitimate release
- Authentication, session and CSRF weaknesses
- Problems in the Shamir / AES-GCM / PBKDF2 code in `public/js/`

## What's out of scope

- Someone who already has the owner's password and device
- Lightkeepers colluding above the threshold the owner chose (that's the design)
- Denial of service against a self-hosted instance
- Issues in third-party services (your SMTP provider, your host)

## Design in one paragraph

The browser derives two keys from the password with PBKDF2 (600k rounds). One is
sent to the server, which hashes it again with scrypt and uses it only for login.
The other never leaves the browser and wraps a random 256-bit vault key. The vault
is AES-256-GCM under that key. The vault key is split with Shamir's secret sharing
in GF(256); each share is AES-GCM-sealed under a random 128-bit Keeper Card code
that is shown once and never stored or emailed. The server therefore holds only
ciphertext and sealed shares, and cannot open anything. See `docs/SECURITY-MODEL.md`.
