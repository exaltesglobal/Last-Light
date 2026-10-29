'use strict';

// Reads settings from the environment. On Hostinger, set these in hPanel
// (Websites → your Node.js app → Environment variables) or in a .env file.

const fs = require('fs');
const path = require('path');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

const env = process.env;

function int(name, fallback) {
  const v = parseInt(env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

const config = {
  port: int('PORT', 3000),
  baseUrl: (env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  appName: env.APP_NAME || 'Last Light',
  // Signs check-in links and keeps fake login salts stable. Must be long and secret.
  secret: env.APP_SECRET || '',
  // Protects the /api/cron/tick endpoint that a Hostinger cron job calls.
  cronToken: env.CRON_TOKEN || '',
  allowRegistration: env.ALLOW_REGISTRATION === 'true',
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
  // (then rely on a cron job calling /api/cron/tick).
  tickMinutes: int('TICK_MINUTES', 60),
  reminderHours: int('REMINDER_HOURS', 24),
  production: env.NODE_ENV === 'production',
};

function checkConfig() {
  const problems = [];
  if (config.secret.length < 32) problems.push('APP_SECRET must be at least 32 characters');
  if (!config.db.user || !config.db.database) problems.push('DB_USER and DB_NAME are required');
  if (config.cronToken && config.cronToken.length < 24) problems.push('CRON_TOKEN must be at least 24 characters');
  return problems;
}

module.exports = { config, checkConfig };
