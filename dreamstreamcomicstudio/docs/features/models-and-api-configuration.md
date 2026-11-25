# Models & API Configuration

How users connect providers, compare models, and carry a selection into a supported
studio. See [Models workspace](../MODELS_WORKSPACE.md) for data provenance,
measurement limits, privacy and release verification, and
[Model providers](../MODEL_PROVIDERS.md) for the serving registry and routing.

## API Configuration (`components/ApiConfiguration.tsx`)

- Available from Models → **Connections** and Settings. The shared text-provider
  registry includes OpenRouter, NVIDIA, OpenAI, Anthropic, Gemini, DeepSeek, Z.AI,
  MiniMax, Tencent and xAI; settings also include specialized services.
- Add multiple device keys per provider, choose one active key, replace or delete
  it, set an optional local monthly limit, and enable or disable the source.
  `services/apiKeys.ts` owns device keys and usage. Active keys can sync to the
  signed-in account; a new device receives account-key metadata, not the secret.
  Account middleware resolves the stored credential on the server.
- **Key saved** and **Verified** are different states. Validation checks the
  selected device or account key without silently testing a platform key. Provider
  outages do not establish that a credential is invalid, and a public model list
  does not establish authentication or model access. A replacement clears the old
  verdict; late validation responses cannot validate the replacement.
- Source governance and local limits apply to selection and routing. Platform
  availability does not bypass a rejected explicit key or a disabled source.
- **Your OpenRouter balance** (`components/usage/KeyBalancePanel.tsx`) sits first,
  under "DreamStream usage left", whenever you have your own OpenRouter key: what the
  key can still spend (the smaller of its limit left and the account's credits, as
  OpenRouter reports them), when it was read, the key's limit and usage, Check now and
  Add funds. Opening Settings reads it when the last reading is missing or older than
  15 minutes; nothing polls. The Comic Studio header shows the same reading, and Comic
  Studio checks it before a paid step starts and stops a drawing run when a key runs
  out (see [Credit safety](credit-safety.md)).

## Model Library (`components/ModelLibrary.tsx`)

- The Atlas workspace has **Image models**, **Language models** and **Usage** tabs.
  Both image and language comparisons support up to **three** rows side by side.
- Language models focus on ten makers, initially showing up to three recent
  models each. Search and filters expose their remaining supported models. The
  maker and serving connection are separate. Details include input/output prices,
  context, capabilities, catalog/pricing provenance, authentication state and
  observed full Chat response time where available.
- `/api/models/catalog` combines live discovery, durable discoveries and marked
  curated fallbacks. Partial or failed refreshes remain visible. Unknown pricing
  is **Not reported**, not zero. A listing does not promise account entitlement.
- Image cards compare Nano Banana 2.1, Nano Banana Pro, GPT Image 2.6 Sunburst,
  GPT Image 2.6 Flare and the reference-only FLUX.3. The first four are supported
  Comic models; FLUX.3 has no Studio selection action. Prices are dated registry
  reference prices by resolution. Exact-version benchmark results retain their
  tested settings, source and date, separately from platform observations.
- `/api/models/showcase` supplies only attributable published platform output and,
  when signed in, a bounded selection of the current user's own generated Comic
  assets. Missing examples stay empty. Costs use privacy-approved observations;
  image-generation latency is not currently published by those aggregates.
- Usage charts show recorded platform monthly request counters, not personal
  billing. The QA gallery uses explicit synthetic fixtures and cannot fetch live
  usage, change connections/defaults or start a Chat.

## Model selection (`services/modelSelection.ts`)

- Stores model IDs together with their serving sources, optional preferred
  sources, a provider lock and per-stage overrides. The legacy image/text slots
  remain available to their supported workflows.
- **Set text default** on the Models page applies to new Chat selections and
  supported legacy workflows. **Open in Chat** starts with the chosen model and
  source when the caller supplies that action. Existing conversation pins remain
  independent.
- Comic Studio owns its image-model lock and Director role choices. Comparing an
  image on the Models page does not change those choices. Classic text workflows
  support OpenRouter, NVIDIA and Gemini; an incompatible explicit source returns
  a clear error instead of silently switching providers.

## Flow

1. Models → Connections: enable the intended provider, add or replace its active
   key, and check the validation and account-sync result.
2. Compare models using their serving connection, published prices and available
   observations. Set a text default or choose the supported model inside its studio.
3. The request uses the explicit key or permitted account/platform credential for
   that route. Unsupported sources and unavailable access remain explicit errors.
   Model-specific entitlement and successful generation require a real request;
   saving a key alone does not verify either.

## Account provider activity and balance history

The member dashboard reads the signed-in member’s current UTC calendar month from
`GET /api/usage/account-providers`. It counts settled model operations and observed
unreserved helper calls, plus metered connector requests, failures and budget
refusals. Reservations, cancellations, and matching ledger duplicates are excluded.
Provider-reported personal-key costs and estimates have separate totals. A missing
cost remains unknown. Connector errors are included in admitted calls, while a
budget refusal occurs before the upstream request. Connector persistence can lag
a running instance by about a minute. Activity outside DreamStream is visible
only when a provider reports an account balance or quota that includes it.

`POST /api/keys/balance` uses the selected personal key or the authenticated member’s
saved key. The dashboard can revalidate a supported saved key in the background
after 15 minutes, coalescing concurrent reads and backing off for two minutes
after a failure. An allowed-sources header can disable these background checks.
A dashboard visit reads saved results first. Timestamps identify the actual
observation. Unsupported providers use their own dashboard for balance checks.
The same saved observation is what a Comic Studio paid step compares with
(`latestOwnKeyBalance`): it is used while under 15 minutes old, else OpenRouter is
read again through the `POST /api/keys/balance` code path (bounded wait), and an
unknown or stale balance never blocks a step ([Credit safety](credit-safety.md)).

The operator Cost Centre uses `GET /api/admin/provider-balances` and
`POST /api/admin/provider-balances/:provider`. Both require the admin role.
Its reports use the current platform credential. The runtime guardrails already
available in the Cost Centre reflect DreamStream’s configured limits.

### Database setup and verification

Apply `server/sql/account_provider_analytics.sql` after `token_billing_foundation.sql`,
`provider_usage_log.sql`, and account-key storage. The migration reads historical
ledgers in place. Each successful provider observation retains the latest reported
values for that UTC day and credential. An HMAC binds readings to the owner,
provider and exact credential. Key rotation makes previous observations ineligible
for display on the new credential. Removing an account connection deletes the
provider’s stored observations; account deletion cascades. The service role owns
data access, and direct member and anonymous API roles have no table or routine
privileges. No generation, wallet movement, or historical balance backfill runs
when applying the migration.

Use `node server/sql/tests/harness.mjs account_provider_analytics.test.sql` against
a disposable local PostgreSQL installation to verify isolation, deduplication,
out-of-order updates, and removal. Reverting the API release leaves the additive
analytics tables available for later use.
