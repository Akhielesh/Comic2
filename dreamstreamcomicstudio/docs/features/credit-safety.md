# Credit safety: stop on an empty key, check before spending, the real balance

Comic Studio never keeps spending on a key that has run out, never starts a paid step that cannot be paid for, and
shows the person what their own OpenRouter key has left. Money is said in the payer's terms: dollars for the person's
own key, a percentage and plain words for DreamStream's included usage (governed people never see `$` or cents).

## 1. A drawing run stops when its key runs out

**What counts.** Only a confirmed refusal of the key, exactly as `server/src/comic/imageClient.ts`
`classifyImageError` classifies it, carries `creditRefusal` (`creditRefusalOf(err)`):

| Provider answer | Kind |
| --- | --- |
| 402, or 403 that says credit / limit / quota and is not a moderation refusal | `credit` |
| 429 or RESOURCE_EXHAUSTED with `limit: 0` (a Google project with no image billing) | `no_quota` |
| any other 429, rate limit or per-minute quota, 5xx, timeouts, bad keys, safety blocks | never |

**What the run does** (`server/src/comic/jobs.ts`, `RenderRun`):

- The refused route goes into the run's `refusedRoutes`. Every attempt checks it before dispatch and every request
  carries `excludeRoutes`, so neither the run nor the image client's own same-model fallback calls that key again in
  this run.
- **A refusal on the fallback counts too.** When the first route was only busy (a rate limit or an outage) and the
  image client's same-model fallback was refused for credit, the error reported stays the first route's (the job
  retries there) and carries the fallback's refusal (`fallbackRefusalOf(err)`: `{ route, refusal }`). The run notes it
  before it retries, so the next attempt excludes that key; if the first key is refused later, the stop card names
  both.
