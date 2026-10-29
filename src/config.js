'use strict';

// Reads settings from the environment. On Hostinger, set these in hPanel
// (Websites → your Node.js app → Environment variables) or in a .env file.

const fs = require('fs');
const path = require('path');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2].trim();
    const quoted = value.match(/^(['"])(.*)\1\s*(?:#.*)?$/);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '').trim(); // strip an inline comment
    process.env[m[1]] = value;
  }
}

loadDotEnv(process.env.LAST_LIGHT_ENV_FILE || path.join(__dirname, '..', '.env'));

const env = process.env;

function int(name, fallback) {
  const v = parseInt(env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

// TRUST_PROXY: how many reverse-proxy hops sit in front of the app. 1 on
// Hostinger hosting and behind one Nginx/Caddy; 0 when clients reach Node
// directly; 2 behind a CDN plus a proxy. Also accepts Express keywords.
function trustProxy(raw) {
  const v = String(raw ?? '1').trim().toLowerCase();
  if (v === '' || v === 'false' || v === 'no' || v === 'off' || v === '0') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v; // 'loopback', 'uniquelocal', an IP or a subnet
}

const config = {
  port: int('PORT', 3000),
  baseUrl: (env.BASE_URL || 'http://localhost:3000').trim().replace(/\/+$/, ''),
  appName: (env.APP_NAME || 'Last Light').trim(),
  // Signs check-in links and keeps fake login salts stable. Must be long and secret.
  secret: env.APP_SECRET || '',
  // Protects the /cron/tick endpoint that a Hostinger cron job calls.
  cronToken: env.CRON_TOKEN || '',
  allowRegistration: env.ALLOW_REGISTRATION === 'true',
  trustProxy: trustProxy(env.TRUST_PROXY),
  db: {
    host: env.DB_HOST || '127.0.0.1',
    port: int('DB_PORT', 3306),
    user: env.DB_USER || '',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || '',
  },
  smtp: {
    host: env.SMTP_HOST || '',
    port: int('SMTP_PORT', 465),
    user: env.SMTP_USER || '',
    password: env.SMTP_PASSWORD || '',
    from: env.SMTP_FROM || env.SMTP_USER || '',
  },
  // How often the built-in scheduler checks signals, in minutes. 0 turns it off
  // (then a cron job calling /cron/tick is required).
  tickMinutes: int('TICK_MINUTES', 60),
  reminderHours: int('REMINDER_HOURS', 24),
  production: env.NODE_ENV === 'production',
};

function checkConfig() {
  const problems = [];
  if (config.secret.length < 32) problems.push('APP_SECRET must be at least 32 characters');
  if (!config.db.user || !config.db.database) problems.push('DB_USER and DB_NAME are required');
  if (config.cronToken && config.cronToken.length < 24) problems.push('CRON_TOKEN must be at least 24 characters');
  try {
    const u = new URL(config.baseUrl);
    if (!/^https?:$/.test(u.protocol)) throw new Error();
  } catch {
    problems.push('BASE_URL must be a full http(s) address, e.g. https://vault.example.com');
  }
  if (config.tickMinutes < 0 || config.tickMinutes > 1440) problems.push('TICK_MINUTES must be between 1 and 1440, or 0 to rely on cron');
  if (config.tickMinutes === 0 && !config.cronToken) problems.push('With TICK_MINUTES=0 a CRON_TOKEN is required, or signals are never checked');
  if (config.reminderHours < 1 || config.reminderHours > 168) problems.push('REMINDER_HOURS must be between 1 and 168');
  if (config.production && !config.smtp.host) problems.push('SMTP_HOST is required in production: every reminder depends on email');
  return problems;
}

module.exports = { config, checkConfig };
