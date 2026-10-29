<!--
Thanks for helping keep the light on. One change per PR, please, and a test
when behaviour changes. Security-sensitive changes get an extra pair of eyes,
so they may take a little longer. See CONTRIBUTING.md.
-->

## What changed

<!-- One or two sentences. Describe what an owner, a Lightkeeper or an operator would notice. -->

## Why

<!-- The problem this solves. Link the issue if there is one, e.g. "Closes #12". -->

## How it was tested

- [ ] `npm test` passes (crypto and state machine)
- [ ] The end-to-end API tests pass against MySQL/MariaDB (`TEST_DB_HOST=… npm test`), or CI is green
- [ ] I tried it by hand in a browser: <!-- which browser, which flow -->

## Checklist

- [ ] No new runtime dependency (three is the budget)
- [ ] The server still never sees plaintext or keys
- [ ] New or changed copy follows the voice rules in CONTRIBUTING.md (gentle words: "goes quiet", "if something happens", never the blunt ones)
- [ ] Docs updated where behaviour changed (README.md, docs/, .env.example)
- [ ] If this touches crypto, sessions, release timing or the emails Lightkeepers receive, I have said so above
