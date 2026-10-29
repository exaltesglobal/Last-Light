#!/usr/bin/env node
'use strict';

// Guided setup for Last Light.
//
//   npm run setup                    ask a few questions, test the database and
//                                    the SMTP settings, write .env, print next steps
//   node setup.js --check            validate an existing configuration without
//                                    changing anything; exit code 0 = all good, 1 = problems
//   node setup.js --non-interactive  take every value from environment variables
//                                    (CI, Docker), generate missing secrets, write .env
//
// LAST_LIGHT_ENV_FILE=/path/to/.env makes every mode read and write that file
// instead of the .env next to this script; src/config.js honours the same
// variable, so the app and the wizard always look at the same file.
//
// Only Node built-ins are used, plus the two runtime packages the app already
// depends on: mysql2 for the database test and nodemailer for the SMTP test.

// Node version first, before anything that might not even parse on an old runtime.
const MIN_NODE = 20;
if (parseInt(process.versions.node.split('.')[0], 10) < MIN_NODE) {
  console.error(`Last Light needs Node.js ${MIN_NODE} or newer; this is ${process.version}.`);
  console.error('Install a current LTS from https://nodejs.org, or pick Node 20+ for the app in hPanel.');
  process.exit(1);
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');
const readline = require('readline/promises');

const ROOT = __dirname;
const ENV_FILE = process.env.LAST_LIGHT_ENV_FILE ? path.resolve(process.env.LAST_LIGHT_ENV_FILE) : path.join(ROOT, '.env');

// Keys the wizard owns, in the order they are written. Anything else found in an
// existing .env is kept verbatim at the end of the file.
const MANAGED_KEYS = [
  'BASE_URL', 'APP_NAME', 'APP_SECRET', 'CRON_TOKEN', 'ALLOW_REGISTRATION',
  'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM',
  'TICK_MINUTES', 'REMINDER_HOURS', 'PORT', 'NODE_ENV',
];

const DEFAULTS = {
  BASE_URL: 'http://localhost:3000',
  APP_NAME: 'Last Light',
  ALLOW_REGISTRATION: 'false',
  DB_HOST: '127.0.0.1',
  DB_PORT: '3306',
  DB_NAME: 'lastlight',
  SMTP_PORT: '465',
  TICK_MINUTES: '60',
  REMINDER_HOURS: '24',
  PORT: '3000',
};

// Offered as the SMTP host in the wizard only; an unattended run leaves SMTP off unless asked.
const HOSTINGER_SMTP = 'smtp.hostinger.com';

// Same limits as checkConfig() in src/config.js.
const MIN_SECRET = 32;
const MIN_CRON_TOKEN = 24;

// ---------- output helpers ----------

const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => paint('1', s);
const dim = (s) => paint('2', s);

const say = (s = '') => process.stdout.write(`${s}\n`);
const ok = (s) => say(`  ${paint('32', '✓')} ${s}`);
const bad = (s) => say(`  ${paint('31', '✗')} ${s}`);
const warn = (s) => say(`  ${paint('33', '!')} ${s}`);
const note = (s) => say(`  ${dim(s)}`);

function banner(title) {
  say();
  say(bold(title));
  say(dim('─'.repeat(title.length)));
}

// Never let a password slip into the terminal through an error message.
function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (s) out = out.split(s).join('••••');
  return out;
}

function describeError(err, secrets = []) {
  const msg = err && err.message ? err.message : String(err);
  return redact(err && err.code ? `${err.code}: ${msg}` : msg, secrets);
}

// The runtime packages are only needed for the connection tests, so load them
// late and explain what to do when `npm install` hasn't been run yet.
function loadDep(name) {
  try {
    return require(name);
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
    throw new Error(`The package "${name}" is not installed. Run "npm install" in ${ROOT} first.`);
  }
}

// ---------- .env reading and writing ----------

