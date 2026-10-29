'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DAY, nextState, upcoming, reminderDue } = require('../src/signal');

const T0 = 1_700_000_000_000;
const owner = (over = {}) => ({ interval_days: 30, grace_days: 7, last_signal_at: T0, state: 'active', state_since: T0, last_reminder_at: null, ...over });

test('stays active until the interval passes', () => {
  assert.equal(nextState(owner(), T0 + 29 * DAY), null);
  assert.equal(nextState(owner(), T0 + 30 * DAY), 'overdue');
});

test('moves one step per tick and each warning stage lasts a full grace period', () => {
  // Server was down for a year: still only one step at a time.
  const late = T0 + 400 * DAY;
  assert.equal(nextState(owner(), late), 'overdue');
  const o = owner({ state: 'overdue', state_since: late });
  assert.equal(nextState(o, late + 6 * DAY), null);
  assert.equal(nextState(o, late + 7 * DAY), 'going_dark');
  const g = owner({ state: 'going_dark', state_since: late + 7 * DAY });
  assert.equal(nextState(g, late + 13 * DAY), null);
  assert.equal(nextState(g, late + 14 * DAY), 'released');
});

test('normal timeline: 30 + 7 + 7 days', () => {
  assert.equal(nextState(owner({ state: 'overdue', state_since: T0 + 30 * DAY }), T0 + 36 * DAY), null);
  assert.equal(nextState(owner({ state: 'overdue', state_since: T0 + 30 * DAY }), T0 + 37 * DAY), 'going_dark');
  assert.equal(nextState(owner({ state: 'going_dark', state_since: T0 + 37 * DAY }), T0 + 44 * DAY), 'released');
});

test('released is final and a fresh signal resets the clock', () => {
  assert.equal(nextState(owner({ state: 'released' }), T0 + 999 * DAY), null);
  assert.equal(nextState(owner({ state: 'going_dark', last_signal_at: T0 + 40 * DAY, state_since: T0 + 37 * DAY }), T0 + 45 * DAY), null);
});

test('upcoming() never shows a date earlier than nextState allows', () => {
  const late = T0 + 400 * DAY;
  const t = upcoming(owner({ state: 'overdue', state_since: late }));
  assert.equal(t.keepersAlertedAt, late + 7 * DAY);
  assert.equal(t.releaseAt, late + 14 * DAY);
});

test('reminders repeat every reminderHours while in a warning stage', () => {
  assert.equal(reminderDue(owner(), T0, 24), false);
  const o = owner({ state: 'overdue', last_reminder_at: T0 });
  assert.equal(reminderDue(o, T0 + 23 * 3600e3, 24), false);
  assert.equal(reminderDue(o, T0 + 24 * 3600e3, 24), true);
  assert.equal(reminderDue(owner({ state: 'overdue' }), T0, 24), true);
});
