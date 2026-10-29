'use strict';

const { nextState, reminderDue, upcoming } = require('./signal');
const { templates } = require('./mailer');
const { signalToken } = require('./security');

// Columns the pass needs; never the ciphertext (up to 4 MB per owner).
const OWNER_COLUMNS = 'id, email, name, public_id, threshold, interval_days, grace_days, last_signal_at, state, state_since, notified_stage, announce_claimed_at, last_reminder_at, released_at';

// How long one tick may hold the right to announce a stage before another
// tick may retry it. Longer than any realistic SMTP round of emails.
const CLAIM_MS = 10 * 60 * 1000;

// One pass over every owner who has Lightkeepers set up. Safe to run from the
// built-in timer and a cron job at the same time: every state change is a
// conditional UPDATE, and emails go out only from the call that won it.
//
// Announcements are durable: a stage's emails are retried on later ticks until
// they have all been sent (notified_stage catches up with state). A mail outage
// at the release tick therefore delays the retrieval link; it never loses it.
async function tick({ pool, mailer, config, log = console, now = Date.now() }) {
  const [owners] = await pool.query(
    `SELECT ${OWNER_COLUMNS} FROM owners WHERE threshold > 0 AND (state <> 'released' OR state <> notified_stage)`,
  );
  const summary = { checked: owners.length, advanced: 0, announced: 0, reminded: 0, errors: 0 };

  for (const owner of owners) {
    try {
      const next = nextState(owner, now);
      if (next) {
        const [res] = await pool.query(
          'UPDATE owners SET state = ?, state_since = ?, last_reminder_at = ?, released_at = ?, announce_claimed_at = NULL WHERE id = ? AND state = ? AND last_signal_at = ?',
          [next, now, now, next === 'released' ? now : null, owner.id, owner.state, owner.last_signal_at],
        );
        if (res.affectedRows === 1) {
          summary.advanced += 1;
          Object.assign(owner, { state: next, state_since: now, last_reminder_at: now, announce_claimed_at: null });
        } else {
          continue; // another tick got here first; it will announce
        }
      }

      if (owner.state !== owner.notified_stage) {
        if (await deliver({ pool, mailer, config, owner, now })) summary.announced += 1;
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

  try {
    await pool.query('DELETE FROM sessions WHERE expires_at < ?', [now]);
  } catch (err) {
    log.error(`[tick] session cleanup: ${err.message}`);
  }
  return summary;
}

/** Claim the right to announce the owner's current stage, send, then mark it done. */
async function deliver({ pool, mailer, config, owner, now }) {
  const [claim] = await pool.query(
    'UPDATE owners SET announce_claimed_at = ? WHERE id = ? AND state = ? AND notified_stage <> state AND (announce_claimed_at IS NULL OR announce_claimed_at < ?)',
    [now, owner.id, owner.state, now - CLAIM_MS],
  );
  if (claim.affectedRows !== 1) return false;
  await announce({ pool, mailer, config, owner, stage: owner.state });
  await pool.query('UPDATE owners SET notified_stage = ?, announce_claimed_at = NULL WHERE id = ? AND state = ?', [owner.state, owner.id, owner.state]);
  return true;
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
  if (stage === 'active') return; // a signal arrived before the warning went out
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