// The same line format loadDotEnv() in src/config.js accepts: KEY=value or
// export KEY=value, optional matching quotes, an inline "# comment" after the value.
const ENV_LINE = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/;
function parseEnvValue(raw) {
  const value = raw.trim();
  const quoted = value.match(/^(['"])(.*)\1\s*(?:#.*)?$/);
  if (quoted) return quoted[2];
  return value.replace(/\s+#.*$/, '').trim();
}

/** Parses a .env file into { values, extras }: values by key (first wins, as in the app) and verbatim lines for keys the wizard doesn't manage. */
function readEnvFile(file) {
  const values = {};
  const extras = [];
  if (!fs.existsSync(file)) return { values, extras, exists: false };
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(ENV_LINE);
    if (!m || values[m[1]] !== undefined) continue;
    values[m[1]] = parseEnvValue(m[2]);
    if (!MANAGED_KEYS.includes(m[1])) extras.push(line);
  }
  return { values, extras, exists: true };
}

/** Puts the file's values into process.env the way src/config.js does: real environment variables win over the file. */
function applyEnvFile(file) {
  const { values } = readEnvFile(file);
  for (const [k, v] of Object.entries(values)) if (process.env[k] === undefined) process.env[k] = v;
}

/**
 * Asks the app's own rule book, checkConfig() in src/config.js, whether it would
 * start with these values. config.js reads process.env once, when first required,
 * so this runs once per process and only after every value is settled.
 */
function appProblems(values) {
  for (const key of MANAGED_KEYS) process.env[key] = values[key] === undefined ? '' : String(values[key]);
  return require('./src/config').checkConfig();
}

// Quote the way .env.example does, only when needed (spaces, # or quotes).
function envValue(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /^\s|\s$|[\s#"']/.test(s) ? `"${s}"` : s;
}

function renderEnv(v, extras) {
  const lines = [
    '# Last Light configuration, written by `npm run setup` (run it again to change',
    '# things, or edit by hand). On Hostinger web hosting you can instead set these in',
    '# hPanel (Websites → Node.js app → Environment variables).',
    '',
    '# Where people reach the app. Used in every email link.',
    `BASE_URL=${envValue(v.BASE_URL)}`,
    `APP_NAME=${envValue(v.APP_NAME)}`,
    '',
    '# Long random strings, generated by the wizard. Keep them secret; changing',
    '# APP_SECRET invalidates signal links that are already in people\'s inboxes.',
    `APP_SECRET=${envValue(v.APP_SECRET)}`,
    `CRON_TOKEN=${envValue(v.CRON_TOKEN)}`,
    '',
    '# true = anyone can create a vault on this server (a family server, a public one).',
    '# false = only the first account can register; after that sign-ups are closed.',
    `ALLOW_REGISTRATION=${envValue(v.ALLOW_REGISTRATION)}`,
    '',
    '# MySQL / MariaDB. On Hostinger shared hosting use 127.0.0.1 (never the srvNNNN host).',
    `DB_HOST=${envValue(v.DB_HOST)}`,
    `DB_PORT=${envValue(v.DB_PORT)}`,
    `DB_USER=${envValue(v.DB_USER)}`,
    `DB_PASSWORD=${envValue(v.DB_PASSWORD)}`,
    `DB_NAME=${envValue(v.DB_NAME)}`,
    '',
    '# SMTP for reminders. For a Hostinger mailbox:',
    '#   SMTP_HOST=smtp.hostinger.com  SMTP_PORT=465  SMTP_USER=you@yourdomain.com',
    '# Leave SMTP_HOST empty to print emails to the log instead (local development only).',
    `SMTP_HOST=${envValue(v.SMTP_HOST)}`,
    `SMTP_PORT=${envValue(v.SMTP_PORT)}`,
    `SMTP_USER=${envValue(v.SMTP_USER)}`,
    `SMTP_PASSWORD=${envValue(v.SMTP_PASSWORD)}`,
    `SMTP_FROM=${envValue(v.SMTP_FROM)}`,
    '',
    '# The built-in scheduler checks signals every TICK_MINUTES while the app runs.',
    '# Set 0 to rely only on an external cron job calling /cron/tick (recommended on',
    '# hosts that put idle apps to sleep). Both can be on at the same time safely.',
    `TICK_MINUTES=${envValue(v.TICK_MINUTES)}`,
    '# How often to repeat reminder emails while a signal is overdue.',
    `REMINDER_HOURS=${envValue(v.REMINDER_HOURS)}`,
    '',
    `PORT=${envValue(v.PORT)}`,
    '# "production" marks session cookies Secure (needs https) and insists on SMTP.',
    `NODE_ENV=${envValue(v.NODE_ENV)}`,
  ];
  if (extras.length) lines.push('', '# Settings kept from the previous .env (not managed by the wizard).', ...extras);
  lines.push('');
  return lines.join('\n');
}

/** Writes the file readable by the owner only, through a temp file so a crash never leaves a half-written .env. */
function writeEnvFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600); // the file may have existed before with wider permissions
}

// ---------- validation ----------

function cleanBaseUrl(input) {
  const s = String(input || '').trim();
  let url;
  try { url = new URL(s); } catch { url = null; }
  if (!url || !/^https?:$/.test(url.protocol) || !url.hostname) {
    throw new Error('Must be a full address starting with http:// or https://, e.g. https://vault.yourdomain.com');
  }
  if (url.search || url.hash) throw new Error('Leave out the ?query and #fragment parts.');
  return s.replace(/\/+$/, '');
}

function cleanInt(min, max, label) {
  return (input) => {
    const s = String(input).trim();
    const n = Number(s);
    if (!/^\d+$/.test(s) || n < min || n > max) throw new Error(`${label} must be a whole number between ${min} and ${max}.`);
    return String(n);
  };
}

const cleanPort = cleanInt(1, 65535, 'The port');
const cleanMinutes = cleanInt(0, 1440, 'TICK_MINUTES'); // the app's own limit: at most a day

function cleanRequired(input) {
  const s = String(input).trim();
  if (!s) throw new Error('This one is needed; please type a value.');
  return s;
}

const isLocalHost = (h) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(h).toLowerCase());

// ---------- prompting ----------

// readline writes through this instead of straight to the terminal, so a
// password can be typed "in the dark": while muted, everything readline would
// echo (the characters, cursor moves, redraws) is dropped. Line editing still
// works, nothing is shown. readline/promises has no public hook for this, which
// is why the output stream is wrapped rather than the interface patched.
class MutedOutput extends Writable {
  constructor(target) {
    super({ decodeStrings: false });
    this.target = target;
    this.muted = false;
    if (typeof target.on === 'function') target.on('resize', () => this.emit('resize'));
  }
  get isTTY() { return this.target.isTTY; }
  get columns() { return this.target.columns; }
  get rows() { return this.target.rows; }
  _write(chunk, encoding, callback) {
    if (!this.muted) this.target.write(chunk);
    callback();
  }
}

class Cancelled extends Error {}

function createPrompter() {
  const out = new MutedOutput(process.stdout);
  // Masking needs a real terminal. With piped input readline doesn't echo at
  // all, so secrets fall back to plain (still invisible) reads.
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = readline.createInterface({ input: process.stdin, output: out, terminal, historySize: 0 });

  // Lines are taken from a queue rather than rl.question(): piped answers
  // (`printf 'a\nb\n' | node setup.js`) arrive in one chunk, and readline drops
  // lines that show up while no question is pending. The queue keeps them.
  const pending = []; // answers that arrived before they were asked for
  const waiters = []; // asks waiting for the next line
  const CLOSED = Symbol('closed');
  let closed = false;
  rl.on('line', (line) => (waiters.length ? waiters.shift()(line) : pending.push(line)));
  rl.on('close', () => {
    // Input ended (Ctrl+D, or piped answers ran out) with the wizard unfinished.
    closed = true;
    while (waiters.length) waiters.shift()(CLOSED);
  });
  const nextLine = () => {
    if (pending.length) return Promise.resolve(pending.shift());
    if (closed) return Promise.resolve(CLOSED);
    return new Promise((resolve) => waiters.push(resolve));
  };

  function cancel() {
    out.muted = false;
    rl.close(); // restores the terminal from raw mode
    say('\n\nSetup cancelled. Nothing was written to .env.');
    process.exit(130);
  }
  rl.on('SIGINT', cancel); // Ctrl+C while readline owns the terminal
  process.on('SIGINT', cancel); // Ctrl+C when input is piped

  /**
   * Asks one question. `def` is shown in brackets and used on Enter; `clean`
   * normalises/validates and throws with a message to re-ask; `secret` hides
   * what is typed. `keep` is the value Enter keeps for a secret (never shown).
   */
  async function ask(label, { def, clean, secret, keep } = {}) {
    for (;;) {
      const hint = secret ? (keep ? ' [keep current]' : '') : (def !== undefined && def !== '' ? ` [${def}]` : '');
      // readline owns the prompt text so its redraws (backspace etc.) keep it.
      rl.setPrompt(`${label}${hint}: `);
      rl.prompt(); // written before muting, so the question itself stays visible
      const queued = pending.length > 0;
      if (secret && terminal && !queued) out.muted = true;
      let answer;
      try {
        answer = await nextLine();
      } finally {
        if (out.muted) {
          out.muted = false;
          out.write('\n'); // readline's own newline was swallowed
        } else if (queued || !terminal) {
          out.write('\n'); // nothing was echoed, so start the next prompt on its own line
        }
      }
      if (answer === CLOSED) throw new Cancelled('input ended');
      let value = String(answer).trim();
      if (value === '' && secret && keep) return keep;
      if (value === '' && def !== undefined) value = def;
      if (!clean) return value;
      try {
        return clean(value);
      } catch (err) {
        bad(err.message);
      }
    }
  }

  async function askYesNo(label, def) {
    for (;;) {
      const v = (await ask(`${label} ${def ? '[Y/n]' : '[y/N]'}`)).toLowerCase();
      if (v === '') return def;
      if (['y', 'yes'].includes(v)) return true;
      if (['n', 'no'].includes(v)) return false;
      bad('Please answer y or n.');
    }
  }

  return { ask, askYesNo, close: () => rl.close() };
}

// ---------- database ----------

function dbHint(err, db) {
  switch (err.code) {
    case 'ER_ACCESS_DENIED_ERROR':
      return 'Check DB_USER and DB_PASSWORD (the database user\'s password, not your hosting login).';
    case 'ER_DBACCESS_DENIED_ERROR':
      return `The user exists but may not use "${db.database}". Grant it all privileges on that database (hPanel → Databases → MySQL Databases → the user's permissions).`;
    case 'ER_BAD_DB_ERROR':
      return `The database "${db.database}" does not exist. Create it first (hPanel → Databases → MySQL Databases), then run setup again.`;
    case 'ER_HOST_NOT_PRIVILEGED':
      return 'The user is not allowed to connect from this machine. On Hostinger connect from the app itself with DB_HOST=127.0.0.1; from elsewhere, add your IP under Remote MySQL.';
    case 'ECONNREFUSED':
      return `Nothing is listening on ${db.host}:${db.port}. Is MySQL/MariaDB running? On Hostinger use DB_HOST=127.0.0.1 (not the srvNNNN.hstgr.io address).`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `The host name "${db.host}" does not resolve. On Hostinger use 127.0.0.1; with docker compose the host is "db".`;
    case 'ETIMEDOUT':
      return 'The connection timed out. A firewall may block the port, or the database only accepts connections from inside the server.';
    default:
      return null;
  }
}

/**
 * Connects, runs SELECT 1, then creates the tables with the app's own
 * migration so the first `npm start` has nothing left to do.
 */
async function testDatabase(db) {
  loadDep('mysql2/promise'); // friendlier failure than src/db.js's own require when npm install was skipped
  const { createPool, migrate } = require('./src/db');
  const pool = createPool({ ...db, connectTimeout: 10000 });
  try {
    const [[row]] = await pool.query('SELECT 1 AS one, VERSION() AS version');
    if (row.one !== 1) throw new Error('Unexpected answer to SELECT 1.');
    await migrate(pool);
    return { version: String(row.version) };
  } finally {
    await pool.end().catch(() => {});
  }
}

/** Read-only variant for --check: can we connect, and has the app created its tables yet? */
async function inspectDatabase(db) {
  loadDep('mysql2/promise');
  const { createPool } = require('./src/db');
  const pool = createPool({ ...db, connectTimeout: 10000 });
  try {
    const [[row]] = await pool.query('SELECT 1 AS one, VERSION() AS version');
    const [tables] = await pool.query("SHOW TABLES LIKE 'owners'");
    let vaults = null;
    if (tables.length) [[{ vaults }]] = await pool.query('SELECT COUNT(*) AS vaults FROM owners');
    return { version: String(row.version), hasTables: tables.length > 0, vaults };
  } finally {
    await pool.end().catch(() => {});
  }
}

// ---------- SMTP ----------

function smtpHint(err, smtp) {
  switch (err.code) {
    case 'EAUTH':
      return 'The mail server rejected the login. SMTP_USER is the full mailbox address and SMTP_PASSWORD is that mailbox\'s own password (not your hPanel password).';
    case 'ECONNECTION':
    case 'ETIMEDOUT':
    case 'ESOCKET':
      return `Could not reach ${smtp.host}:${smtp.port}. For a Hostinger mailbox use smtp.hostinger.com with port 465. Some servers block outgoing port 25; 465 and 587 are normally open.`;
    case 'EDNS':
      return `The host name "${smtp.host}" does not resolve. Check SMTP_HOST for typos.`;
    case 'ETLS':
    case 'EPROTOCOL':
      return 'TLS handshake failed. Port 465 expects SSL from the start and 587 uses STARTTLS; make sure SMTP_PORT matches what your provider says.';
    case 'EENVELOPE':
      return 'The sender or recipient address was refused. SMTP_FROM must be the mailbox address itself (or an alias of it).';
    default:
      return null;
  }
}

// Same transport settings as createMailer() in src/mailer.js, with timeouts so a
// wrong host fails in seconds rather than minutes.
function smtpTransport(smtp) {
  const nodemailer = loadDep('nodemailer');
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.password },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
}

