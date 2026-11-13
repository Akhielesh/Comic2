# Data Connectors Registry

> **Two different "connector" systems — don't conflate them.** This doc covers
> **data-source connectors**: operator-keyed external APIs (weather/finance/news/maps)
> wired as chat *tools*, keyed from env, no per-user credentials. The separate
> **account connectors** framework (users connecting *their own* Gmail/Drive/Maps
> accounts via OAuth/API-key, with encrypted per-user tokens) is documented in
> [`CONNECTORS_FRAMEWORK.md`](./CONNECTORS_FRAMEWORK.md). The two share no tables/code.

**AI agents: this is the authoritative map of which API serves which topic, its
access/license terms, and how fully its data is rendered. When the user asks
"do we cover topic X?" answer FROM THIS DOC + `toolCatalog.ts`; when a topic is
missing, follow "Adding a connector" below and update this doc in the same PR.**

Machine-readable source of truth: `toolCatalog.ts` (`TOOL_CATALOG` — per-tool
provider/auth/license/rateLimit; `CONNECTOR_KEYS` — key onboarding). This doc adds
the topic→source mapping, utilization status, and operating rules.

Full per-tool inventory (all 102 tools × rendering × board-eligibility ×
verification status, plus the complete logs/analytics/metrics collection list):
**`docs/audits/2026-06-platform-data-audit.md`**.

## Topic → source map (verified June 2026)

