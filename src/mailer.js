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
    async send({ to, subject, text }) {
      await transport.sendMail({ from: smtp.from, to, subject, text });
    },
  };
}

// Wording note: spam filters and ad platforms flag words about death, so the
// copy talks about signals, going quiet and peace of mind instead.

function fmtDate(ms) {
  return new Date(ms).toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, '');
}

const templates = {
  keeperInvite({ app, owner, keeper, threshold, count }) {
    return {
      subject: `${owner.name} has chosen you as a Lightkeeper`,
      text: `Hi ${keeper.name},

${owner.name} has chosen you as one of ${count} Lightkeepers for their ${app} vault.

What this means:
- ${owner.name} will give you a Keeper Card with a code that starts with "LL-". Keep it somewhere safe.
- You don't need to do anything else now.
- If ${owner.name} ever goes quiet for a long time, we'll email you. ${threshold} Lightkeepers together can then open what they left for you.

Your code is never sent by email. It only comes from ${owner.name}.

— ${app}`,
    };
  },

  ownerOverdue({ app, owner, signalUrl, keepersAlertedAt }) {
    return {
      subject: `${app}: please send your signal`,
      text: `Hi ${owner.name},

We haven't had a signal from you in a while. Please confirm you're OK:

${signalUrl}

If we don't hear from you by ${fmtDate(keepersAlertedAt)}, your Lightkeepers will be told you've gone quiet.

— ${app}`,
    };
  },

  ownerGoingDark({ app, owner, signalUrl, releaseAt }) {
    return {
      subject: `${app}: final reminder — your Lightkeepers have been alerted`,
      text: `Hi ${owner.name},

You've been quiet for a long time, so your Lightkeepers have been told.

If you're OK, send your signal now and everything goes back to normal:

${signalUrl}

If we don't hear from you by ${fmtDate(releaseAt)}, your Lightkeepers will be able to open your vault.

— ${app}`,
    };
  },

  keeperGoingDark({ app, owner, keeper, releaseAt }) {
    return {
      subject: `${owner.name} has gone quiet`,
      text: `Hi ${keeper.name},

${owner.name} hasn't sent their regular ${app} signal. This may be nothing, so please try to reach them.

If they stay quiet until ${fmtDate(releaseAt)}, we'll email you a link to open what they left. Have your Keeper Card ready.

— ${app}`,
    };
  },

  keeperReleased({ app, owner, keeper, threshold, retrieveUrl }) {
    return {
      subject: `${owner.name}'s Last Light is ready for you`,
      text: `Hi ${keeper.name},

${owner.name} set up ${app} so that the people they trust could reach what they left behind. Their vault is now open to their Lightkeepers.

Open it here:
${retrieveUrl}

You'll need ${threshold} Keeper Card codes, including yours. Get in touch with the other Lightkeepers and enter the codes together on that page.

— ${app}`,
    };
  },

  ownerReleased({ app, owner }) {
    return {
      subject: `${app}: your vault has been released`,
      text: `Hi ${owner.name},

We didn't receive your signal, so your vault is now open to your Lightkeepers, as you asked.

— ${app}`,
    };
  },
};

module.exports = { createMailer, templates };