async function testSmtp(smtp) {
  const transport = smtpTransport(smtp);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

async function sendTestEmail(smtp, appName, to) {
  const transport = smtpTransport(smtp);
  try {
    await transport.sendMail({
      from: smtp.from,
      to,
      subject: `${appName}: test email`,
      text: `Hi,

This is a test from your ${appName} setup. If you can read it, reminder emails will reach you too.

Add this sender to your contacts so future messages don't land in spam.

— ${appName}`,
    });
  } finally {
    transport.close();
  }
}

// ---------- shared pieces ----------

const newSecret = (bytes) => crypto.randomBytes(bytes).toString('hex');

/** Keeps a usable existing secret (changing APP_SECRET would break links already sent); otherwise makes a fresh one. */
function settleSecret(existing, minLength, bytes) {
  const have = String(existing || '');
  if (have.length >= minLength) return { value: have, origin: 'kept from the existing configuration' };
  return { value: newSecret(bytes), origin: `generated (${bytes * 2} chars)` };
}

function toDbConfig(v) {
  return { host: v.DB_HOST, port: Number(v.DB_PORT), user: v.DB_USER, password: v.DB_PASSWORD, database: v.DB_NAME };
}

function toSmtpConfig(v) {
  return { host: v.SMTP_HOST, port: Number(v.SMTP_PORT), user: v.SMTP_USER, password: v.SMTP_PASSWORD, from: v.SMTP_FROM || v.SMTP_USER };
}

const cronCommand = (v) => `curl -fsS -H "Authorization: Bearer ${v.CRON_TOKEN}" ${v.BASE_URL}/cron/tick >/dev/null`;

function printSummary(v, secrets, status) {
  banner('Summary');
  const rows = [
    ['BASE_URL', v.BASE_URL],
    ['APP_NAME', v.APP_NAME],
    ['ALLOW_REGISTRATION', `${v.ALLOW_REGISTRATION} ${dim(v.ALLOW_REGISTRATION === 'true' ? '(anyone with the link)' : '(just me: first account only)')}`],
    ['Database', `${v.DB_USER}@${v.DB_HOST}:${v.DB_PORT}/${v.DB_NAME} ${dim(status.db)}`],
    ['SMTP', v.SMTP_HOST ? `${v.SMTP_USER} via ${v.SMTP_HOST}:${v.SMTP_PORT} ${dim(status.smtp)}` : dim('off: emails are printed to the server log')],
    ['TICK_MINUTES', v.TICK_MINUTES],
    ['PORT', v.PORT],
    ['NODE_ENV', v.NODE_ENV],
    ['APP_SECRET', secrets.APP_SECRET],
    ['CRON_TOKEN', secrets.CRON_TOKEN],
    ['Written to', `${ENV_FILE} ${dim('(mode 0600: readable only by you)')}`],
  ];
  for (const [k, val] of rows) say(`  ${k.padEnd(20)} ${val}`);
}

function printNextSteps(v, cron) {
  banner('Next steps');
  say('  1. Start the app:');
  say(`       ${bold('npm start')}          ${dim('(or, on a VPS: docker compose up -d)')}`);
  say('  2. Add an hourly cron job so signals are checked even while the app sleeps');
  say('     (hPanel → Advanced → Cron Jobs, or `crontab -e` on a VPS with the prefix 0 * * * *):');
  say(`       ${cron}`);
  say(`  3. Open ${bold(v.BASE_URL)} and create the first vault.`);
  say('     Then use Signal → Send a test email to make sure reminders arrive.');
  say();
  say(`  Check the configuration any time with: ${bold('node setup.js --check')}`);
  say();
}

// ---------- interactive wizard ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanEmail(input) {
  const s = String(input).trim();
  if (!EMAIL_RE.test(s)) throw new Error('Please enter an email address.');
  return s;
}