| Topic / field | Primary source | Fallback(s) | Access (env) | Commercial license | Rendering |
|---|---|---|---|---|---|
| Web search | Self-hosted SearXNG | Tavily → Brave → Serper → Google CSE → DDG/Bing scrape → Wikipedia | `SEARXNG_URL`, `TAVILY_API_KEY`, `BRAVE_API_KEY`, `SERPER_API_KEY` | conditional (keyless scrapers best-effort) | text + citations |
| Weather/AQI | MET Norway (free, CC BY) | Open-Meteo (fallback; primary when `OPEN_METEO_API_KEY`/`OPEN_METEO_BASE_URL`) | `MET_USER_AGENT` | attribution ✓ | **rich card** ✓ |
| Flight fares | Amadeus Self-Service (Flight Offers Search; real GDS fares) | web_search fallback when unkeyed | `AMADEUS_API_KEY`/`AMADEUS_API_SECRET` (+ `AMADEUS_PRODUCTION` for the prod host) | free quota then PAYG ✓ | **rich card** ✓ (`search_flights` → `flight_results`) |
| US equities | Yahoo (unofficial, consolidated tape — full volume/52w/fundamentals/5Y) | Alpaca IEX (keyed; licensed but THIN — IEX-only volume/ranges, no fundamentals; must never preempt Yahoo) → Stooq | `ALPACA_API_KEY_ID/_SECRET_KEY` (fallback only) | conditional | **rich card** ✓ |
| Indices/FX/commodities | Yahoo (unofficial) | Stooq | — | unofficial | **rich card** ✓ |
| Crypto | CoinGecko (+ demo/pro key; misconfigured keys auto-fall back keyless; majors skip /search; 60s result cache) | none legal (exchange-direct feeds PROHIBIT commercial display) | `COINGECKO_API_KEY`, `COINGECKO_API_PLAN` | $35/mo Basic for commercial + attribution | **rich card** ✓ |
| Fiat FX rates | Frankfurter (ECB) | — | — | commercial-ok ✓ | text |
| News | Google News RSS (unofficial; article links decoded to publisher URLs server-side) | — (GDELT is the planned fallback) | — | unofficial — never sole source | **rich card** ✓ + split reader |
| Article reader (extraction) | Direct fetch + heuristic reader (`fetchPublicUrl`: every redirect hop re-checked, resolved IP pinned; 9 s deadline over headers and body; 1 MB download cap, all of it parsed — a `<main>`/`<article>` still open at the cap is read from its opening tag; text decoded in the page's declared charset; linear-time scanner) | Jina Reader proxy — **signed-in callers only** (`readArticle(…, { allowJina })`; no account context = no Jina; keyless best-effort; key lifts limits; response capped at 1 MB) | `JINA_API_KEY` (optional) | per-publisher; honest open-original fallback | **reader pane** ✓ |
| Places/POI | Foursquare (keyed; budgeted 20/min, 300/day) | OpenStreetMap Overpass (overpass-api.de → kumi.systems mirror; name/brand/cuisine-aware search) | `FOURSQUARE_API_KEY` | conditional | **rich card** ✓ |
| Video search | YouTube Data API (keyed; budgeted 10/min, 80/day — a search costs 100 of the key's 10,000 daily units) | DuckDuckGo video scrape (keyless) | `YOUTUBE_API_KEY` | YouTube API ToS | **rich card** ✓ |
| Geocoding/maps | OSM Nominatim | Open-Meteo geocoder | — | fair-use ✓ | **map** ✓ |
| Directions/routing | FOSSGIS OSRM (drive/bike/foot, alternatives) | — (transit deep-links to Google Maps) | — | fair-use demo server ✓ (budgeted 20/min) | **rich card** ✓ animated routes |
| IP geolocation | IPinfo Lite (keyed) | ip-api.com (NON-commercial — dev only) | `IPINFO_TOKEN` | attribution ✓ | text |
| Knowledge/papers/books | Wikipedia, arXiv, OpenLibrary | — | — | open ✓ | **rich cards** ✓ (document; HN → news card + split reader) |
| Geo/civic (countries, holidays, time, postal) | REST Countries (⚠ legacy API deprecated June 2026 — country_info needs migration to the keyed v5), Nager.Date, Zippopotam | — | — | open ✓ | **rich cards** ✓ (metric board / data table / live clocks) |
| Space/science | Open Notify, SpaceX API, USGS | — | — | open ✓ | **rich cards** ✓ (maps / data tables; APOD = image) |
| Food, words, entertainment | TheMealDB/CocktailDB, dictionaries, Jikan etc. | — | — | open/fair-use | **rich cards** ✓ (document / metric board; one-liner + trivia tools stay text by design) |
| Dev (GitHub, npm, PyPI, QR) | public APIs | — | — | open ✓ | **rich cards** ✓ (data table / metric boards; QR = image, predict_name text by design) |
| 800+ SaaS (OAuth) | Nango (self-hosted) | — | `NANGO_SECRET_KEY` | per-provider | text |
| Anything via MCP | 13 curated + user-added servers | — | per-server | per-server | text |

Topics with **no source yet** (candidates verified in the June 2026 audit): real
estate (RentCast paid / FRED+Census free), jobs (Adzuna/USAJobs/BLS), elections
(OpenFEC; 538 is dead), shipping (EasyPost), recalls (CPSC/NHTSA/openFDA), flights
live (OpenSky needs written consent), sports (TheSportsDB grade-C), SEC
fundamentals (EDGAR companyfacts — free, commercial-ok, NOT yet integrated).

## Guardrails & account tracking (operating rules)

- Every upstream call is metered by `server/src/lib/providerUsage.ts`: per-minute +
  per-day budgets under each free tier (override: `PROVIDER_BUDGETS` JSON env).
  Budget hit ⇒ graceful skip to next provider / honest notice — never burn quota.
  The provider is decided by the URL's **host only** (YouTube: the googleapis host plus its
  `/youtube/` path) — user text in a query string never moves a call into another budget.
  `assertProviderBudget` **reserves** the call before it is sent (calls in flight count, so
  concurrent requests cannot overshoot); `noteProviderCall` records only the outcome, and
  `releaseProviderReservation` gives a slot back when the caller sends nothing after all.
  Keyed providers called with a custom `fetch` used to bypass this (Foursquare, YouTube —
  fixed 2026-11-05): route every keyed call through `fetchJson`/`fetchText`/`fetchTextCapped`.
- User/model-supplied pages (reader mode, link unfurl, deep-research reads) are metered in
  their own per-host bucket (`page:<host>`, the 60/min · 3000/day fallback) — never as the
  provider a URL happens to name — with at most 500 hosts tracked and one `web-page` row per
  account and day in the usage log. They are not shown as providers in the dashboard.
- **Open:** budgets are shared by everyone. A per-anonymous-caller share cap (signed-out
  visitors may spend at most a slice of a keyed provider's day) needs a caller identity the
  helper does not have yet — see `docs/infrastructure/SECURITY_FINDINGS.md` (abuse-ops-6).
- Live view: Settings → Tools → "Provider usage today", or `GET /api/usage/providers`.
- **Account-wise cloud log**: per-(account, provider, day) call/error/blocked deltas
  flush every ~60 s to Supabase `provider_usage_log` (append-only; daily totals in
  the `provider_usage_daily` view; RLS server-only). Account attribution comes from
  `lib/accountContext.ts` (AsyncLocalStorage set by `attachAccountContext`).
  Per-request HTTP metrics (latency, status, userId, requestId) are logged by
  `requestLogger` as JSON lines.
- Caching: search 5 min, weather 10 min, quotes 60 s (`lib/cache.ts` TtlCache).

## Connected-account privacy and model routing (Google Limited Use)

Applies to the **account connectors** (Gmail, Drive, Calendar, Sheets, Maps, the unified
`connected_data_search`, `nango_call_api`, which proxies any API the user connected through
Nango, and the operator's self-hosted Nango MCP, whose tools arrive as `mcp_nango_*` when
`STUDIO_NANGO_MCP_URL` is set). Content from those accounts must never reach a model endpoint that
may log or train on it: on OpenRouter by a per-request control (below), on a direct provider by its
terms, and only once the owner confirmed them for the platform key (`providerPolicies.ts`,
`CONNECTOR_PROVIDERS_CONFIRMED`). Code: `server/src/ai/privacy/` (predicate, scope, OpenRouter
policy, provider table, reply provenance). Tool arguments that leave a connector turn by other
routes (image APIs, third-party MCPs, web search) are listed under "Known gaps".

**How connector content can enter a model call** (`turnUsesConnectorData`, `connectorData.ts`):

| Source | Where | Detected by |
|---|---|---|
| `tools` | a connector tool is offered (chat force-includes the primary tool of each linked account; recipes and swarm agents list their own; the operator's Nango MCP adds `mcp_nango_*`) | tool name (exact list + `gmail_` / `drive_` / `calendar_` / `sheets_` / `connected_data_` / `mcp_nango_` prefixes) |
| `context` | the connector RAG block (`connectors/retrieval.ts`, injected by `ai/chat.ts` when `connectorContext` is on) | a signed-in user with any connection (or a failed lookup) |
| `history` | earlier messages already carry connector output | connector tool calls/results in the messages, the RAG block heading, a provenance marker (`connectorData: true`, or `toolEvents` naming a connector tool), or **the server's own provenance store** (`replyProvenance.ts`): a reply it recorded as connected content, recognised when the client sends it back as plain text |
| `inherited` | an enclosing turn already decided | the privacy scope (`scope.ts`) or the decision `prepareChat` binds to the request's `clientContext` |
| memory | long-term memory distilled from a connected conversation, injected on a later turn | marked when written and kept off withheld turns (below); on a paid turn, flagged client memory still in the prompt counts as `history`, and marked server rows make that call deny data collection |

**What a connector turn does** (paid OpenRouter turn where any source applies):
- Every OpenRouter call of the turn sends `provider: { data_collection: 'deny' }` (OpenRouter:
  "use only providers which do not collect user data"; merged into any existing `provider`
  fields). This covers the first call, every tool-loop round, the provider retry and fallback
  model, the JSON repair round, streaming, the auto-memory summary, the swarm's planner, agents
  and synthesis, deep research and delegation, and recipes. It travels as an AsyncLocalStorage
  scope (`runWithConnectorPrivacy`), so engine code needs no new parameter.
- No free model takes it: free members leave the chain; a nested engine that picked a free
  worker is moved to the paid net its caller already reserved for (logged as
  `connector_privacy_free_model_skipped`). A free-only request is refused instead, never moved to
  a paid model. "Free" is a `:free` id **or** a model the live catalog prices at $0
  (`costClass: 'free_verified'`, the pickers' own rule); the chat routes register that catalog
  lookup with the provider. If the catalog cannot be read within 1.5 s, the `:free` rule alone
  applies and the request still denies data collection (a $0 model without the suffix is then
  covered only by `deny`).
- Swarm: the planner and agents use the paid net instead of a free worker. With Free only on and
  a **paid model pinned**, the turn is a flagged paid turn, so the planner and agents run on that
  same pinned model (never refused, never moved to another paid model). The hold adds the planner
  plus up to four agents at the worker model's catalog price (`connectorSwarmHoldUsd`), on `/swarm`
  and on a chat turn that offers the `run_agent_swarm` meta-tool.
  Delegation helpers (`delegate.ts`) and the deep-research planner (`deepResearch.ts`) follow the
  same rule inside a connector turn: the caller's non-free paid net (else `TEXT_FALLBACK`), or the
  pinned paid model under Free only; outside one they keep their free worker.
- The reply carries `connectorData: true`, and is recorded in the provenance store, **only when
  connected content actually entered it**: a model call of the turn really sent the connector
  context block or a connector tool's call or output (the provider reports it to the turn's egress
  probe), the engine added the connector context block to the prompt (`connectorContextUsed` on
  the `runChat` result), a connector tool ran, or the history already carried connector content. Deny is still
  decided up front for every turn that may carry it. The probe is registered on every turn, flagged
  or not, and hears nested connector runs: an unflagged turn whose swarm or recipe ran a connector
  agent is marked too.
- The SSE `meta` event of `/stream`, `/swarm` and `/api/recipes/run` carries `connectorPrivacy`
  (the turn may carry connected content), so the client can mark a reply the user stops before
  `final` (below).
- Title, memory and follow-up helpers send the flag for a user with any connection. Every helper
  (enhance, title, memory, auto-memory, memory import, follow-ups) calls the resolved provider's own
  model (`helperModelFor`: the fast defaults on OpenRouter and NVIDIA, a direct provider's default
  chat model from `ai/gateway.ts`); a direct provider used to receive the OpenRouter slug and fail
  silently. `POST /api/chat/memory` runs on the `source` the client sends: the source the turn ran
  on (`reqSource`, the one the auto-title gets; in Auto, the source Auto picked, locked or not), sent
  only when there is one, under the same gates. The
  auto-memory summary of a conversation that carries, or may carry, connected content denies data
  collection whatever the turn was (a connected user's free turn is not flagged; its summary is).
- Recipes (`routes/recipes.ts`): `/run` runs the whole recipe inside `prepareChat`'s decision
  (also when the request carries no `clientContext` for `runRecipe` to read it from) and marks its
  reply by the chat route's rule (`connectorContentEntered`: `connectorData: true` in the `final`
  event, plus the provenance store). A swarm recipe's hold adds its paid planner and agents
  (`connectorSwarmHoldUsd`). `/distill` sends the transcript to the model, so a transcript that
  carries connector output (a connector tool's output, the RAG block heading) makes the reflection a
  connector call; a free reflection of one (`prepareChat`'s free-turn decision: Free only without a
  pinned paid model, a pinned free model) is refused with the same 409 before anything is reserved.
  A transcript as the user saw it is plain text with no markers, so a free reflection is also
  refused for a signed-in user who has (or may have) connections or whose replies the provenance
  store marked (`conversationMayCarryConnectorData`).
- If no endpoint that meets the policy can serve the model, the user is told so plainly
  (`CONNECTED_DATA_NO_PRIVATE_ENDPOINT`), never retried on a free model. A capacity failure of the
  shared key (spend cap, out of credits) says so without the generic "switch to a free model"
  advice, which such a conversation cannot follow.

**Free models never receive connector content:**
- A free turn (Free only, a pinned free model, or the free chain used while the shared key is
  capped) gets **no connector tool** and **no connector context block**. When the user has
  connections, the model is told why (so it explains instead of guessing), and a message that
  asked for connected data gets a notice.
- A free turn's swarm (the `run_agent_swarm` meta-tool, or `/swarm` on a pinned free model) gives
  its agents **no connector tool** (`RunSwarmParams.withholdConnectorTools`, also read from the
  request's bound decision), because its answer goes back to the free model. The run never becomes
  a connector run, so it is never moved to a paid model for privacy either.
- A free turn whose history already carries connector content is **refused** with HTTP 409
  `CONNECTED_DATA_NEEDS_STANDARD_MODEL` before anything is reserved or sent: what happened, why,
  and the two ways forward (switch to a standard model, or start a new chat without connected
  content). "Turn off Free only" is said only to someone in Free only; a pinned free model gets
  "pick a standard model instead of the free one". It is never silently moved to a paid model.
  Today's client sends history as plain text, so the provenance store is what recognises such a
  history (see "Reply provenance" below).
- **Memory:** facts distilled from a conversation that carries, or may carry, connected content
  (any provider; a user with any connection) are stored with `product = 'chat_studio_connected'`
  (`CONNECTED_MEMORY_PRODUCT`), and `POST /api/chat/memory` answers `connectorData: true` for
  them. Every withheld turn (a free turn, the usage re-plan, the capped-key free chain, an
  unconfirmed direct provider) gets **no memory distilled from connected content**, whatever the
  user's connections (a user who removed every connection keeps the marked rows): the server memory
  lookup skips the marked rows (`buildUserMemoryBlock(…, { excludeConnected })`: full-text and
  recency queries filter `product`; the vector search asks for twice the rows and drops the marked
  ones), so the rest of their memory still personalises the turn. The memory the client composes
  into `systemPrompt` (the "Background facts about the user" block, parity-tested against the
  client) is stripped for a user with connections, and whenever the request says that memory is
  flagged (`ChatRequest.memoryConnected`); the persona stays.
- On a **paid** OpenRouter turn, flagged client memory still in the prompt makes the turn carry
  `history` (deny, no free model), and a server memory block that includes a marked row makes that
  call deny data collection (`buildUserMemoryBlock` reports it; `ai/chat.ts` sets
  `dataCollection: 'deny'`). Such a reply may restate that memory, so it is marked and recorded
  like a connector reply (`connectedMemoryUsed` on the `runChat` result), and its auto-memory
  summary is stored marked. `POST /api/chat/memory` treats a flagged `existing` memory
  (`memoryConnected: true`) as connected content: the merge denies data collection and its result
  is stored marked, so flagged memory is never laundered into unmarked rows.
- Memory distilled from connected content is stored **without an embedding** until the owner lists
  `gemini` in `CONNECTOR_PROVIDERS_CONFIRMED`: embeddings go to the Gemini API with the platform
  key `ASSISTANT_GEMINI_API_KEY` (falling back to `GEMINI_API_KEY`). Full-text and recency
  retrieval still find those rows.
- The memory **query** is gated the same way. The vector search embeds the turn's last user message
  (up to 8,000 characters) through that Gemini key, and that message can carry connected content (a
  follow-up chip built from a connected reply, a pasted connected item). `runChatParams` sets
  `userMemoryNoQueryEmbedding` (→ `buildUserMemoryBlock(…, { noQueryEmbedding })`) in two cases:
  - `prepareChat`'s `memoryNoQueryEmbedding`: the conversation may carry connected content (the
    helpers' `conversationMayCarryConnectorData` test: marked history, a user with any connection, a
    failed lookup, or a recorded connected reply) and `gemini` is not in
    `CONNECTOR_PROVIDERS_CONFIRMED`. It is answered from what the turn already looked up (the memoized
    connection rows, the provenance-store lookup when the turn made one), so the gate adds no lookup
    of its own on the usual path;
  - every withheld turn (`connectorPrivacy.withheld`: free, an unconfirmed direct provider, or the
    usage-budget free re-plan `freeModelsOnlyPlan`, which withholds the turn after `prepareChat`
    ran) of a user with, or maybe with, connections, whatever is confirmed.

  Such a turn makes no `embedContent` request: retrieval uses full-text search, then recency. A user
  with no connection and no marked or recorded history keeps the vector search.
- **Memory import** (Settings → Memory → Import from another AI; `services/memoryImport.ts`) sends at most 24,000 characters. From JSON it sends only the user's own words: the user's turns of a ChatGPT or Claude export (or any turn marked as the user's), memory and instruction fields with the `text` / `content` / `value` inside them, and the text after "Prompted " / "Searched for " in a Google Takeout activity title (never the answer in `safeHtmlItem`); a `text` / `content` / `value` key anywhere else is never taken, because exports keep the assistant's answers there too. JSON in which none of these is found sends nothing: no request, and the modal says "We couldn't find your own words in that file, so nothing was sent." A .jsonl file (JSON Lines: at least two lines, every one a JSON object or array) is read the same way, line by line, so its assistant lines are never sent and a file with none of the user's own words sends nothing. A cut-off export (text that opens like JSON, `{"`, `["` or `[{"`, but parses neither whole nor line by line) sends nothing, with the same notice, because its raw text holds the assistant's replies too. Text that isn't JSON at all (plain text, markdown, a checklist like "[x] …") is sent as written.
- The free-model fallbacks never take a conversation that carries, or may carry, connector
  content (marked history, or a user with connections and an earlier assistant reply): the capped
  shared key keeps the paid chain and its capacity failure is reported; the usage-budget re-plan
  is refused with an added sentence saying why. The first message of a new chat can still fall
  back to a free model, with connector tools and context withheld.

**Reply provenance** (`replyProvenance.ts`, table `chat_connector_replies`,
`server/sql/chat_connector_replies.sql`): for every marked reply the backend stores a SHA-256 of
its normalised text per user (never the text), keeps the newest 2,000 per user for up to a year,
and service role only. A later OpenRouter turn of a signed-in user with earlier replies looks
their hashes up once (time-boxed to 1.5 s, run alongside model resolution); a match makes the
history `history`. A failed write or lookup falls back to an in-process cache and is logged as
`connector_reply_marks_unavailable` (at most once a minute); it never blocks a chat. Until the SQL
is applied the cache only covers the awake container, so apply it before deploying.

**Chat client** (`components/chat/connectorPrivacy.ts`; the code strings and tool list duplicate
the server's and `connectorPrivacy.parity.test.ts` reads both):
- *Echo.* An assistant turn whose reply carried `connectorData: true`, or whose tool events name a
  connector tool (the families above), is sent back with `connectorData: true` on its
  `ChatRequestMessage` (chat, swarm, recipes, title, memory, follow-ups). The server then
  recognises the history exactly, without the provenance lookup. The flag is stored on the turn and
  on each regenerated version, so flipping versions sends the shown version's mark.
- *Memory flag.* When `POST /api/chat/memory` answers `connectorData: true`, the local memory is
  flagged (`chatStorage` `markChatMemoryConnected`). The flag is sticky until the memory is cleared
  and follows the memory to other devices in the account snapshot (merged as either side). A
  flagged memory is never composed into a turn that may run on a free model: an OpenRouter (or
  Auto) turn with Free only on, and any OpenRouter turn naming a free model (`:free` or $0 in the
  catalog). A direct-provider turn (OpenAI, Anthropic, Gemini, …) never runs on a free model, so
  its flagged memory is kept; the server strips it where that provider's platform key is not
  confirmed. Every chat, swarm and recipe request, and the `/memory` merge, sends
  `memoryConnected: true` while the flag is set, so the server applies the rules above even when it
  re-plans the turn. The persona is kept.
- *Stopped replies.* A reply the user stops (or that is cut off) keeps its partial answer as
  history, so it keeps the mark too: when the stream's `meta` said `connectorPrivacy: true`, or its
  live trace (`agent_activity` steps, `swarm_trace` agents) names a connector tool
  (`stoppedTurnMarker`). Over-marking a connected user's stopped reply is safe.
- *Calm notice.* The 409 `CONNECTED_DATA_NEEDS_STANDARD_MODEL` (chat, swarm, recipes, or the
  provider backstop's refusal arriving mid-stream as copy alone) and a 402 whose copy carries the
  connected-content budget sentence become an info notice turn: the server's copy, `role="status"`,
  the info tone (`TONE_SURFACE.info`, `TONE_TEXT.info`), and two actions with 44 px targets on touch screens. They are never an error
  turn, never history sent back, and get no follow-ups or feedback.
  - Free-model refusal: **Use a standard model** works from the model the resend would actually use
    (`standardModelAction`, resolved as a send resolves it). When Auto picked a free model, the
    message is sent again on Auto's best standard pick and Free only stays as it is (Free only with
    a named paid model is a paid turn). When the user chose the free model (pinned on the chat, or
    locked in Settings), or the turn ran on a direct provider, the model picker opens. When no model
    is named and Free only is on, Free only is turned off and the message sent again. When the model
    is already standard (the user just picked one), the message is sent again. **New chat** is the
    other action.
  - Usage refusal: **New chat** and **API keys**, the two ways forward its copy names. A standard
    model is not offered there, because the usage is what ran out.

**Turns without connector content are unchanged** (users with no connections, no marked
history): the OpenRouter body is byte-identical to before (verified by hashing the request
bodies of a plain paid and a plain free-only turn against the previous code).

**Other providers** (`providerPolicies.ts`):

| Provider | Coverage |
|---|---|
| OpenRouter | per-request `data_collection: 'deny'` + no free models (above) |
| OpenAI, Anthropic | their published API terms: API data is not used for training by default |
| Gemini (direct key) | **owner to confirm** the platform keys are on a paid (billing-enabled) project: `GEMINI_API_KEY` (chat) and `ASSISTANT_GEMINI_API_KEY` (memory embeddings; it falls back to `GEMINI_API_KEY` and may be a different project). Unpaid Gemini API use may be used to improve Google products and read by human reviewers |
| NVIDIA, DeepSeek, Z.ai, MiniMax, Tencent, xAI | **not verified**: owner to confirm before connector content is used with them |

**Fail closed until the owner confirms.** A turn on a direct provider marked "owner to confirm",
through the **platform** key (not the user's own), is treated like a free turn until the owner
lists the provider in `CONNECTOR_PROVIDERS_CONFIRMED` (comma-separated, e.g. `gemini,nvidia`;
`docs/infrastructure/ENV_MATRIX.md`): no connector tools (the JSON tool protocol included), the connector context
block off, no marked server memory, the flagged or connected client memory block stripped, the
model told why, and a 409 `CONNECTED_DATA_NEEDS_STANDARD_MODEL` (with copy naming the provider)
when the history already carries connected content. Its title, follow-up and memory helpers skip a
conversation that may carry connected content ($0, nothing sent), and so does its auto-memory. A
user's own key (BYOK, header or account key) is their own account and is not gated.

**Decisions (lead, accepted 2026-11-04):**
- *Server provenance store, fail-open.* Replies connected content entered are recognised by the server's own store
  (`replyProvenance.ts`) as well as by the client's echo; a store or database failure falls back to the in-process cache
  and is logged, and never blocks a chat (the cost: replies from before a restart can be missed while the store is down).
- *Catalog lookup registration.* "Free" includes a model the live catalog prices at $0; `routes/chat.ts` registers that
  lookup with the provider instead of a dynamic import. A process that never loads the chat routes uses the `:free`
  rule alone.
- *Egress probe.* A reply is marked only when connector content actually entered it (the provider reports what a
  denied body carried), while deny is still decided up front.
- *Memory marking rule.* Memory distilled from a conversation that carries, or may carry, connected content is marked
  for any provider (a connected user's memory included), and a connected user's free turn retrieves memory without the
  marked rows.
- *Free only with a pinned paid model is a flagged paid turn:* connector tools stay, data collection is denied, no paid
  retry. Its swarm, delegation and deep-research workers run on that pinned model, and `/api/recipes/distill` runs it
  rather than refusing.
- *402 notice: New chat + API keys* (accepted 2026-11-05; replaces wave note 3's pair for the usage refusal only). The
  usage is what ran out, so a standard model cannot run either; the notice offers **New chat** and **API keys**, the two
  ways forward the server's budget sentence names. The Free only refusal keeps "Use a standard model" and "New chat".

**Known gaps** (also in `docs/infrastructure/SECURITY_FINDINGS.md`, C1):
- *History provenance (C1a, partly fixed).* Replies are recognised by the server's provenance store
  from the day it is deployed. Not covered: replies from conversations before the deploy, a reply
  the client changed before sending it back, and the window when the store is unavailable (the
  in-process cache then covers only the awake container). The client echo closes this for every
  reply it received with the mark, and for stored turns whose tool events name a connector tool
  (older chats included). Still open: a reply from before the deploy that drew only on the
  connector context block (no tool event), while the store cannot answer. Degraded free fallbacks
  stay conservative (a user with connections and an earlier assistant reply never gets one).
- *Memory (C1d, partly fixed).* Server memory written before this change is unmarked, so a free
  turn retrieves it like any other unmarked row: a connected user's free turns get it (retrieval
  skips only the marked rows), and so do the free turns of a user who removed every connection.
  The client flags memory only from the day it ships, so a local memory distilled earlier is
  unflagged. Flagged memory (marked rows, flagged client memory) is handled whatever the user's
  connections: excluded or stripped on every withheld turn, the free re-plans included, and denied
  on paid turns.
- *Other egress on a connector turn* (`providerPolicies.ts` `CONNECTOR_TURN_OTHER_EGRESS`). On a
  flagged turn the model writes tool arguments that leave the deny scope, and could quote connected
  content into them: `generate_image` calls the Gemini, Ideogram, Pixazo (Flux), OpenAI and xAI
  image APIs directly (Ideogram and Pixazo terms are not verified); the always-on reference MCPs
  (Context7, DeepWiki; off when external MCP is disabled); web search and the other keyless tools.
  None of them is routed by this policy. The OpenRouter image path's deny
  (`ai/providers/openrouter.ts` `generateImage`) is not reached by any chat path today.
- User-configured MCP servers are the user's own services, not connectors this app holds OAuth
  grants for; their tools are not treated as connector content. The operator's Nango MCP is.
- `OPENROUTER_FREE_TEXT_MODEL` (config, a `:free` endpoint by default) is not read by any server
  path today.
- The public privacy policy's Limited Use statement ("never to free models") must ship **after**
  the provenance SQL is applied and the client changes above are deployed (C1a, C1d).

## Rendering coverage (honest status)

Rich artifact cards exist for: weather, markets, crypto, news, places, finance
widgets (ticker tape, sentiment, yield curve, portfolio, calendars), travel
widgets, learning, dataviz, dashboards (see `ARTIFACT_RENDERERS` in
`components/chat/artifacts/ChatArtifacts.tsx`).

**June 2026: the long-tail packs (knowledge, geo, space, food, words,
entertainment, dev) now emit EXISTING rich artifact types server-side** — no
new renderers were added. 23 tools upgraded: wiki_lookup / search_papers /
search_books / define_word / find_recipe / find_cocktail / tv_show / anime_info
→ `document`; hacker_news → `news_results` (split reader); country_info /
sun_times / pokemon_info / npm_package / pypi_package → `metric_board`;
public_holidays / zip_lookup / find_university / people_in_space /
space_launches / github_repo → `data_table`; world_time → `world_clocks`;
iss_location / earthquakes → richer `map` markers (telemetry, depth/time, cap
10). Pure mapping helpers are exported + unit-tested in the packs' `*.test.ts`
files.

Deliberately still text (each carries a one-line code comment saying why):
number_fact, useless_fact, random_joke, random_advice, word_assoc (one-sentence
payloads), trivia_questions (feeds the interactive quiz flow), predict_name
(statistical guesses — a KPI board would overstate them), qr_code / nasa_apod
(already render via the images channel), ip_lookup, exchange_rate, web_search,
Nango and MCP results.

## Adding a connector (checklist for agents)

1. **License first**: confirm the free tier permits commercial display (TOS, not
   the pricing page headline). "Free tier" ≠ "free for commercial use."
2. Implement in `server/src/ai/tools/` using `http.ts` fetchers (auto-metered) or
   call `assertProviderBudget` (it reserves the call) then `noteProviderCall` (the outcome) in
   a custom fetcher — never a bare `fetch`, which skips the budget; add a host pattern to
   `HOST_TO_PROVIDER` (it is matched against the hostname only: `(^|\.)example\.com$`; a
   path-specific provider on a shared host, like YouTube on `googleapis.com`, is a special
   case in `providerForUrl`) + a budget in `DEFAULT_BUDGETS` (`lib/providerUsage.ts`). A URL
   that comes from a user or the model goes through `fetchTextCapped({ publicOnly: true })`.
3. Register in `registry.ts`; add catalog entry in `toolCatalog.ts` with honest
   `license`/`licenseNote`/`rateLimit`; add env var to `.env.example` and, if
   keyed, to `CONNECTOR_KEYS`.
4. Prefer a rich artifact (see `CLAUDE.md` pipeline + gallery rule) over text.
5. Update the topic table above. Tests: budget mapping + any pure parsers.
6. **A tool that returns a user's connected-account content** (a new account connector, a new
   Nango-style proxy): add its name to `CONNECTOR_DATA_TOOL_NAMES` in
   `server/src/ai/privacy/connectorData.ts` (the parity test there fails otherwise for account
   connector tools), so connector turns deny data collection and free models never receive it.
   An operator MCP that proxies users' connections goes in `CONNECTOR_MCP_TOOL_PREFIXES`
   (`mcp_<serverId>_`).
