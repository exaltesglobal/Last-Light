<p align="center">
  <img src="public/favicon.svg" width="88" alt="">
</p>

<h1 align="center">Last Light</h1>

<p align="center"><strong>When you go dark, they'll still see the way.</strong></p>

<p align="center">
  A self-hosted, end-to-end encrypted vault that opens for the people you trust — only if you ever go quiet.<br>
  Runs on a $3/month Hostinger plan. No company in the middle. Ever.
</p>

<p align="center">
  <a href="https://github.com/exaltesglobal/last-light/actions/workflows/ci.yml"><img src="https://github.com/exaltesglobal/last-light/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f5b94a.svg" alt="MIT"></a>
  <img src="https://img.shields.io/badge/dependencies-3-f5b94a.svg" alt="3 runtime dependencies">
  <img src="https://img.shields.io/badge/encryption-in%20your%20browser-f5b94a.svg" alt="Encrypted in the browser">
  <a href="docs/DEPLOY-HOSTINGER.md"><img src="https://img.shields.io/badge/deploy-Hostinger-673de6.svg" alt="Deploy on Hostinger"></a>
</p>

<p align="center">
  <a href="#why">Why</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#deploy-in-15-minutes">Deploy</a> ·
  <a href="#security">Security</a> ·
  <a href="#features">Features</a> ·
  <a href="#about-agape-labs">About Agape Labs</a>
</p>

---

## Why

Everyone has a drawer their family would have to go through one day. Today that
drawer is a password manager, two-factor codes, bank logins, insurance policies,
crypto wallets, the photos in the cloud, the subscriptions that keep billing — and
nobody else has the key.

The existing answers all have the same flaw: **a company in the middle.** Google's
inactive-account tool only covers Google. Password managers' "emergency access"
locks you into that password manager. Legacy start-ups shut down, get acquired, or
change their terms. And you're asked to trust all of them with the most private
thing you own.

**Last Light removes the middle.** You run it yourself on cheap hosting. Everything
is encrypted in your browser before it's saved, so even your own server never sees
a password. The key to open it is split among the people you choose, and *they*
can only open it together, and only after you've stopped answering for a long time.

Open source, auditable, 250 lines of crypto, three dependencies. Built to run
unattended for decades.

## How it works

```
   You                          Your server (Hostinger)             Your Lightkeepers
 ───────────────────────────────────────────────────────────────────────────────────
  write vault ──encrypt──▶  stores ciphertext only
  choose 3 people ─split──▶  stores 3 sealed key pieces  ──▶  each gets a Keeper Card
                              (can't open any of them)          (a code on paper)

  every 30 days: "still here?" ──click──▶ signal recorded

  … you go quiet …
                              day 30: reminds you, daily
                              day 37: tells your Lightkeepers you've gone quiet
                              day 44: emails them a link            ──▶  any 2 of 3 enter
                                                                         their codes together
                                                                    ──▶  the vault opens,
                                                                         in their browser
```

1. **Fill your vault.** Accounts, documents, instructions, a letter. A starter
   checklist covers what families most often can't find.
2. **Choose your Lightkeepers.** 2 to 10 people. Each gets a printed **Keeper Card**.
   You decide how many must come together: 2 of 3, 3 of 5… Nobody can open it alone.
3. **Send your signal.** One click a month from an email. Logging in counts too.
4. **Last Light.** Only after repeated reminders and a long silence do your
   Lightkeepers get the link. They combine their cards and read what you left,
   starting with your letter.

## Deploy in 15 minutes

Last Light was built around what every Hostinger plan already includes — a
Node.js app, MySQL, a mailbox, cron jobs and free SSL — so you don't need a VPS,
root access or any extra service.

**[→ Step-by-step Hostinger guide](docs/DEPLOY-HOSTINGER.md)** (shared hosting *and* VPS/Docker)

The short version:

```bash
# 1. Fork this repo, create a MySQL database and a mailbox in hPanel
# 2. Add a Node.js website from your fork, entry file server.js
# 3. Paste the variables from .env.example into "Environment variables"
# 4. Add an hourly cron job:
curl -fsS -H "Authorization: Bearer $CRON_TOKEN" https://yourdomain.com/cron/tick
# 5. Open your domain, create your vault, send yourself a test email. Done.
```