function cleanChoice(input) {
  const s = String(input).trim().toLowerCase();
  if (['1', 'me', 'just me'].includes(s)) return '1';
  if (['2', 'anyone', 'everyone'].includes(s)) return '2';
  throw new Error('Please answer 1 or 2.');
}

/**
 * Production mode marks session cookies Secure (so it needs https) and refuses
 * to start without SMTP (reminders are email). Anything else runs as development.
 */
const nodeEnvFor = (baseUrl, smtpHost) => (baseUrl.startsWith('https://') && smtpHost ? 'production' : 'development');

async function runWizard() {
  const existing = readEnvFile(ENV_FILE);
  const old = existing.values;
  const p = createPrompter();
  try {
    banner('Last Light setup');
    say('A few questions, a quick database and email test, then a .env file.');
    say('Press Enter to accept the value shown in [brackets]. Ctrl+C quits without writing anything.');

    if (existing.exists) {
      say();
      warn(`There is already a configuration at ${ENV_FILE}.`);
      if (!(await p.askYesNo('Update it? (its values become the defaults)', false))) {
        say();
        say(`Left untouched. To validate it, run: ${bold('node setup.js --check')}`);
        return 0;
      }
    }
    const d = (key) => (old[key] ? old[key] : DEFAULTS[key]);
    const v = {};

    banner('Where people will open the app');
    note('The public address, used in every email link: https://vault.yourdomain.com on a');
    note('server, or http://localhost:3000 to try it out on this machine.');
    v.BASE_URL = await p.ask('BASE_URL', { def: d('BASE_URL'), clean: cleanBaseUrl });
    v.APP_NAME = await p.ask('APP_NAME', { def: d('APP_NAME'), clean: cleanRequired });

    banner('Who can create a vault on this server?');
    say('  1) just me: the first account only; sign-ups close after that');
    say('  2) anyone with the link: a family server, or a public one');
    const choice = await p.ask('Choose', { def: old.ALLOW_REGISTRATION === 'true' ? '2' : '1', clean: cleanChoice });
    v.ALLOW_REGISTRATION = choice === '2' ? 'true' : 'false';

    banner('Database (MySQL or MariaDB)');
    note('On Hostinger: hPanel → Databases → MySQL Databases. The host is 127.0.0.1, not srvNNNN.hstgr.io.');
    let dbDefaults = { host: d('DB_HOST'), port: d('DB_PORT'), user: old.DB_USER || '', password: old.DB_PASSWORD || '', name: d('DB_NAME') };
    let dbStatus;
    for (;;) {
      v.DB_HOST = await p.ask('DB_HOST', { def: dbDefaults.host, clean: cleanRequired });
      v.DB_PORT = await p.ask('DB_PORT', { def: dbDefaults.port, clean: cleanPort });
      v.DB_USER = await p.ask('DB_USER', { def: dbDefaults.user, clean: cleanRequired });
      v.DB_PASSWORD = await p.ask('DB_PASSWORD', { secret: true, keep: dbDefaults.password });
      v.DB_NAME = await p.ask('DB_NAME', { def: dbDefaults.name, clean: cleanRequired });
      process.stdout.write('  Connecting… ');
      try {
        const { version } = await testDatabase(toDbConfig(v));
        say(`${paint('32', '✓')} connected (${version}); tables are ready.`);
        dbStatus = '✓ connected, tables ready';
        break;
      } catch (err) {
        say(paint('31', '✗'));
        bad(describeError(err, [v.DB_PASSWORD]));
        const hint = dbHint(err, toDbConfig(v));
        if (hint) note(`Hint: ${hint}`);
        dbDefaults = { host: v.DB_HOST, port: v.DB_PORT, user: v.DB_USER, password: v.DB_PASSWORD, name: v.DB_NAME };
        if (await p.askYesNo('Re-enter the database details?', true)) continue;
        warn('Continuing without a working database. The app will not start until this is fixed.');
        dbStatus = '✗ not verified';
        break;
      }
    }

    banner('Reminder emails');
    note('Last Light emails you when a signal is due, and your Lightkeepers if you stay quiet.');
    let smtpStatus = 'off';
    let wantSmtp = await p.askYesNo('Send reminder emails via SMTP? (recommended)', true);
    if (!wantSmtp && v.BASE_URL.startsWith('https://')) {
      warn('Reminders and the release link are emails: without SMTP your Lightkeepers are never told.');
      warn('The app refuses to run in production mode without it, so skipping also sets NODE_ENV=development.');
      note('You can run setup again once you have a mailbox.');
      wantSmtp = !(await p.askYesNo('Skip SMTP anyway?', false));
    }
    if (wantSmtp) {
      note('On Hostinger: hPanel → Emails → create a mailbox such as lastlight@yourdomain.com,');
      note('then use its address and its password here.');
      let sd = { host: old.SMTP_HOST || HOSTINGER_SMTP, port: d('SMTP_PORT'), user: old.SMTP_USER || '', password: old.SMTP_PASSWORD || '', from: old.SMTP_FROM || '' };
      for (;;) {
        v.SMTP_HOST = await p.ask('SMTP_HOST', { def: sd.host, clean: cleanRequired });
        v.SMTP_PORT = await p.ask('SMTP_PORT', { def: sd.port, clean: cleanPort });
        v.SMTP_USER = await p.ask('SMTP_USER', { def: sd.user, clean: cleanRequired });
        v.SMTP_PASSWORD = await p.ask('SMTP_PASSWORD', { secret: true, keep: sd.password });
        v.SMTP_FROM = await p.ask('SMTP_FROM', { def: sd.from || `${v.APP_NAME} <${v.SMTP_USER}>`, clean: cleanRequired });
        process.stdout.write('  Checking the mail server… ');
        try {
          await testSmtp(toSmtpConfig(v));
          say(`${paint('32', '✓')} login accepted.`);
          smtpStatus = '✓ verified';
          break;
        } catch (err) {
          say(paint('31', '✗'));
          bad(describeError(err, [v.SMTP_PASSWORD]));
          const hint = smtpHint(err, toSmtpConfig(v));
          if (hint) note(`Hint: ${hint}`);
          sd = { host: v.SMTP_HOST, port: v.SMTP_PORT, user: v.SMTP_USER, password: v.SMTP_PASSWORD, from: v.SMTP_FROM };
          if (await p.askYesNo('Re-enter the email settings?', true)) continue;
          warn('Continuing with unverified email settings. Reminders will not go out until this is fixed.');
          smtpStatus = '✗ not verified';
          break;
        }
      }
      if (smtpStatus === '✓ verified' && await p.askYesNo('Send a test email now?', true)) {
        const to = await p.ask('Send it to', { def: v.SMTP_USER, clean: cleanEmail });
        process.stdout.write('  Sending… ');
        try {
          await sendTestEmail(toSmtpConfig(v), v.APP_NAME, to);
          say(`${paint('32', '✓')} sent. Check the inbox (and the spam folder) of ${to}.`);
        } catch (err) {
          say(paint('31', '✗'));
          bad(describeError(err, [v.SMTP_PASSWORD]));
          const hint = smtpHint(err, toSmtpConfig(v));
          if (hint) note(`Hint: ${hint}`);
        }
      }
    } else {
      // Switched off: keep any previous mailbox details so it is easy to turn back on.
      v.SMTP_HOST = '';
      v.SMTP_PORT = d('SMTP_PORT');
      v.SMTP_USER = old.SMTP_USER || '';
      v.SMTP_PASSWORD = old.SMTP_PASSWORD || '';
      v.SMTP_FROM = old.SMTP_FROM || '';
      note('Emails will be printed to the server log instead. Fine for trying things out, not for a real vault.');
    }

    banner('Scheduler and port');
    note('The app checks signals every TICK_MINUTES by itself; the cron job from the next');
    note('steps covers hosts that put idle apps to sleep. 0 means cron only.');
    v.TICK_MINUTES = await p.ask('TICK_MINUTES', { def: d('TICK_MINUTES'), clean: cleanMinutes });
    v.PORT = await p.ask('PORT', { def: d('PORT'), clean: cleanPort });
    v.REMINDER_HOURS = d('REMINDER_HOURS');
    v.NODE_ENV = nodeEnvFor(v.BASE_URL, v.SMTP_HOST);
    if (v.NODE_ENV === 'development') {
      note(v.BASE_URL.startsWith('https://')
        ? 'NODE_ENV=development because SMTP is off (production mode insists on it).'
        : 'NODE_ENV=development because BASE_URL is http:// (production cookies need https).');
    }

    const appSecret = settleSecret(old.APP_SECRET, MIN_SECRET, 32);
    const cronToken = settleSecret(old.CRON_TOKEN, MIN_CRON_TOKEN, 24);
    v.APP_SECRET = appSecret.value;
    v.CRON_TOKEN = cronToken.value;

    // The app's own start-up checks get the last word, so a rule added to
    // src/config.js later is caught here rather than at the first npm start.
    const problems = appProblems(v);
    if (problems.length) {
      say();
      warn('The app would refuse to start with these settings:');
      for (const pr of problems) bad(pr);
      if (!(await p.askYesNo('Write the file anyway?', false))) {
        say('\nNothing was written. Run npm run setup again to start over.');
        return 1;
      }
    }

    say();
    process.stdout.write(`Writing ${ENV_FILE}… `);
    writeEnvFile(ENV_FILE, renderEnv(v, existing.extras));
    say('done.');
    if (existing.extras.length) note(`Kept ${existing.extras.length} other setting(s) from the previous file.`);

    printSummary(v, { APP_SECRET: appSecret.origin, CRON_TOKEN: cronToken.origin }, { db: dbStatus, smtp: smtpStatus });
    printNextSteps(v, cronCommand(v));
    return 0;
  } finally {
    p.close();
  }
}

