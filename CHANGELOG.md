# Changelog

All notable changes to Last Light are recorded here. Entries describe what an
owner, a Lightkeeper or an operator would notice, not which files moved.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until 1.0, a minor version bump may change behaviour; read the notes before
updating a server that people rely on.

## [Unreleased]

Nothing yet. Planned work lives in the Roadmap section of README.md.

## [0.1.0] - 2026-10-29

The first release: a complete, self-hosted Last Light that runs on a $3/month
Hostinger plan or any Docker host, with no company in the middle.

### Added

**The vault**

- Vault items with categories and a "who is this for" field, plus a starter
  checklist of the things families most often cannot find
- A letter, shown first when the vault is opened
- Everything encrypted in the browser with AES-256-GCM (WebCrypto) before it is
  saved; the server stores ciphertext only
- Auto-lock after 15 minutes idle; change password without re-issuing Keeper Cards
- Single-user or family mode (`ALLOW_REGISTRATION`)

**Lightkeepers**

- 2 to 10 Lightkeepers with an owner-chosen threshold (2 of 3, 3 of 5, ...),
  using Shamir's secret sharing over GF(256); nobody can open the vault alone
- Printable Keeper Cards; codes are typo-tolerant (case, spaces, O/0, I/1), shown
  once, and never stored or emailed
- Rehearse a retrieval: prove the cards work without sending anything to the server
- A retrieval page for Lightkeepers that works on a phone, with print and text
  download

**The signal**

- Signal by a one-click email link or by logging in, with a configurable
  interval and grace period
- Escalation emails: reminders to the owner, then alerts to Lightkeepers, then
  the release link
- A one-step-per-tick state machine, so a server outage cannot skip a warning

**Running it**

- `/cron/tick` endpoint for an hourly external cron job, plus an optional
  built-in scheduler (`TICK_MINUTES`)
- Health check at `/healthz` and a test-email button
- Step-by-step Hostinger guide for shared hosting and VPS, a Dockerfile and a
  `docker compose` setup
- No build step, no framework, three runtime dependencies, about 2 500 lines
  including HTML and CSS
- Tests for the crypto, the state machine and a full end-to-end life of a vault
  against a real MariaDB in CI

### Security

- Password stretched with PBKDF2-SHA256 (600 000 rounds) into two independent
  keys; the server only ever receives the login half and hashes it again with
  scrypt
- Content Security Policy with no inline scripts, no third-party resources and
  no analytics
- Rate limits, constant-time comparisons, HttpOnly/SameSite=Strict sessions, a
  CSRF header and signed single-use signal links

[Unreleased]: https://github.com/exaltesglobal/last-light/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/exaltesglobal/last-light/releases/tag/v0.1.0
