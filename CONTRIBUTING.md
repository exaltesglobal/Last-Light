# Contributing to Last Light

Thank you. This is a small codebase on purpose, so it stays easy to audit.

## Ground rules

- **No new dependencies without a reason.** Three runtime packages is the budget.
- **The server must never see plaintext or keys.** If a change needs the server to
  decrypt something, it's the wrong change.
- **Keep the copy gentle.** Avoid words about death in UI and emails; they get
  flagged by spam filters and ad platforms, and they hurt to read. Say "goes quiet",
  "if something happens", "Last Light".
- **Plain JavaScript, no build step.** Browser code in `public/js/` runs as-is.

## Running locally

```bash
npm install
cp .env.example .env     # fill in DB_* and APP_SECRET; leave SMTP_HOST empty
npm start                # emails are printed to the console
```

## Tests

```bash
npm test                                     # crypto + state machine tests
TEST_DB_HOST=127.0.0.1 TEST_DB_USER=ll TEST_DB_PASSWORD=llpass TEST_DB_NAME=lastlight_test npm test
                                             # + end-to-end API tests against a real MySQL/MariaDB
```

CI runs both against MariaDB on every push.

## Pull requests

One change per PR, with a test when behaviour changes. Describe what a user would
notice. Security-sensitive changes get an extra pair of eyes; please be patient.