// ---------- --non-interactive ----------

async function runNonInteractive() {
  const existing = readEnvFile(ENV_FILE);
  const env = process.env;
  const pick = (key) => env[key] || existing.values[key] || DEFAULTS[key] || '';

  banner('Last Light setup (non-interactive)');
  say(`Values come from environment variables${existing.exists ? `, then ${ENV_FILE}` : ''}, then defaults.`);

  const v = {};
  for (const key of MANAGED_KEYS) v[key] = pick(key);
  const problems = [];
  const tidy = (key, clean) => {
    try { v[key] = clean(v[key]); } catch (err) { problems.push(`${key}: ${err.message}`); }
  };
  tidy('BASE_URL', cleanBaseUrl);
  tidy('DB_PORT', cleanPort);
  tidy('SMTP_PORT', cleanPort);
  tidy('PORT', cleanPort);
  tidy('TICK_MINUTES', cleanMinutes);
  v.ALLOW_REGISTRATION = v.ALLOW_REGISTRATION === 'true' ? 'true' : 'false';
  if (!v.DB_USER) problems.push('DB_USER is required.');
  if (!v.DB_NAME) problems.push('DB_NAME is required.');
  if (v.SMTP_HOST && !v.SMTP_USER) problems.push('SMTP_USER is required when SMTP_HOST is set.');
  if (v.SMTP_HOST && !v.SMTP_FROM) v.SMTP_FROM = `${v.APP_NAME} <${v.SMTP_USER}>`;
  v.NODE_ENV = env.NODE_ENV || nodeEnvFor(v.BASE_URL, v.SMTP_HOST);

  const appSecret = settleSecret(v.APP_SECRET, MIN_SECRET, 32);
  const cronToken = settleSecret(v.CRON_TOKEN, MIN_CRON_TOKEN, 24);
  v.APP_SECRET = appSecret.value;
  v.CRON_TOKEN = cronToken.value;

  // The app's own start-up checks get the last word.
  if (!problems.length) problems.push(...appProblems(v));
  if (problems.length) {
    say();
    for (const pr of problems) bad(pr);
    say('\nNothing was written. Set the variables above and run again.');
    return 1;
  }

  // Write first: the file is what CI or a provisioning script came for. The
  // connection tests follow and decide the exit code.
  writeEnvFile(ENV_FILE, renderEnv(v, existing.extras));
  say();
  ok(`Wrote ${ENV_FILE} (mode 0600)`);

  const status = { db: '✗ not verified', smtp: '✗ not verified' };
  try {
    const { version } = await testDatabase(toDbConfig(v));
    ok(`Database ${v.DB_USER}@${v.DB_HOST}:${v.DB_PORT}/${v.DB_NAME}: connected (${version}); tables are ready`);
    status.db = '✓ connected, tables ready';
  } catch (err) {
    bad(`Database ${v.DB_USER}@${v.DB_HOST}:${v.DB_PORT}/${v.DB_NAME}: ${describeError(err, [v.DB_PASSWORD])}`);
    const hint = dbHint(err, toDbConfig(v));
    if (hint) note(`Hint: ${hint}`);
  }
  if (v.SMTP_HOST) {
    try {
      await testSmtp(toSmtpConfig(v));
      ok(`SMTP ${v.SMTP_HOST}:${v.SMTP_PORT}: login accepted for ${v.SMTP_USER}`);
      status.smtp = '✓ verified';
    } catch (err) {
      bad(`SMTP ${v.SMTP_HOST}:${v.SMTP_PORT}: ${describeError(err, [v.SMTP_PASSWORD])}`);
      const hint = smtpHint(err, toSmtpConfig(v));
      if (hint) note(`Hint: ${hint}`);
    }
  } else {
    warn('SMTP_HOST is empty: emails will be printed to the server log.');
    status.smtp = 'off';
  }

  printSummary(v, { APP_SECRET: appSecret.origin, CRON_TOKEN: cronToken.origin }, status);
  // Logs of CI runs tend to be kept, so the real token stays out of them here.
  printNextSteps(v, cronCommand({ ...v, CRON_TOKEN: '$CRON_TOKEN' }));
  const failed = [status.db, status.smtp].filter((s) => s.startsWith('✗')).length;
  if (failed) say(paint('31', `${failed} check${failed === 1 ? '' : 's'} failed; the .env was still written.`));
  return failed ? 1 : 0;
}