Prefer Docker? `cp .env.example .env && docker compose up -d`.

Running locally:

```bash
npm install && cp .env.example .env   # set DB_* and APP_SECRET; leave SMTP_HOST empty
npm start                             # emails print to the console
```

## Security

The server is designed to be **useless to an attacker and useless to us**.

| | |
|---|---|
| Vault | AES-256-GCM, encrypted in the browser with WebCrypto |
| Password | PBKDF2-SHA256 × 600 000 → two independent keys; the server only ever gets the login half, then hashes it again with scrypt |
| Lightkeepers | Shamir's secret sharing over GF(256); each share sealed under a 128-bit Keeper Card code that is shown once and **never stored or emailed** |
| Server knows | your email, your Lightkeepers' names and emails, when you last signalled. Nothing else. |
| Server can | decide *when* to release. It has nothing to release but ciphertext. |
| Lost password | **No recovery.** That's the deal. Your Lightkeepers remain the only other way in. |

Plus the usual: CSP with no inline scripts, no third-party resources, no analytics,
rate limits, constant-time comparisons, HttpOnly/SameSite=Strict sessions, CSRF
header, signed single-use signal links, one-step-per-tick state machine so a server
outage can't skip warnings.

Full write-up: **[docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md)**. Found something?
See [SECURITY.md](SECURITY.md).

## Features

- **Vault items** with categories and "who is this for", plus a starter checklist
- **A letter**, shown first when the vault is opened
- **Lightkeepers** with printable Keeper Cards (codes are typo-tolerant: case, spaces, O/0, I/1)
- **Rehearse a retrieval** to prove your cards work, without sending anything to the server
- **Signal** by one-click email link or by logging in; configurable interval and grace period
- **Escalation emails**: reminders to you, then alerts to Lightkeepers, then the release link
- **Retrieval page** for Lightkeepers that works on a phone, with print and text download
- **Auto-lock** after 15 minutes idle; **change password** without re-issuing cards
- **Test email** button, **health check** at `/healthz`, **cron endpoint** at `/cron/tick`
- **Single-user or family mode** (`ALLOW_REGISTRATION`)
- **No build step**, no framework, 3 runtime dependencies, about 2 500 lines including HTML and CSS
- **Docker** image and `docker compose` for VPS users
- **Tested**: crypto, state machine and a full end-to-end life of a vault against real MariaDB in CI

## Project layout

```
server.js              entry point (Hostinger loads this)
src/app.js             HTTP API and pages
src/signal.js          the signal state machine (pure functions)
src/ticker.js          hourly pass: advance states, send emails
src/security.js        scrypt, HMAC links, rate limits
src/mailer.js          SMTP + the email copy
public/js/llcrypto.js  all browser-side crypto
public/js/shamir.js    Shamir's secret sharing in GF(256)
public/js/app.js       owner dashboard
public/js/retrieve.js  Lightkeeper retrieval
docs/                  deployment and security model
test/                  node --test
```

## Roadmap

- [ ] File attachments (encrypted, size-capped for shared hosting)
- [ ] Per-item visibility: "only my accountant sees this"
- [ ] Hindi, Marathi and other translations
- [ ] Optional second channel for reminders (Telegram/WhatsApp via webhooks)
- [ ] Hostinger one-click template

Ideas and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## About Agape Labs

Last Light is built and maintained by **Agape Labs**, the open-source studio of
**[Exaltes Global Private Limited](https://exaltesglobal.com)**, India.

*Agape* is the old word for love that asks nothing back. We build software for the
moments that matter most and give it away: tools that should belong to everyone,
run anywhere, and never hold your family hostage to a subscription.

We think the best infrastructure for the most personal data is **your own**, which is
why Agape Labs projects are designed from day one for affordable self-hosting — and
why we chose Hostinger as the reference platform: it's what ordinary people can
actually afford to keep running for twenty years.

If Last Light gave you peace of mind, the best thanks is a ⭐ on this repository and
telling one person who needs it.

- Website: [exaltesglobal.com](https://exaltesglobal.com)
- Email (hello, feedback, security reports): hello@exaltesglobal.com

## License

[MIT](LICENSE) © 2026 Exaltes Global Private Limited · Agape Labs

<p align="center"><sub>Made with care in India. Leave a light on.</sub></p>
