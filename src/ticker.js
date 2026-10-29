'use strict';

const { nextState, reminderDue, upcoming } = require('./signal');
const { templates } = require('./mailer');
const { signalToken } = require('./security');

// One pass over every owner who has Lightkeepers set up. Safe to run from the
// built-in timer and a cron job at the same time: every state change is a
// conditional UPDATE, and emails go out only from the call that won it.
async function tick({ pool, mailer, config, log = console, now = Date.now() }) {
  const [owners] = await pool.query("SELECT * FROM owners WHERE state <> 'released' AND threshold > 0");
  const summary = { checked: owners.length, advanced: 0, reminded: 0, errors: 0 };

  for (const owner of owners) {
    try {
      const next = nextState(owner, now);
      if (next) {
        const [res] = await pool.query(
          'UPDATE owners SET state = ?, state_since = ?, last_reminder_at = ?, released_at = ? WHERE id = ? AND state = ? AND last_signal_at = ?',
          [next, now, now, next === 'released' ? now : null, owner.id, owner.state, owner.last_signal_at],
        );
        if (res.affectedRows === 1) {
          summary.advanced += 1;
          await announce({ pool, mailer, config, owner: { ...owner, state: next, state_since: now }, stage: next });
        }
      } else if (reminderDue(owner, now, config.reminderHours)) {
        const [res] = await pool.query(
          'UPDATE owners SET last_reminder_at = ? WHERE id = ? AND state = ? AND last_signal_at = ? AND (last_reminder_at <=> ?)',
          [now, owner.id, owner.state, owner.last_signal_at, owner.last_reminder_at],
        );
        if (res.affectedRows === 1) {
          summary.reminded += 1;
          await mailer.send(ownerMail(config, owner, owner.state));
        }
      }
    } catch (err) {
      summary.errors += 1;
      log.error(`[tick] owner ${owner.id}: ${err.message}`);
    }
  }
  return summary;
}

function ownerMail(config, owner, stage) {
  const t = upcoming(owner);
  const signalUrl = `${config.baseUrl}/signal#${signalToken(config.secret, owner)}`;
  const args = { app: config.appName, owner, signalUrl, ...t };
  const mail = stage === 'overdue' ? templates.ownerOverdue(args) : templates.ownerGoingDark(args);
  return { to: owner.email, ...mail };
}

async function announce({ pool, mailer, config, owner, stage }) {
  const app = config.appName;
  if (stage === 'overdue') {
    await mailer.send(ownerMail(config, owner, stage));
    return;
  }
  const [keepers] = await pool.query('SELECT name, email FROM keepers WHERE owner_id = ?', [owner.id]);
  const t = upcoming(owner);
  if (stage === 'going_dark') {
    await mailer.send(ownerMail(config, owner, stage));
    for (const keeper of keepers) {
      await mailer.send({ to: keeper.email, ...templates.keeperGoingDark({ app, owner, keeper, releaseAt: t.releaseAt }) });
    }
  } else if (stage === 'released') {
    const retrieveUrl = `${config.baseUrl}/r/${owner.public_id}`;
    for (const keeper of keepers) {
      await mailer.send({ to: keeper.email, ...templates.keeperReleased({ app, owner, keeper, threshold: owner.threshold, retrieveUrl }) });
    }
    await mailer.send({ to: owner.email, ...templates.ownerReleased({ app, owner }) });
  }
}

module.exports = { tick };
