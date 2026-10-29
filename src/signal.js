'use strict';

// The Signal state machine. Pure functions only, so it is easy to test.
//
//   active ──(interval passes with no signal)──▶ overdue
//   overdue ──(grace passes)──▶ going_dark     (keepers are alerted)
//   going_dark ──(grace passes)──▶ released    (keepers can open the vault)
//
// A signal from the owner returns any state except "released" to "active".
// The machine moves at most one step per tick, and every warning stage lasts
// at least one full grace period. So if the server was offline for months, the
// owner still gets the whole warning window before anything is released.

const DAY = 24 * 60 * 60 * 1000;
const STATES = ['active', 'overdue', 'going_dark', 'released'];

/** Which state the clock alone says the owner should be in. */
function stateByClock(owner, now) {
  const due = owner.last_signal_at + owner.interval_days * DAY;
  const grace = owner.grace_days * DAY;
  if (now < due) return 'active';
  if (now < due + grace) return 'overdue';
  if (now < due + 2 * grace) return 'going_dark';
  return 'released';
}

/** The state this owner should move to on this tick, or null to stay put. */
function nextState(owner, now) {
  const current = owner.state;
  if (current === 'released') return null;
  const target = stateByClock(owner, now);
  const from = STATES.indexOf(current);
  if (STATES.indexOf(target) <= from) return null;
  if (current !== 'active' && now - owner.state_since < owner.grace_days * DAY) return null;
  return STATES[from + 1];
}

/** When the next stage could begin, for showing the owner a countdown. */
function timeline(owner) {
  const due = owner.last_signal_at + owner.interval_days * DAY;
  const grace = owner.grace_days * DAY;
  return { signalDueAt: due, keepersAlertedAt: due + grace, releaseAt: due + 2 * grace };
}

/**
 * Like timeline(), but accounts for the minimum time each warning stage lasts,
 * so dates shown to people are never earlier than what nextState() allows.
 */
function upcoming(owner) {
  const t = timeline(owner);
  const grace = owner.grace_days * DAY;
  if (owner.state === 'overdue') {
    t.keepersAlertedAt = Math.max(t.keepersAlertedAt, owner.state_since + grace);
    t.releaseAt = Math.max(t.releaseAt, t.keepersAlertedAt + grace);
  } else if (owner.state === 'going_dark') {
    t.releaseAt = Math.max(t.releaseAt, owner.state_since + grace);
  }
  return t;
}

/** Whether a reminder email is due for an owner sitting in a warning stage. */
function reminderDue(owner, now, reminderHours) {
  if (owner.state !== 'overdue' && owner.state !== 'going_dark') return false;
  if (owner.last_reminder_at == null) return true;
  return now - owner.last_reminder_at >= reminderHours * 60 * 60 * 1000;
}

module.exports = { DAY, STATES, stateByClock, nextState, timeline, upcoming, reminderDue };
