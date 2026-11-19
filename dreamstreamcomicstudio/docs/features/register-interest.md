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
  - "What would you use, or like to see?" (optional checklist): making a comic by chatting, translations
    into other languages, series and collections (not built yet, hence "or like to see"), publishing to the
    public Library, printing and export.
  - "Something else" (optional, 120 characters).
  - "Other studios you would try" (optional): Chat Studio, Stream Studio, Dashboards. Only studios that
    exist: Code Studio was retired (`docs/decisions/0005-retire-code-studio.md`); `code_studio` and
    `comic_studio` stay accepted from older open tabs but are not asked.
  - "Anything you would like to tell us" (optional, 1,000 characters; the limit is shown, and a
    running count from 800).
  - One line: sign-up is not open yet and the answers shape what gets built next.
  - Each checklist is a `fieldset` with a `legend`; each row is a 44 px target under a coarse pointer.
- Success: "Thank you, you are on the list.", plus "Your answers help shape what we build next." only
  when answers were sent (it depends on what was sent, never on the address). It promises no email
  and takes focus; the card's intro sentence goes away once it shows.
- A bad or empty email is shown at the field (the form is `noValidate`, so the browser's own bubbles
  never compete): the field is marked invalid, the message describes it, and focus moves to it.
  Everything else is one plain alert under the form that keeps everything typed: "We could not save
  that just now", too many tries (429), or the verification check when the page shows one.
- The verification widget (when a site key is set) is compact in a card narrower than 300 px and
  follows the page's light or dark theme.
- Kind `updates` (the main site's list card, `UPDATES_CARD` in `shared/interest.ts`) is one email field
  (its label for assistive tech only, as before) and the button "Add me to the list", with the plain
  "Thank you, you are on the list." While interest emails are off the card says that no emails are
  sent yet; it promises no updates, invites or launch notes.

## One vocabulary, one stored shape (`shared/interest.ts`)

The feature and studio ids, the caps, the text cleaning and the stored shape live in one pure
module used by the server route and by the form's direct save, so a row reads the same whichever
path wrote it.

- `cleanLine` (first name, something else, source): every control character, the line and
  paragraph separators, the bidi marks and the bidi embedding, override and isolate controls, the
  invisible format characters (zero-width space, word joiner and invisible operators, the deprecated
  format controls, the interlinear annotation marks) and the byte order mark become spaces; tag
  characters (invisible text software can still read) are removed; runs of spaces collapse. The
  zero-width non-joiner and joiner stay (scripts and emoji need them). Limits count what is left.
- `cleanBlock` (comment): the same, but line breaks stay (CRLF folded, at most one blank line).
- `interestMetadata(source, answers)` is the row's `metadata`:
  `{ source?, answers?: { v: 1, features?, other?, studios?, comment?, firstName? } }`.

## Server contract (`server/src/routes/newsletter.ts`)

`POST /api/newsletter/subscribe` with
`{ email, kind?: 'access'|'updates', source?, firstName?, features?: string[], featureOther?, studios?: string[], comment?, captchaToken? }`.

| Case | Answer |
|---|---|
| Any valid address (new, already on the list, has an account, holds an invite) | `200 { ok: true, status: 'registered', message }`, identical per kind and per "answers sent or not" |
| Malformed email, or an answer over its limit or of the wrong type | `400 { ok: false, status: 'invalid', message }` |
| Bot check failed | `400 { ok: false, status: 'verify', message }` |
| Too many requests | `429` (the existing `systemRateLimit` on `/api/newsletter`) |
| Nothing was stored (no service role, or the database refused) | `503 { ok: false, status: 'unavailable', message }`; the form then saves the row itself |

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
- The store (`server/src/services/emailStore.ts` `upsertSubscriber`) reads every error supabase-js
  returns and throws when nothing was stored, so a failed save is never answered as a saved one. A
  unique violation on insert (two requests at once) counts as already on the list.
- An address already on the list keeps its row exactly as it is: rows are keyed by an email the caller
  supplies, so a repeat (or anyone else posting that address) never replaces its answers. The one write
  is for an unconfirmed `updates` row while interest emails are on: a fresh confirm token, which the
  confirm email then carries.

## The form's direct save (`services/waitlist.ts`)

If the server cannot answer within 8 s, answers 5xx, or refuses the bot check while the page shows
no check, the client saves the row directly (insert-only under RLS, the same write the public key
already allows) with the same `metadata`, and gives the same thank-you. A repeat on that path is a
unique violation and also gets the same thank-you. With a check on the page, a refused check asks
the person to try again. The direct save sends nothing.

## The email switch: `INTEREST_EMAILS`

Off unless the backend variable is exactly `on`. Leave it unset; it is deliberately not in
`api-proxy/wrangler.jsonc`.

- Off: registering stores the row and sends nothing, and an existing row's confirm token is left as
  it is, so the confirm link in older emails still confirms (without the welcome email).
- On: a new `access` row gets `access-requested`; a new or unconfirmed `updates` row gets a fresh
  confirm token and `newsletter-confirm` (sent only with a token the store just wrote); the confirm
  link sends `newsletter-welcome`. The answer to the caller does not change.
- Never governed by it: admin invites (`beta-invite`), auth emails, member notifications.
- `updates` rows stored while it is off are unconfirmed and must not be mailed as marketing.

## Known limits

- On a repeat registration the store keeps the first row as it is (`metadata`, `feedback` and
  `product_interests`); a repeat's answers are not stored.
- Answers are read in the Supabase dashboard (`metadata->'answers'`); there is no admin screen yet.

## Tests

`server/src/routes/newsletter.test.ts`, `server/src/services/emailStore.subscribe.test.ts`,
`shared/interest.test.ts`, `services/waitlist.test.ts`, `components/WaitlistForm.test.tsx`,
`components/WaitlistForm.atlas.test.tsx`, `components/AuthPage.atlas.test.tsx`, `components/Turnstile.test.tsx`.
