# Deploying Last Light on Hostinger

Last Light was designed around what a standard Hostinger plan gives you: a Node.js
app, a MySQL database, a mailbox, cron jobs and free SSL. No root access, no Redis,
no extra services. About 15 minutes.

There are two routes. **Shared / Business / Cloud hosting** (route A) is the cheapest
and simplest. **VPS** (route B) uses Docker and suits people who already run a server.

---

## Route A: Hostinger web hosting (Node.js app)

### 1. Fork or import the repository

Fork `exaltesglobal/last-light` on GitHub (so you get updates), or just use it directly.

### 2. Create the database

hPanel → **Websites → Manage → Databases → MySQL Databases**.
Create a database and a user, note the three values. The host for the app is
`127.0.0.1` — not the `srvNNNN.hstgr.io` address, which is only for remote tools.

### 3. Create a mailbox for reminders

hPanel → **Emails** → create something like `lastlight@yourdomain.com`.
SMTP settings are `smtp.hostinger.com`, port `465`, the mailbox address and its password.

### 4. Create the Node.js app

hPanel → **Websites → Add website → Node.js** (or **Deploy from Git** on the
website's dashboard). Point it at your repository and branch `main`.

- Entry file: `server.js`
- Node version: 20 or newer
- Build command: `npm ci --omit=dev` (or leave the default install)
- Start command: `npm start`

### 5. Set the environment variables

In the app's **Environment variables** section, add everything from `.env.example`:

| Variable | Value |
|---|---|
| `BASE_URL` | `https://yourdomain.com` (exactly as people will open it) |
| `APP_SECRET` | `openssl rand -hex 32` output (or any 64 random characters) |
| `CRON_TOKEN` | another random string |
| `ALLOW_REGISTRATION` | `false` for just you; `true` for a family or public server |
| `DB_HOST` | `127.0.0.1` |
| `DB_USER`, `DB_PASSWORD`, `DB_NAME` | from step 2 |
| `SMTP_HOST` | `smtp.hostinger.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER`, `SMTP_PASSWORD` | from step 3 |
| `SMTP_FROM` | `Last Light <lastlight@yourdomain.com>` |
| `TICK_MINUTES` | `60` |
| `NODE_ENV` | `production` |

Deploy. The app creates its own tables on first start. Open `https://yourdomain.com/healthz`
— you should see `{"ok":true}`.

### 6. Add the cron job (important)

Hosting plans may pause an idle Node process, and the signal checks must keep running
even when nobody visits. hPanel → **Advanced → Cron Jobs** → add, every hour:

```bash
curl -fsS -H "Authorization: Bearer YOUR_CRON_TOKEN" https://yourdomain.com/cron/tick >/dev/null
```

The same check also runs inside the app every `TICK_MINUTES`; running both is safe.

### 7. Create your vault and test the email

Open the site, create your vault, then **Signal → Send a test email**. If it arrives,
reminders will too. Add the sender to your contacts.

### 8. Lock registration

If this server is only for you, make sure `ALLOW_REGISTRATION=false`. The first
account can always be created; after that, sign-ups are closed.

---

## Route B: Hostinger VPS (Docker)

```bash
git clone https://github.com/exaltesglobal/last-light.git
cd last-light
cp .env.example .env     # fill it in; DB_HOST is ignored and set to "db" by compose
docker compose up -d
```

The app listens on `127.0.0.1:3000`. Put Caddy or Nginx in front for HTTPS, for example
with Caddy:

```
yourdomain.com {
    reverse_proxy 127.0.0.1:3000
}
```

Add the same hourly cron job as in route A, step 6, so ticks run even if the container
restarts rarely.

---

## Updating

Route A: push to your branch, or click **Redeploy** in hPanel. Route B:
`git pull && docker compose up -d --build`. Database changes are applied automatically
on start.

## Backups

Everything is in the MySQL database and it is all ciphertext. Back it up like any
other database (hPanel → Databases → phpMyAdmin → Export, or `mysqldump`). A backup
plus your password, or a backup plus enough Keeper Cards, is enough to recover a vault
on a fresh install. **Without those, a backup is useless by design.**

## Keeping it alive for years

- Pay for the domain and hosting several years ahead, or set them to auto-renew.
- Add the hosting account and domain registrar to your own vault, under
  "Subscriptions to cancel / keep".
- Tell one Lightkeeper where the server runs and how to renew it.
- Once a year, log in, send a signal and use **Rehearse a retrieval** with your cards.

## Troubleshooting

| Symptom | Check |
|---|---|
| `Last Light can't start: APP_SECRET must be…` | Environment variables are missing or too short. |
| `Could not set up the database` | `DB_HOST` must be `127.0.0.1`; user needs ALL privileges on the database. |
| Test email fails | SMTP port 465, the mailbox password (not the hPanel password), `SMTP_FROM` must be the mailbox address or an alias of it. |
| Email links go to the wrong domain | `BASE_URL` must be the public URL with `https://`. |
| `/cron/tick` returns 401 | The `Authorization: Bearer …` value must equal `CRON_TOKEN` exactly. |