- **Same-payer continuation** (release 308's rule for standalone images, commit 336a3e63): when the same model has a
  route on a key of the same payer (`pickAlternateRoute`: the person's own OpenRouter and Gemini keys, or two platform
  keys, never one of each) that was not refused, the refused job is drawn there at once (`DrawOutcome` `reroute`) and
  the rest of the run follows. One info notice says so, posted with the completion ("Your OpenRouter key ran out of
  credit, so the rest of this run carried on with your Gemini key …"; a key with no image quota is named for what it
  is, "has no image quota (its Google project has no billing) … Turn on billing for that project", since a top-up
  would not fix it). Never another model. When the other key is refused too, that notice is dropped: the run stopped,
  and the stop card names both keys.
- Otherwise the run **stops**: `stopReason` is set, the refused job and every job not yet dispatched go back to their
  previous state (not started, never failed, no error on the tile), and their reservations are released ($0). Jobs
  already on the wire finish; a job waiting to retry does not retry; nothing is re-queued.
- The completion says `Stopped before …: your OpenRouter key ran out of credit (or reached its spending limit).
  Nothing more was charged.` (both keys: `your OpenRouter and Gemini keys ran out of credit …`; governed: `the drawing
  service ran out of capacity. Nothing more was used from your usage.`) and never suggests the next paid step. It
  carries **one** `credit` card and no other paid chip.
- The card is a **needs-you** of its own (`shared/comic/attention.ts` why `credit`, never a question): the "needs you"
  alert fires instead of "Pages are ready" ("Waiting for a top-up or another key": alerts carry no money word), the
  side panel's Your comics lists the comic under Needs you as "Top up or switch key", and the comic's stage names the
  same step (`top_up` in `shared/comic/stage.ts`, at the conversation), so the stage strip, the My comics card and the
  panel agree until the chat moves past the card. A summary saved before this reason existed still reads "Answer the
  Director".
- **A model switch that redraws everything** draws the sheets first, then the pages and cover
  (`actions/models.ts` `chainAfterSheets`). When that sheets run stops on credit, its one card is the whole story: the
  switch posts nothing more and offers no paid chip. Once "Draw the rest" has drawn the sheets left on the new model,
  that run offers what the switch still owes, priced fresh: "Redraw 5 pages and the cover · ≈ $X"
  (`jobs.ts` `switchRedrawLeftStep`; the switch's own sheets run never offers it, since the switch starts the pages
  itself).

## 2. The balance check before spending

Runs on the server right before an approved paid step starts, never at quote time, on every path that starts one:

- `startSpend`: drawing runs, the whole-book approval of "Draft it for me" (its gate is approved through
  `approveGate`), and every small paid step a person taps directly (a confirmed chip or button).
- Text spends, paid by the text route's key (OpenRouter first), through `textCreditShort`: translate and the page
  detail pass asked for directly (`runFeatureAction`) **and approved** (`approveGate` runs the same check before the
  handler; most translations start from an approval, since the Director opens one for every translate it is asked
  for), and the page re-check (`startRecheck`, both ways).
- Planning, through `planCreditShort` before the writer runs (`planPages`): "Plan the pages", the planning inside
  "Draft it for me", `revise_pages` and a written new page (the clip menu's Write). The need is the quote's honest
  bound: twice one pass for the pages being written (one pass, and one repair if the plan check sends it back). A
  shortfall writes nothing and posts the card ("…haven't started the page plan…"); the draft stops as interrupted with
  its idea kept, so it can start again after a top-up.
- A model switch that redraws (`change_image_model` with redraw), before anything is switched: the whole redraw on
  the new model (sheets, pages and cover) against what its payer has left. Short: nothing is switched, so the book is
  never left half on each model (as with the budget check), one card, and the free "Switch without redrawing".

**What is left** is what the payer has left minus what this comic is drawing right now (`heldUsdFor`). A reading is
usually taken before such a run started, so without this a second step approved while the first draws would pass the
check and stop mid-run instead. The card then says "left after what's drawing now" (`held`). For an own key that is
the whole held quote (`pendingUsdOf`: a reading never includes calls still in flight). For DreamStream's allowance it
is only the part with no billing hold yet: the usage status a request reads already counts the hold of every image on
the wire (`inflight_usd`), so those are not set aside twice (`RenderRun.holdOnWire` counts a job's hold from its
reservation until it settles or is released).

**A reading that would refuse is read again first.** When an own-key reading says no and is more than 30 s old
(`RECHECK_REFUSAL_AFTER_MS`), the provider is read once more, past the 60 s provider cache, and the newer reading
decides. So "top up, then Draw the rest" (or Approve again) works at once instead of repeating the refusal on the
reading saved when the run stopped. If that read fails, the earlier reading (still under 15 minutes old) decides.

**The person's other key.** When the own key that would draw is known to be short and the same model has a route on
the person's other own key whose balance fits or is unknown (Gemini reports none), the run starts there instead
(`preferRoute`), with one line in the start message: "Your OpenRouter key has $0.05 left, so this run draws on your
Gemini key (the same model)." That is MN-1's continuation rule applied up front: a step is never blocked while another
of the person's keys could pay.

`server/src/comic/creditCheck.ts` `creditBudgetFor` reads what the payer has left:

| Payer | Compared with | Unknown (never blocks) when |
| --- | --- | --- |
| Own OpenRouter key | `spendableUsd` of the owner's last reading of exactly this key: the smaller of the key's remaining limit and the account's USD credits. `latestOwnKeyBalance` (services/accountProviderUsage.ts) uses the saved observation while under 15 minutes old (or the stricter `maxAgeMs` of the re-read above), else reads OpenRouter through the same code as `POST /api/keys/balance` (saved for next time). Bounded: one read in flight per key (checks meanwhile share it), at most 3.5 s of waiting, and after a read that failed or timed out no new one for two minutes, so a slow provider costs a paid step that wait at most once per two minutes. | no reading, a stale reading that could not be refreshed, a key with no reported limit or credits, no binding secret |
| Own Gemini key (and every dashboard-only provider) | nothing (no balance API) | always |
| DreamStream's allowance (governed) | `caps.usage`: the quote ÷ markup × the share one dollar takes (costText.ts) against `pctLeft`; exhausted never fits | the share of a dollar is unknown, the status was not read, admins and exempt accounts |

A known shortfall starts **nothing** (no reservation, no job) and posts one "Not enough credit" `credit` card. An
approval that was being approved stays open, so the person can approve again after topping up. The director reads
`Not started: not enough credit … Do not say the drawing is under way.`

**Draw what fits** (`drawWhatFits`): for `render_pages` only, the most leading pages (with the sheets they need, never
the cover) whose fresh quote fits, offered as a priced button. When the step included the cover (the whole-book
approval does), every page counts, so 6 pages that fit without the cover are offered as 6, and a one-page book can
draw its page; otherwise the biggest smaller run is one page fewer. The quote of the leading n pages never falls as n
grows, so the most that fit is a binary search (about eight quotes for a 200-page book). It is a direct, priced step:
it starts at once and the balance check runs again.

## 3. The `credit` card

`shared/comic/credit.ts` (type and `normalizeCreditCard`, run on every stored doc). Settles once the chat moves past
it (`shared/comic/settle.ts`). Rendered by `components/comicstudio/usage/CreditCard.tsx` (registered by the `usage`
feature module).

| reason · payer | Title | Actions |
| --- | --- | --- |
| stopped · own key | "Your OpenRouter key ran out of credit" / "Your Gemini key has no image quota"; both keys refused: "Your OpenRouter and Gemini keys ran out of credit" (mixed reasons: "Neither of your keys can draw right now", with what each needs) | Top up (the provider's funds page; one per key, named, when both are out) · Switch key (Settings → API keys) · Draw the rest (priced, what did not start) |
| stopped · allowance | "Drawing paused" | Use my own key · Draw the rest (in usage words) |
| short · own key | "Not enough credit": needs ≈ $X, key has $Y left, when it was read | Top up · Switch key · Draw what fits |
| short · allowance | "Not enough credit": about N% of your usage needed, M% left; ask for a top-up, or use your own key | Ask for a top-up (a mail to support, subject prefilled, nothing about the account) · Use my own key · Draw what fits |

What is left and what the step needs are stored in the payer's terms: `needUsd` / `leftUsd` on an own-key card,
`needPct` / `leftPct` on an allowance card (the normalizer drops the other payer's fields). The one dollar figure an
allowance card holds is the quote of the spend it offers again (`fits.usd` / `rest.usd`, charged USD, like a chip's
quote), kept so the button can be priced and re-checked; it is only ever shown through the viewer's cost format, so a
governed person reads a share of the usage. `stopped` own-key cards list `keys` when both of the person's keys were
refused. The share-of-usage words come from one helper, `creditShareWords`, on the server and the card. Every control
is ink: no colour on or beside a price or a control that spends.

## 4. The real balance of your own OpenRouter key

`services/keyBalance.ts`: one reading per page for the active OpenRouter key on this device (else the account's saved
key), keyed by a fingerprint (never the key). It reads through `POST /api/keys/balance` (owner bearer, own key only)
when a view that shows it opens and the reading is missing or older than 15 minutes, after a drawing run settles
(something was drawing, now nothing is), and on a tap. Concurrent asks share one request. Nothing polls.

- **Studio header** — `components/comicstudio/usage/KeyBalanceSlot.tsx`, header slot `key-balance` at order 221
  (right after the usage meter): "$12.40 left · 5 min ago" on the desktop header; the tablet (split) header and phone
  headers from 560 px say "$12.40 · 5m" (phones in the flat icon family), so when it was read always shows, and an
  old reading that could not be refreshed reads as old ("· 3h"). Tap reads again and announces the result. Shown only
  while the comic draws on the person's own key and they have an OpenRouter key; hidden while the balance is unknown.
- **Phone headers narrower than 560 px** have no room for it (`KEY_BALANCE_PILL_MIN_WIDTH`, the History pattern: at
  360 px share, the spend chip, Ask and ⋯ already fill the header, and the pill pushed ⋯ off-screen). There the
  balance lives in the **Spending sheet** (`KeyBalanceSheetLine.tsx`, the spend chip or ⋯ → Spending): "$12.40 left",
  when it was read, Check now. The header slot still reads it when the studio opens and after a run settles, so the
  sheet opens on a current figure.
- **Settings → API keys** — `components/usage/KeyBalancePanel.tsx`, first under "DreamStream usage left": the figure
  large, when it was read (and "an older reading" past 15 minutes), the key limit, its usage and the account credits
  when reported, Check now, Add funds. When OpenRouter shares no balance for the key it says so (set a credit limit on
  the key, or check the credits there). One reading both ways: Settings' per-provider "Check provider" feeds the panel,
  and the OpenRouter card shows the panel's reading when it is newer than the saved one (`ProviderActivity.tsx`
  `PersonalProviderBalance`), so the page never shows two figures for one key.
- **Governed people** keep the "usage left" percentage in the header (`usage` slot) and in Settings.

## Gotchas

- The check compares the **quote**, which is never under the real price (models.md §2.3; the one price book,
  [pricing.md](pricing.md)), so a run that would just fit at list price may be refused; Draw what fits covers that
  case. The card's own-key figures ("needs ≈ $X", "has $Y left") print through the studio's one cost format.
- A reading is HMAC-bound to owner, provider and exact key (`provider_balance_observations`); a server without
  `SUPABASE_SERVICE_ROLE_KEY` treats every own-key balance as unknown.
- No SQL: the observations table already exists (`server/sql/account_provider_analytics.sql`).

## Tests

`server/src/comic/imageClient.credit.test.ts` (classification, `excludeRoutes`, a busy first route whose fallback key
was refused), `server/src/comic/jobs.credit.test.ts` (the run stopping, same-payer continuation, both keys refused, a
no-quota key carried on, a fallback refusal never called again, the pre-spend check: fits, short, unknown, governed,
the open approval, an approved translation, the re-read after a top-up, the held quote of a run under way, governed
images on the wire counted once, the other key, planning and a page rewrite on an empty key, Draw what fits with the
cover and against a brute force), `server/src/comic/directorDraft.test.ts` (the draft's planning on an empty key),
`server/src/comic/actions/models.test.ts` (a switch the key can't redraw switches nothing; a sheets run that stopped
posts nothing more, and Draw the rest then offers the pages and cover), `shared/comic/workspaceActivity.test.ts`,
`components/comicstudio/panel/panelModel.test.ts` and `shared/comic/stage.test.ts` (the panel's and the stage's "Top up or switch key"), `services/alerts/copy.test.ts`,
`server/src/services/accountProviderUsage.latest.test.ts` (fresh, stale, the stricter re-read, the shared read and its
cooldown), `shared/comic/credit.test.ts`, `shared/comic/attention.test.ts`, `components/comicstudio/alerts/studioTransitions.test.ts`,
`services/keyBalance.test.ts`, `components/comicstudio/usage/{CreditCard,KeyBalanceSlot}.test.tsx` (the header by width,
the Spending sheet line, and the real StudioHeader at 360 px carrying it), `components/usage/KeyBalancePanel.test.tsx`
(and the OpenRouter card showing the panel's newer reading).
