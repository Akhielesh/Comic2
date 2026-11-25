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
- **Same-payer continuation** (release 308's rule for standalone images, commit 336a3e63): when the same model has a
  route on a key of the same payer (`pickAlternateRoute`: the person's own OpenRouter and Gemini keys, or two platform
  keys, never one of each) that was not refused, the refused job is drawn there at once (`DrawOutcome` `reroute`) and
  the rest of the run follows. One info notice says so. Never another model.
- Otherwise the run **stops**: `stopReason` is set, the refused job and every job not yet dispatched go back to their
  previous state (not started, never failed, no error on the tile), and their reservations are released ($0). Jobs
  already on the wire finish; a job waiting to retry does not retry; nothing is re-queued.
- The completion says `Stopped before …: your OpenRouter key ran out of credit (or reached its spending limit).
  Nothing more was charged.` (governed: `the drawing service ran out of capacity. Nothing more was used from your
  usage.`) and never suggests the next paid step. It carries **one** `credit` card and no other paid chip.

## 2. The balance check before spending

Runs on the server right before an approved paid step starts, never at quote time:

- `startSpend`: drawing runs, the whole-book approval of "Draft it for me" (its gate is approved through
  `approveGate`), and every small paid step a person taps directly (a confirmed chip or button).
- `runFeatureAction` (translate, the page detail pass) and `startRecheck`: text spends, paid by the text route's key
  (OpenRouter first).

`server/src/comic/creditCheck.ts` `creditBudgetFor` reads what the payer has left:

| Payer | Compared with | Unknown (never blocks) when |
| --- | --- | --- |
| Own OpenRouter key | `spendableUsd` of the owner's last reading of exactly this key: the smaller of the key's remaining limit and the account's USD credits. `latestOwnKeyBalance` (services/accountProviderUsage.ts) uses the saved observation while under 15 minutes old, else reads OpenRouter through the same code as `POST /api/keys/balance` (saved for next time), waiting at most 3.5 s. | no reading, a stale reading that could not be refreshed, a key with no reported limit or credits, no binding secret |
| Own Gemini key (and every dashboard-only provider) | nothing (no balance API) | always |
| DreamStream's allowance (governed) | `caps.usage`: the quote ÷ markup × the share one dollar takes (costText.ts) against `pctLeft`; exhausted never fits | the share of a dollar is unknown, the status was not read, admins and exempt accounts |

A known shortfall starts **nothing** (no reservation, no job) and posts one "Not enough credit" `credit` card. An
approval that was being approved stays open, so the person can approve again after topping up. The director reads
`Not started: not enough credit … Do not say the drawing is under way.`

**Draw what fits** (`drawWhatFits`): for `render_pages` only, the most leading pages (with the sheets they need, never
the cover) whose fresh quote fits, offered as a priced button. It is a direct, priced step: it starts at once and the
balance check runs again.

## 3. The `credit` card

`shared/comic/credit.ts` (type and `normalizeCreditCard`, run on every stored doc). Settles once the chat moves past
it (`shared/comic/settle.ts`). Rendered by `components/comicstudio/usage/CreditCard.tsx` (registered by the `usage`
feature module).

| reason · payer | Title | Actions |
| --- | --- | --- |
| stopped · own key | "Your OpenRouter key ran out of credit" / "Your Gemini key has no image quota" | Top up (the provider's funds page) · Switch key (Settings → API keys) · Draw the rest (priced, what did not start) |
| stopped · allowance | "Drawing paused" | Use my own key · Draw the rest (in usage words) |
| short · own key | "Not enough credit": needs ≈ $X, key has $Y left, when it was read | Top up · Switch key · Draw what fits |
| short · allowance | "Not enough credit": about N% of your usage needed, M% left; ask us for a top-up | Use my own key · Draw what fits |

An allowance card never stores a dollar figure (`needPct` / `leftPct` only; the normalizer drops `needUsd` /
`leftUsd`). Every control is the ink ghost button: no colour on or beside a price or a control that spends.

## 4. The real balance of your own OpenRouter key

`services/keyBalance.ts`: one reading per page for the active OpenRouter key on this device (else the account's saved
key), keyed by a fingerprint (never the key). It reads through `POST /api/keys/balance` (owner bearer, own key only)
when a view that shows it opens and the reading is missing or older than 15 minutes, after a drawing run settles
(something was drawing, now nothing is), and on a tap. Concurrent asks share one request. Nothing polls.

- **Studio header** — `components/comicstudio/usage/KeyBalanceSlot.tsx`, header slot `key-balance` at order 221
  (right after the usage meter; StudioHeader is not edited): "$12.40 left · 5 min ago"; phones show "$12.40" with the
  full sentence in the label. Tap reads again and announces the result. Shown only while the comic draws on the
  person's own key and they have an OpenRouter key; hidden while the balance is unknown.
- **Settings → API keys** — `components/usage/KeyBalancePanel.tsx`, first under "DreamStream usage left": the figure
  large, when it was read (and "an older reading" past 15 minutes), the key limit, its usage and the account credits
  when reported, Check now, Add funds. When OpenRouter shares no balance for the key it says so (set a credit limit on
  the key, or check the credits there). Settings' per-provider "Check provider" feeds the same reading.
- **Governed people** keep the "usage left" percentage in the header (`usage` slot) and in Settings.

## Gotchas

- The check compares the **quote**, which is never under the real price (models.md §2.3), so a run that would just
  fit at list price may be refused; Draw what fits covers that case.
- A reading is HMAC-bound to owner, provider and exact key (`provider_balance_observations`); a server without
  `SUPABASE_SERVICE_ROLE_KEY` treats every own-key balance as unknown.
- No SQL: the observations table already exists (`server/sql/account_provider_analytics.sql`).

## Tests

`server/src/comic/imageClient.credit.test.ts` (classification, `excludeRoutes`), `server/src/comic/jobs.credit.test.ts`
(the run stopping, same-payer continuation, the pre-spend check: fits, short, unknown, governed, the open approval),
`server/src/services/accountProviderUsage.latest.test.ts`, `shared/comic/credit.test.ts`, `services/keyBalance.test.ts`,
`components/comicstudio/usage/{CreditCard,KeyBalanceSlot}.test.tsx`, `components/usage/KeyBalancePanel.test.tsx`.
