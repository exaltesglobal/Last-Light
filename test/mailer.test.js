'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { templates, render } = require('../src/mailer');

const owner = { name: 'Asha <b>Verma</b>', email: 'asha@example.com' };
const keeper = { name: 'Ravi & Co', email: 'ravi@example.com' };
const args = {
  app: 'Last Light',
  owner,
  keeper,
  threshold: 2,
  count: 3,
  signalUrl: 'https://ll.example/signal#1.2.abc',
  retrieveUrl: 'https://ll.example/r/0123456789abcdef0123456789abcdef',
  keepersAlertedAt: 1_700_000_000_000,
  releaseAt: 1_700_600_000_000,
};

test('every template renders text and HTML with the same facts', () => {
  for (const [name, fn] of Object.entries(templates)) {
    const mail = fn(args);
    assert.ok(mail.subject && mail.text && mail.html, `${name} has subject, text and html`);
    assert.match(mail.html, /<!doctype html>/i);
    assert.ok(mail.text.startsWith('Hi '), `${name} text greets the reader`);
    assert.ok(mail.text.trim().endsWith('— Last Light'), `${name} text signs off`);
    // links must be in both versions
    for (const url of [args.signalUrl, args.retrieveUrl]) {
      if (mail.text.includes(url)) assert.ok(mail.html.includes(url), `${name} html has the link too`);
    }
  }
});

test('HTML escapes names, text does not', () => {
  const mail = templates.keeperInvite(args);
  assert.ok(mail.html.includes('Asha &lt;b&gt;Verma&lt;/b&gt;'));
  assert.ok(!mail.html.includes('<b>Verma</b>'));
  assert.ok(mail.html.includes('Ravi &amp; Co'));
  assert.ok(mail.text.includes('Asha <b>Verma</b>'));
});

test('no email contains a Keeper Card code or forbidden words', () => {
  const banned = /\b(death|die|dead|dying|deceased|inheritance|testament)\b/i;
  for (const fn of Object.values(templates)) {
    const mail = fn(args);
    assert.doesNotMatch(mail.text, /LL-[0-9A-Z]{5}-/);
    assert.doesNotMatch(mail.text, banned);
    assert.doesNotMatch(mail.subject, banned);
  }
});

test('render() handles every paragraph kind', () => {
  const mail = render('App', {
    subject: 'S',
    greeting: 'You',
    paragraphs: ['plain', { button: { label: 'Go', url: 'https://x.test/a?b=1&c=2' } }, { note: 'small' }, { list: ['one', 'two'] }],
  });
  assert.match(mail.text, /Go:\nhttps:\/\/x\.test\/a\?b=1&c=2/);
  assert.match(mail.text, /- one\n- two/);
  assert.ok(mail.html.includes('href="https://x.test/a?b=1&amp;c=2"'));
  assert.ok(mail.html.includes('<li'));
});
