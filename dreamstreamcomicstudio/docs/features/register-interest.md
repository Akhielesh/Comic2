# Register your interest

Sign-up is closed while the beta is small. A newcomer who tries to join is guided to
**Register interest** (the sign-in card's second tab, `AuthPage` mode `request-access`),
leaves an email and, if they like, answers a few questions so the product can be shaped
around what people want. Nobody is emailed for registering.

## What the person sees

- Card title "Register your interest", a "Private beta" chip and one short sentence about the beta.
  Only the words of that mode changed; `SIGNUPS_ENABLED`, the invite path and every auth call are as before.
- `components/WaitlistForm.tsx` (kind `access`), built from the `components/ds` primitives
  (Field, Input, Textarea, Checkbox, Button) on the page tokens, light and dark, 320 px up:
  - Email address (required) and first name (optional), side by side from `sm`.
  - "What would you use?" (optional checklist): making a comic by chatting, translations into
    other languages, series and collections, publishing to the public Library, printing and export.
  - "Something else" (optional, 120 characters).
  - "Other studios you would try" (optional): Chat Studio, Code Studio, Stream Studio, Dashboards,
    the studios the form already offered before this change.
  - "Anything you would like to tell us" (optional, 1,000 characters; the limit is shown, and a
    running count from 800).
  - One line: sign-up is not open yet and the answers shape what gets built next.
  - Each checklist is a `fieldset` with a `legend`; each row is a 44 px target under a coarse pointer.
- Success: "Thank you, you are on the list. Your answers help shape what we build next."
  It promises no email, is the same for every address, and takes focus.
- Errors are plain alerts that keep everything typed: a bad email, "We could not save that
  just now", too many tries (429), or the verification check when the page shows one.
- Kind `updates` (the main site's "Keep me posted") is one email field (its label for assistive
  tech only, as before) and the button, with the same neutral thank-you.

## One vocabulary, one stored shape (`shared/interest.ts`)

The feature and studio ids, the caps, the text cleaning and the stored shape live in one pure
module used by the server route and by the form's direct save, so a row reads the same whichever
path wrote it.

- `cleanLine` (first name, something else, source): every control character, the line and
  paragraph separators, the bidi embedding, override and isolate controls and the byte order mark
  become spaces; runs of spaces collapse. Zero-width joiners stay (scripts and emoji need them).
- `cleanBlock` (comment): the same, but line breaks stay (CRLF folded, at most one blank line).
- `interestMetadata(source, answers)` is the row's `metadata`:
  `{ source?, answers?: { v: 1, features?, other?, studios?, comment?, firstName? } }`.

## Server contract (`server/src/routes/newsletter.ts`)

`POST /api/newsletter/subscribe` with
`{ email, kind?: 'access'|'updates', source?, firstName?, features?: string[], featureOther?, studios?: string[], comment?, captchaToken? }`.

| Case | Answer |
|---|---|
| Any valid address (new, already on the list, has an account, holds an invite) | `200 { ok: true, status: 'registered', message }`, identical per kind |
| Malformed email, or an answer over its limit or of the wrong type | `400 { ok: false, status: 'invalid', message }` |
| Bot check failed | `400 { ok: false, status: 'verify', message }` |
| Too many requests | `429` (the existing `systemRateLimit` on `/api/newsletter`) |
| The store threw | `503 { ok: false, status: 'unavailable', message }` |

- No account lookup and no invite re-send on this path, so nothing about the address reaches the
  caller. An invited person uses the link in their invite email; an admin can re-send it.
- Answers are checked on the server whatever the client did: unknown ids dropped, each id once,
  text cleaned as above, and anything of the wrong type or over its limit refused, not cut
  (features and studios at most 16 entries each, something else 120, comment 1,000, first name 80).
  The source tag is cut to 200 instead, since the person never typed it.
- Older open tabs that send `productInterests` (studio picks) and `feedback` still work.
- Where answers are stored: the existing `metadata` jsonb column of `waitlist_signups`
  (`metadata.answers`). The server also copies the comment into the existing `feedback` column and
  the studio picks into `product_interests`. **No schema change is needed.**

## The form's direct save (`services/waitlist.ts`)

If the server cannot answer within 8 s, answers 5xx, or refuses the bot check while the page shows
no check, the client saves the row directly (insert-only under RLS, the same write the public key
already allows) with the same `metadata`, and gives the same thank-you. A repeat on that path is a
unique violation and also gets the same thank-you. With a check on the page, a refused check asks
the person to try again. The direct save sends nothing.

## The email switch: `INTEREST_EMAILS`

Off unless the backend variable is exactly `on`. Leave it unset; it is deliberately not in
`api-proxy/wrangler.jsonc`.

- Off: registering stores the row and sends nothing; the confirm link in older emails still
  confirms, without the welcome email.
- On: a new `access` row gets `access-requested`; an `updates` row that is not yet confirmed
  gets `newsletter-confirm`; the confirm link sends `newsletter-welcome`. The answer to the
  caller does not change.
- Never governed by it: admin invites (`beta-invite`), auth emails, member notifications.
- `updates` rows stored while it is off are unconfirmed and must not be mailed as marketing.

## Known limits

- On a repeat registration the store keeps the first row's `metadata`; a repeat's answers reach
  only `feedback` and `product_interests` (`server/src/services/emailStore.ts`, unchanged here).
- Answers are read in the Supabase dashboard (`metadata->'answers'`); there is no admin screen yet.

## Tests

`server/src/routes/newsletter.test.ts`, `shared/interest.test.ts`, `services/waitlist.test.ts`,
`components/WaitlistForm.test.tsx`, `components/WaitlistForm.atlas.test.tsx`,
`components/AuthPage.atlas.test.tsx`.
