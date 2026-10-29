'use strict';

// Entry point. Hostinger's Node.js runner loads this file directly (sometimes
// via require()), so it starts the server unconditionally.

const { config, checkConfig } = require('./src/config');
const { createPool, migrate } = require('./src/db');
const { createMailer } = require('./src/mailer');
const { createApp } = require('./src/app');
const { tick } = require('./src/ticker');

const problems = checkConfig();
if (problems.length) {
  console.error(`Last Light can't start:\n - ${problems.join('\n - ')}\nSee .env.example and README.md.`);
  process.exit(1);
}

const pool = createPool(config.db);
const mailer = createMailer(config.smtp);

async function runTick() {
  try {
    const s = await tick({ pool, mailer, config });
    if (s.advanced || s.reminded || s.errors) console.log(`[tick] ${JSON.stringify(s)}`);
  } catch (err) {
    console.error(`[tick] failed: ${err.message}`);
  }
}

migrate(pool)
  .then(() => {
    const app = createApp({ pool, mailer, config });
    app.listen(config.port, () => console.log(`${config.appName} is running on port ${config.port} (${config.baseUrl})`));
    if (config.tickMinutes > 0) {
      setTimeout(runTick, 10 * 1000);
      setInterval(runTick, config.tickMinutes * 60 * 1000).unref();
    }
  })
  .catch((err) => {
    console.error(`Could not set up the database: ${err.message}`);
    process.exit(1);
  });