// ---------- --check ----------

async function runCheck() {
  banner('Last Light configuration check');
  const existing = readEnvFile(ENV_FILE);
  say(`  File: ${ENV_FILE}${existing.exists ? '' : dim(' (not found: using environment variables only)')}`);
  note('Environment variables override the file, exactly as the app does.');
  say();

  applyEnvFile(ENV_FILE);
  const { config, checkConfig } = require('./src/config'); // reads process.env the way the app does
  let failures = 0;
  const fail = (s) => { failures++; bad(s); };

  ok(`Node.js ${process.version}`);

  // Required settings, as server.js would judge them on start.
  const problems = checkConfig();
  for (const pr of problems) fail(pr);
  if (!problems.length) ok(`APP_SECRET (${config.secret.length} chars), DB_USER and DB_NAME are set`);
  if (!config.cronToken) {
    // With TICK_MINUTES=0, checkConfig() has already reported the missing token.
    if (config.tickMinutes > 0) warn('CRON_TOKEN is empty, so /cron/tick is off; only the built-in scheduler (TICK_MINUTES) checks signals.');
  } else if (config.cronToken.length >= MIN_CRON_TOKEN) {
    ok(`CRON_TOKEN set (${config.cronToken.length} chars)`);
  }

  // BASE_URL: format, placeholder, scheme versus NODE_ENV.
  const rawBase = process.env.BASE_URL || '';
  try {
    const base = cleanBaseUrl(rawBase || config.baseUrl);
    const url = new URL(base);
    if (!rawBase) warn(`BASE_URL is not set; the app would use ${config.baseUrl}`);
    else if (url.hostname === 'lastlight.example.com') fail('BASE_URL is still the example value from .env.example.');
    else ok(`BASE_URL ${base}`);
    if (/\/$/.test(rawBase)) warn('BASE_URL ends with a slash; the app ignores it, but copy it without the slash into cron commands.');
    if (url.protocol === 'http:' && !isLocalHost(url.hostname)) warn('BASE_URL uses plain http://. Fine for a trial; a real vault belongs behind https.');
    if (url.protocol === 'http:' && config.production) {
      fail('NODE_ENV=production with an http:// BASE_URL: session cookies are marked Secure, so nobody can log in over plain http. Use https, or NODE_ENV=development for a local trial.');
    }
  } catch (err) {
    // checkConfig() reports a malformed BASE_URL itself; only add what it doesn't say.
    if (!problems.some((pr) => pr.startsWith('BASE_URL'))) fail(`BASE_URL "${rawBase}": ${err.message}`);
  }
  const proxy = 'trustProxy' in config ? `, trust proxy ${JSON.stringify(config.trustProxy)}` : '';
  ok(`PORT ${config.port}, TICK_MINUTES ${config.tickMinutes}, REMINDER_HOURS ${config.reminderHours}${proxy}, registration ${config.allowRegistration ? 'open to anyone' : 'first account only'}`);

  // Database: reachable, and has the app created its tables yet?
  const dbLabel = `Database ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`;
  if (config.db.user && config.db.database) {
    try {
      const r = await inspectDatabase(config.db);
      ok(`${dbLabel}: connected (${r.version})`);
      if (r.hasTables) ok(`Tables present (${r.vaults} vault${r.vaults === 1 ? '' : 's'})`);
      else warn('The owners table does not exist yet; the app creates its tables the first time it starts (so does npm run setup).');
    } catch (err) {
      fail(`${dbLabel}: ${describeError(err, [config.db.password])}`);
      const hint = dbHint(err, config.db);
      if (hint) note(`Hint: ${hint}`);
    }
  } else {
    note('Database not tested: DB_USER and DB_NAME are missing.');
  }

  // SMTP: log in, don't send.
  if (config.smtp.host) {
    try {
      await testSmtp(config.smtp);
      ok(`SMTP ${config.smtp.host}:${config.smtp.port}: login accepted for ${config.smtp.user}`);
    } catch (err) {
      fail(`SMTP ${config.smtp.host}:${config.smtp.port}: ${describeError(err, [config.smtp.password])}`);
      const hint = smtpHint(err, config.smtp);
      if (hint) note(`Hint: ${hint}`);
    }
    if (!config.smtp.from.includes('@')) warn('SMTP_FROM has no email address in it; use "Last Light <mailbox@yourdomain.com>".');
  } else if (!config.production) { // in production, checkConfig() already refuses to start without SMTP
    warn('SMTP is not configured: emails are printed to the log. Fine for a trial; a real vault needs SMTP_HOST, SMTP_USER and SMTP_PASSWORD.');
  }

  // The file holds passwords; nobody else on the machine should be able to read it.
  if (existing.exists && process.platform !== 'win32') {
    const mode = fs.statSync(ENV_FILE).mode & 0o777;
    if (mode & 0o077) warn(`${ENV_FILE} is readable by other users (mode ${mode.toString(8)}). Run: chmod 600 ${ENV_FILE}`);
    else ok(`${path.basename(ENV_FILE)} is readable only by its owner (mode ${mode.toString(8).padStart(4, '0')})`);
  }

  say();
  if (failures) {
    say(`${paint('31', `${failures} problem${failures === 1 ? '' : 's'} found.`)} Fix them in ${ENV_FILE} or run: ${bold('npm run setup')}`);
    return 1;
  }
  say(paint('32', 'All checks passed.'));
  return 0;
}

