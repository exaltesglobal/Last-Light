'use strict';

const nodemailer = require('nodemailer');

// Sends mail through SMTP (Hostinger: smtp.hostinger.com, port 465, your
// mailbox address and password). Without SMTP settings, mail is printed to the
// log instead, which is handy for local development.
function createMailer(smtp, log = console) {
  if (!smtp.host) {
    return {
      async send({ to, subject, text }) {
        log.info(`[mail:dev] to=${to} subject=${subject}\n${text}\n`);
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.password },
  });
  return {
    async send({ to, subject, text, html }) {
      await transport.sendMail({ from: smtp.from, to, subject, text, html });
    },
  };
}

// Wording note: spam filters and ad platforms flag words about death, so the
// copy talks about signals, going quiet and peace of mind instead.

// Deadlines keep their time of day: the state machine moves at the exact
// minute, so "by Tuesday" would promise more time than it gives.
function fmtDate(ms) {
  const d = new Date(ms);
  const day = d.toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, '');
  return `${day}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

// ---------- rendering ----------

// Colours for the HTML version. Kept here, in one place, so the brand can be
// changed without touching the templates.
const THEME = {
  page: '#f4f1ea',
  card: '#ffffff',
  ink: '#1b1b1f',
  muted: '#6b6f78',
  line: '#e6e1d6',
  dark: '#0d1117',
  accent: '#f5b94a',
  accentInk: '#1b1305',
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Every email is described once as parts and rendered twice, as plain text
 * and as simple table-based HTML that survives every mail client.
 *
 * parts.paragraphs items can be:
 *   "text"                        a paragraph
 *   { button: { label, url } }    a big link; the text version prints the URL
 *   { note: "text" }              smaller, muted text
 *   { list: ["a", "b"] }          a short bulleted list
 */
function render(app, parts) {
  const text = [`Hi ${parts.greeting},`, ''];
  for (const p of parts.paragraphs) {
    if (typeof p === 'string') text.push(p, '');
    else if (p.button) text.push(`${p.button.label}:`, p.button.url, '');
    else if (p.note) text.push(p.note, '');
    else if (p.list) text.push(...p.list.map((li) => `- ${li}`), '');
  }
  text.push(`— ${app}`);

  const body = parts.paragraphs.map((p) => {
    if (typeof p === 'string') return `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${THEME.ink}">${esc(p)}</p>`;
    if (p.button) {
      return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 20px"><tr><td style="border-radius:999px;background:${THEME.dark}">`
        + `<a href="${esc(p.button.url)}" style="display:inline-block;padding:13px 26px;font-size:16px;font-weight:700;color:${THEME.accent};text-decoration:none;border-radius:999px">${esc(p.button.label)}</a>`
        + `</td></tr></table>`
        + `<p style="margin:-8px 0 16px;font-size:13px;line-height:1.5;color:${THEME.muted};word-break:break-all">If the button doesn't work, copy this link: ${esc(p.button.url)}</p>`;
    }
    if (p.note) return `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${THEME.muted}">${esc(p.note)}</p>`;
    if (p.list) return `<ul style="margin:0 0 16px;padding-left:20px;font-size:16px;line-height:1.6;color:${THEME.ink}">${p.list.map((li) => `<li style="margin:0 0 6px">${esc(li)}</li>`).join('')}</ul>`;
    return '';
  }).join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(parts.subject)}</title></head>
<body style="margin:0;padding:0;background:${THEME.page};font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(parts.preheader || parts.subject)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${THEME.page}"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;width:100%">
  <tr><td style="padding:0 0 16px;font-size:15px;font-weight:700;letter-spacing:.02em;color:${THEME.ink}"><span style="color:${THEME.accent};font-size:18px;line-height:0;vertical-align:-1px">&#9679;</span>&nbsp; ${esc(app)}</td></tr>
  <tr><td style="background:${THEME.card};border:1px solid ${THEME.line};border-radius:14px;padding:32px 28px">
    <h1 style="margin:0 0 18px;font-size:22px;line-height:1.3;font-weight:700;color:${THEME.ink}">${esc(parts.heading || parts.subject)}</h1>
    <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${THEME.ink}">Hi ${esc(parts.greeting)},</p>
    ${body}
    <p style="margin:8px 0 0;font-size:16px;line-height:1.6;color:${THEME.ink}">— ${esc(app)}</p>
  </td></tr>
  <tr><td style="padding:18px 8px 0;font-size:12px;line-height:1.6;color:${THEME.muted}">${esc(parts.footer || `This message was sent by ${app}, a private vault that opens for the people you trust if you ever go quiet.`)}</td></tr>
