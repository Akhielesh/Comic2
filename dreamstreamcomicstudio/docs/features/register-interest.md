# Register your interest

Sign-up is closed while the beta is small. A newcomer who tries to join is guided to
**Register interest** (the sign-in card's second tab, `AuthPage` mode `request-access`, and the
comics landing's Register section, `components/comicshost/landing/RegisterFaq.tsx`), leaves an email
and, if they like, answers a few questions so the product can be shaped around what people want.
Nobody is emailed for registering.

## What the person sees

- Card title "Register your interest", a "Private beta" chip and one short sentence about the beta.
  Only the words of that mode changed; `SIGNUPS_ENABLED`, the invite path and every auth call are as before.
- `components/WaitlistForm.tsx` (kind `access`), built from the `components/ds` primitives
  (Field, Input, Textarea, Select, Checkbox, Button, and the kit's filter-chip shape) on the page tokens,
  light and dark, 320 px up. Only questions a visitor can answer without knowing the product:
  1. Email address (required) and first name (optional), side by side from `sm`.
  2. "What would you like to make?" (optional quick picks, as chips that wrap): a short story, a comic
     for kids, a webcomic series, a pitch or storyboard, something for work. Each pick is a native
     checkbox inside the chip (one `fieldset` with a `legend`); it shows a plus while off and a tick on
     the ink chip once picked, so the state never rests on fill alone; 44 px under a coarse pointer.
  3. "Anything else?" (optional, 1,000 characters; the limit is shown, and a running count from 800).
  4. "How did you hear about us?" (optional, one native select): LinkedIn, a friend, search, social
     media, other.
  5. One box, unticked by default: "Keep me updated about Comic Studio news and new DreamStream
     studios.", with the line "Nothing is sent yet; this only records that you would like updates."
  - One line: sign-up is not open yet and the answers shape what gets built next.
- There is no question about other studios (nothing on the page says what they are) and no vague
  "something else" field. Both were asked until the question set changed (stored rows keep them,
  `answers.v: 1`).
- Success: "Thank you, you are on the list.", plus "Your answers help shape what we build next." only
  when answers were sent, plus "Nothing is sent yet; we will let you know when updates start." only when
  the box was ticked. Each depends on what was sent, never on the address. It promises no email and
  takes focus; the card's intro sentence goes away once it shows.
- A bad or empty email is shown at the field (the form is `noValidate`, so the browser's own bubbles
  never compete): the field is marked invalid, the message describes it, and focus moves to it.
  Everything else is one plain alert under the form that keeps everything typed: "We could not save
  that just now", too many tries (429), or the verification check when the page shows one.
- The verification widget (when a site key is set) is compact in a card narrower than 300 px and
  follows the page's light or dark theme.
- Kind `updates` (the main site's list card, `UPDATES_CARD` in `shared/interest.ts`) is one email field
  (its label for assistive tech only, as before) and the button "Add me to the list", with the plain
  "Thank you, you are on the list." While interest emails are off the card says that no emails are
  sent yet; it promises no updates, invites or launch notes. It has no consent box and stores none.

## One vocabulary, one stored shape (`shared/interest.ts`)

The quick-pick and source ids, the caps, the text cleaning, the consent flag and the stored shape
live in one pure module used by the server route and by the form's direct save, so a row reads the
same whichever path wrote it.

- `cleanLine` (first name, source): every control character, the line and paragraph separators, the
  bidi marks and the bidi embedding, override and isolate controls, the invisible format characters
  (zero-width space, word joiner and invisible operators, the deprecated format controls, the
  interlinear annotation marks) and the byte order mark become spaces; tag characters (invisible text
  software can still read) are removed; runs of spaces collapse. The zero-width non-joiner and joiner
  stay (scripts and emoji need them). Limits count what is left.
- `cleanBlock` (the "Anything else?" note): the same, but line breaks stay (CRLF folded, at most one
  blank line).
- `answersForKind(kind, answers)`: the register-interest form always carries the box as `true` or `false`
  (only a real `true` counts); the list card never carries it. The server applies it only when the request
  carried the box (see below).
- `interestMetadata(source, answers, at)` is the row's `metadata`:
  `{ source?, answers?: { v: 2, makes?, heardFrom?, comment?, firstName? }, consent?: { updates, at, wording } }`.
  `consent` is written for every register-interest row whose form showed the box: `updates` is `true` only
  when the box was ticked, `at` is when the choice was sent (the server's clock; the direct save uses the
  moment the person pressed the button), and `wording` is the exact label they saw. The box is a choice,
  not an answer: it never adds `answers` on its own and never changes the "your answers" sentence.
- `consent.updates: true` is a request from an address nobody has verified: anyone can type any address
  (the bot check proves a person, not that the address is theirs), and anyone with the public key can
  insert a row straight into `waitlist_signups` with any `metadata` (RLS checks only the email shape and
  the kind). So it is never enough on its own to mail news (see the email switch below).

## Server contract (`server/src/routes/newsletter.ts`)

`POST /api/newsletter/subscribe` with
`{ email, kind?: 'access'|'updates', source?, firstName?, makes?: string[], heardFrom?, comment?, keepUpdated?: boolean, captchaToken? }`.

| Case | Answer |
|---|---|
| Any valid address (new, already on the list, has an account, holds an invite) | `200 { ok: true, status: 'registered', message }`, identical per kind and per what was sent (answers, the box) |
| Malformed email, or an answer over its limit or of the wrong type | `400 { ok: false, status: 'invalid', message }` |
| Bot check failed | `400 { ok: false, status: 'verify', message }` |
| Too many requests | `429` (the existing `systemRateLimit` on `/api/newsletter`) |
| Nothing was stored (no service role, or the database refused) | `503 { ok: false, status: 'unavailable', message }`; the form then saves the row itself |

- No account lookup and no invite re-send on this path, so nothing about the address reaches the
  caller. An invited person uses the link in their invite email; an admin can re-send it.
- Answers are checked on the server whatever the client did: unknown ids dropped, each id once,
  text cleaned as above, and anything of the wrong type or over its limit refused, not cut
  (quick picks at most 16 entries, the note 1,000, first name 80; `heardFrom` must be text, and an
  unknown one is dropped). The source tag is cut to 200 instead, since the person never typed it.
- `keepUpdated` is read only as a real `true` or `false` (the current form always sends one). A request
  without it, or with anything else (`"true"`, `1`, `null`), records no `consent` key at all, which counts
  as no, and its thank-you has no updates line: a tab opened before the box existed never showed its words,
  so no choice is made up for it. No email path reads the box: with `INTEREST_EMAILS` on, a ticked and an
  unticked form send exactly the same mail (the existing `access-requested` for a new row), and with it
  off, nothing.
- Older forms that send `feedback` for the note still work. Open tabs from before the questions
  changed may still send `features`, `featureOther`, `studios` or `productInterests`: the request is
  accepted and those fields are not stored or checked (those questions are no longer asked). When one of
  them is present, the name and note that are stored carry `answers.v: 1`, since the old set asked them.
- Where answers are stored: the existing `metadata` jsonb column of `waitlist_signups`
  (`metadata.answers` and `metadata.consent`). The server also copies the note into the existing
  `feedback` column; `product_interests` is no longer written (older rows keep theirs). **No schema
  change is needed.**
- The store (`server/src/services/emailStore.ts` `upsertSubscriber`) reads every error supabase-js
  returns and throws when nothing was stored, so a failed save is never answered as a saved one. A
  unique violation on insert (two requests at once) counts as already on the list.
- An address already on the list keeps its answers as they are: rows are keyed by an email the caller
  supplies, so a repeat (or anyone else posting that address) never replaces its answers, note or source.
  Two writes are allowed:
  - a register-interest repeat with the box ticked, on a row that holds no yes (an earlier no, or a row
    from before the box): only `metadata.consent` is set to the new yes, with its time and wording. A
    stored yes is never turned back into a no. This adds nothing a stranger could not already do with a
    new row, and the yes is unverified either way (above).
  - an unconfirmed `updates` row while interest emails are on: a fresh confirm token, which the confirm
    email then carries.

## The form's direct save (`services/waitlist.ts`)

If the server cannot answer within 8 s, answers 5xx, or refuses the bot check while the page shows
no check, the client saves the row directly (insert-only under RLS, the same write the public key
already allows) with the same `metadata`, and gives the same thank-you. A repeat on that path is a
unique violation and gets the same thank-you, except that a ticked box there gets no "we will let you
know" line: the direct save may only insert, so it cannot add the yes to the stored row. (Anyone with the
public key already sees that unique violation, so the shorter line tells them nothing new.) With a check on
the page, a refused check asks the person to try again. The direct save sends nothing.

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
- News about Comic Studio or new studios goes, if it ever goes, only to `access` rows whose
  `metadata.consent.updates` is `true`, and only after a confirm step: those addresses are first sent one
  confirm (double opt-in) link, and news goes only to the ones that confirm it. Rows with no `consent` or
  `updates: false` (rows from before the box among them) count as no, and are not sent the confirm link
  either. Suppressed addresses are never mailed.

## Known limits

- On a repeat registration the store keeps the first row's answers (`metadata.answers`, `source`,
  `feedback` and `product_interests`); a repeat's answers are not stored. Only a ticked box is recorded
  (above), and only through the server: a repeat that falls back to the direct save cannot record it, and
  its thank-you says nothing about updates.
- The server does not mark which rows it wrote, so a yes written straight through the public key looks
  the same as one from the form; the confirm step before any news mail is what makes either safe to mail.
- Answers are read in the Supabase dashboard (`metadata->'answers'`, `metadata->'consent'`); there is no
  admin screen yet.

## Tests

`server/src/routes/newsletter.test.ts`, `server/src/services/emailStore.subscribe.test.ts`,
`shared/interest.test.ts`, `services/waitlist.test.ts`, `components/WaitlistForm.test.tsx`,
`components/WaitlistForm.atlas.test.tsx`, `components/AuthPage.atlas.test.tsx`, `components/Turnstile.test.tsx`,
`components/comicshost/landing/landingCopy.test.tsx` (the landing's register section, its FAQ and the banned
promises), `components/LegalLaunchCopy.test.tsx` (the privacy line).