// ---------- entry point ----------

function usage() {
  say(`Usage: node setup.js [--check | --non-interactive] [--help]

  (no option)         guided setup: asks questions, tests the database and
                      SMTP, writes .env and prints the next steps
  --check             validate the current configuration without changing it;
                      exit code 1 when something needs fixing
  --non-interactive   build .env from environment variables without prompting
                      (CI, Docker); missing APP_SECRET and CRON_TOKEN are generated

  LAST_LIGHT_ENV_FILE=/path/to/.env   use that file instead of ./.env (the app reads it too)`);
}

async function main(argv) {
  const known = ['--check', '--non-interactive', '--help', '-h'];
  const unknown = argv.filter((a) => !known.includes(a));
  if (unknown.length) {
    console.error(`Unknown option: ${unknown.join(' ')}\n`);
    usage();
    return 2;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return 0;
  }
  if (argv.includes('--check') && argv.includes('--non-interactive')) {
    console.error('Use either --check or --non-interactive, not both.');
    return 2;
  }
  if (argv.includes('--check')) return runCheck();
  if (argv.includes('--non-interactive')) return runNonInteractive();
  return runWizard();
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    // Ctrl+C is handled in the prompter; this is input running out, or a real error.
    if (err instanceof Cancelled) say('\nInput ended before setup was finished. Nothing was written to .env.');
    else console.error(`\n${paint('31', 'Setup failed:')} ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  },
);