</table>
</td></tr></table>
</body></html>`;

  return { subject: parts.subject, text: text.join('\n'), html };
}

// ---------- templates ----------

const templates = {
  keeperInvite({ app, owner, keeper, threshold, count }) {
    return render(app, {
      subject: `${owner.name} has chosen you as a Lightkeeper`,
      heading: `${owner.name} has chosen you as a Lightkeeper`,
      greeting: keeper.name,
      paragraphs: [
        `${owner.name} has chosen you as one of ${count} Lightkeepers for their ${app} vault. It's a quiet kind of trust: nothing is asked of you today.`,
        { list: [
          `${owner.name} will give you a Keeper Card with a code that starts with "LL-". Keep it somewhere safe and private.`,
          `You don't need to do anything else now.`,
          `If ${owner.name} ever goes quiet for a long time, we'll email you. ${threshold} Lightkeepers together can then open what they left for you.`,
        ] },
        { note: `Your code is never sent by email. It only comes from ${owner.name}, in person or by a channel they choose.` },
      ],
    });
  },

  ownerOverdue({ app, owner, signalUrl, keepersAlertedAt }) {
    return render(app, {
      subject: `${app}: please send your signal`,
      heading: 'Still here? Please send your signal',
      preheader: 'One click is all it takes.',
      greeting: owner.name,
      paragraphs: [
        `We haven't had a signal from you in a while. Please confirm you're OK, it takes one click:`,
        { button: { label: "Yes, I'm here", url: signalUrl } },
        `If we don't hear from you before ${fmtDate(keepersAlertedAt)}, your Lightkeepers will be told you've gone quiet. Nothing is opened at that point; they're only asked to check on you.`,
      ],
    });
  },

  ownerGoingDark({ app, owner, signalUrl, releaseAt }) {
    return render(app, {
      subject: `${app}: final reminder, your Lightkeepers have been alerted`,
      heading: 'Final reminder: your Lightkeepers have been alerted',
      preheader: 'Send your signal and everything goes back to normal.',
      greeting: owner.name,
      paragraphs: [
        `You've been quiet for a long time, so your Lightkeepers have been told and asked to check on you.`,
        `If you're OK, send your signal now and everything goes back to normal:`,
        { button: { label: "I'm here", url: signalUrl } },
        `If we don't hear from you before ${fmtDate(releaseAt)}, your Lightkeepers will be able to open your vault together.`,
      ],
    });
  },

  keeperGoingDark({ app, owner, keeper, releaseAt }) {
    return render(app, {
      subject: `${owner.name} has gone quiet`,
      heading: `${owner.name} has gone quiet`,
      preheader: 'Please try to reach them.',
      greeting: keeper.name,
      paragraphs: [
        `${owner.name} hasn't sent their regular ${app} signal. This may be nothing at all, so please try to reach them in whatever way you normally would.`,
        `If they stay quiet until ${fmtDate(releaseAt)}, we'll email you a link to open what they left. Have your Keeper Card ready, and know who the other Lightkeepers are.`,
        { note: 'If you do reach them, ask them to log in or click the link in their own email. That stops everything.' },
      ],
    });
  },

  keeperReleased({ app, owner, keeper, threshold, retrieveUrl }) {
    return render(app, {
      subject: `${owner.name}'s Last Light is ready for you`,
      heading: `${owner.name} left something for you`,
      preheader: 'Open it together with the other Lightkeepers.',
      greeting: keeper.name,
      paragraphs: [
        `${owner.name} set up ${app} so that the people they trust could reach what they left behind. Their vault is now open to their Lightkeepers.`,
        { button: { label: 'Open the vault', url: retrieveUrl } },
        `You'll need ${threshold} Keeper Card codes, including yours. Get in touch with the other Lightkeepers and enter the codes together on that page: on a call, in person, or one after another. Take your time; the page will wait.`,
        { note: 'Everything is opened on your own device. Nothing you type on that page is sent anywhere.' },
      ],
      footer: `This message was sent by ${app} on behalf of ${owner.name}, who chose you as a Lightkeeper.`,
    });
  },

  ownerReleased({ app, owner }) {
    return render(app, {
      subject: `${app}: your vault has been released`,
      heading: 'Your vault has been released',
      greeting: owner.name,
      paragraphs: [
        `We didn't receive your signal, so your vault is now open to your Lightkeepers, as you asked.`,
        `If this is a mistake and you're reading this, you can log in, delete the account and create a new vault with new Keeper Cards.`,
      ],
    });
  },

  testEmail({ app, owner }) {
    return render(app, {
      subject: `${app}: test email`,
      heading: 'Your reminders will reach you',
      greeting: owner.name,
      paragraphs: [
        `This is a test from ${app}. If you're reading it, signal reminders will reach you too.`,
        { note: 'Tip: add this sender to your contacts so reminders never land in spam.' },
      ],
    });
  },
};

module.exports = { createMailer, templates, render, THEME };
