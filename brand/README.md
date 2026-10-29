# Last Light brand

**Direction: Horizon.** The last sliver of sun resting on a horizon line. It is the
literal picture of the name, and it says what the product does without a single
word about endings: there is still light, and it shows the way.

## Name and tagline

- Always two words, both capitalised: **Last Light**. Never "LastLight" or "last-light"
  in prose (the package and repository slug `last-light` is the exception).
- Tagline: *When you go dark, they'll still see the way.*
- Credit line for forks, posts and press: *Last Light is an Agape Labs project by
  Exaltes Global Private Limited.*

## Vocabulary

| Word | Meaning |
|---|---|
| **Vault** | What the owner encrypts in their browser. The server only ever stores it sealed. |
| **Lightkeepers** | The 2–10 people the owner trusts. Each holds one piece of the key. |
| **Keeper Card** | The printed card with a Lightkeeper's code (`LL-XXXXX-…`). Shown once, never stored. |
| **Signal** | The monthly "still here?" check-in. One click, or any login. |
| **Going dark** | The owner has stayed quiet past the grace period. Lightkeepers are asked to check on them. |
| **Last Light** | The release: enough Lightkeepers enter their codes together and the vault opens for them. |

## Voice

Plain, warm, unhurried. Short sentences, second person, sentence case everywhere,
including buttons and headlines. Precise technical words for developers (AES-256-GCM,
Shamir, PBKDF2), said once and exactly.

Never use: *death, die, dead, dying, deceased, will, testament, inheritance.* They are
flagged by spam filters and ad platforms, and they hurt to read. Say *go quiet*, *if
something happens*, *what you leave behind*, *Last Light*.

| Do | Don't |
|---|---|
| "Still here? One click keeps the light on." | "Confirm you are alive." |
| "Asha has gone quiet." | "Asha may be deceased." |
| "Nobody can open it alone. That's the point." | "Military-grade security." |
| "Leave the light on for the people you love." | "Plan for the worst." |

## The mark

`mark.svg`: a sun semicircle on a horizon bar, drawn on a 64-unit grid. The colour
version adds a soft glow; `mark-flat.svg` has none; `mark-mono-black.svg` and
`mark-mono-white.svg` are for print, stamps and `prefers-contrast`. `mark-on-light.svg`
puts the horizon in ink for paper backgrounds. The favicon (`public/favicon.svg`) sets
the mark on a rounded lamp-black square so it reads in light browser chrome too.

Rules: minimum 16 px / 5 mm; clear space equal to the height of the sun on every side;
never recolour the sun, never tilt or outline the mark, never set it over a busy photo.
In HTML the mark is also drawn in CSS (`.brand-mark`) so pages need no image request.

## Colour

From `palette.json`. Dusk is the default; paper is for the retrieval page, print and any
surface where a dark screen would read as an alarm.

| Token | Dusk | Paper | Use |
|---|---|---|---|
| bg | `#0e0d12` | `#f7f3ec` | page |
| surface | `#17161d` | `#fffdf9` | cards, inputs |
| text | `#f3ede4` | `#1b1a20` | body |
| muted | `#a39c92` | `#6a645c` | helper text (AA on both) |
| accent | `#f1b45b` | `#f1b45b` | fills: buttons (with ink text), the sun |
| accent text | `#ffc978` | `#9a5d12` | links and amber words on that surface |
| danger / ok | `#e9918a` / `#8fc49d` | `#a93f35` / `#2f6e43` | words and small icons only |
| line | `#2a2833` | `#e4dcd0` | hairlines |

The dusk sky gradient (`#0e0d12 → #221c30 → #4a2d3a → #c2642b`) is for heroes and
banners only, never behind body text. Red is never used for countdowns; there are none.

## Type

All SIL Open Font License, bundled as latin woff2 in `public/fonts/` (109 KB) with their
licences beside them. Emails use system fallbacks.

- **Fraunces** 300 (display, headlines), 300 italic (tagline, the owner's letter), 400 (titles)
- **DM Sans** 400/500 (interface and body)
- **JetBrains Mono** 500 (Keeper codes, configuration)

Keeper codes are set in five-character groups with hyphens: `LL-TK93R-D27YH-SBR2T-6Y9Y6-RNX3XG`.

## Applications

- **Landing page**: dusk sky, the sun half set on the horizon line, Fraunces 300 headline, italic tagline, amber primary button with ink text.
- **App**: dusk theme, the lockup in the header, no countdowns, no red.
- **Retrieval page**: paper theme, one column, the owner's letter first.
- **Keeper Card**: on screen a dark card with an amber horizon rule; in print 100 × 62 mm, black on white, dashed cut line (see `public/css/style.css`, `@media print`).
- **Email**: paper background, dark button with amber text, no images, no web fonts (`src/mailer.js`, `THEME`).
- **GitHub**: `social-preview.html` renders to `public/social-preview.png` (1280 × 640) with `node scripts/render.js brand/social-preview.html public/social-preview.png --width 1280 --height 640`. Upload the same file as the repository's social preview.

## Files

`mark.svg`, `mark-flat.svg`, `mark-on-light.svg`, `mark-mono-black.svg`, `mark-mono-white.svg`,
`wordmark.svg`, `wordmark-on-dark.svg`, `lockup-horizontal*.svg`, `lockup-stacked*.svg`,
`palette.json`, `social-preview.html`.
