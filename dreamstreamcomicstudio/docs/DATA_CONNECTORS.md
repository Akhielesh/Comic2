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
| Article reader (extraction) | Direct fetch + heuristic reader | Jina Reader proxy (keyless best-effort; key lifts limits) | `JINA_API_KEY` (optional) | per-publisher; honest open-original fallback | **reader pane** ✓ |
| Places/POI | Foursquare (keyed) | OpenStreetMap Overpass (overpass-api.de → kumi.systems mirror; name/brand/cuisine-aware search) | `FOURSQUARE_API_KEY` | conditional | **rich card** ✓ |
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
may log or train on it. Code: `server/src/ai/privacy/` (predicate, scope, OpenRouter policy,
provider table, reply provenance).

**How connector content can enter a model call** (`turnUsesConnectorData`, `connectorData.ts`):

| Source | Where | Detected by |
|---|---|---|
| `tools` | a connector tool is offered (chat force-includes the primary tool of each linked account; recipes and swarm agents list their own; the operator's Nango MCP adds `mcp_nango_*`) | tool name (exact list + `gmail_` / `drive_` / `calendar_` / `sheets_` / `connected_data_` / `mcp_nango_` prefixes) |
| `context` | the connector RAG block (`connectors/retrieval.ts`, injected by `ai/chat.ts` when `connectorContext` is on) | a signed-in user with any connection (or a failed lookup) |
| `history` | earlier messages already carry connector output | connector tool calls/results in the messages, the RAG block heading, a provenance marker (`connectorData: true`, or `toolEvents` naming a connector tool), or **the server's own provenance store** (`replyProvenance.ts`): a reply it recorded as connected content, recognised when the client sends it back as plain text |
| `inherited` | an enclosing turn already decided | the privacy scope (`scope.ts`) or the decision `prepareChat` binds to the request's `clientContext` |
| memory | long-term memory distilled from a connected conversation, injected on a later turn | not a turn source: memory is marked when written and kept off free turns (below) |

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
  same pinned model (never refused, never moved to another paid model). The `/swarm` hold adds the
  planner plus up to four agents at the worker model's catalog price (`connectorSwarmHoldUsd`).
  Delegation helpers (`delegate.ts`) and the deep-research planner (`deepResearch.ts`) follow the
  same rule inside a connector turn: the caller's non-free paid net (else `TEXT_FALLBACK`), or the
  pinned paid model under Free only; outside one they keep their free worker.
- The reply carries `connectorData: true`, and is recorded in the provenance store, **only when
  connected content actually entered it**: a model call of the turn really sent the connector
  context block or a connector tool's call or output (the provider reports it to the turn's egress
  probe), the engine added the connector context block to the prompt (`connectorContextUsed` on
  the `runChat` result), a connector tool ran, or the history already carried connector content. Deny is still
  decided up front for every turn that may carry it.
- Title, memory and follow-up helpers send the flag for a user with any connection.
- Recipes (`routes/recipes.ts`): `/run` runs the whole recipe inside `prepareChat`'s decision
  (also when the request carries no `clientContext` for `runRecipe` to read it from) and marks its
  reply by the chat route's rule (`connectorContentEntered`: `connectorData: true` in the `final`
  event, plus the provenance store). A swarm recipe's hold adds its paid planner and agents
  (`connectorSwarmHoldUsd`). `/distill` sends the transcript to the model, so a transcript that
  carries connector output (a connector tool's output, the RAG block heading) makes the reflection a
  connector call; a free reflection of one (`prepareChat`'s free-turn decision: Free only without a
  pinned paid model, a pinned free model) is refused with the same 409 before anything is reserved.
- If no endpoint that meets the policy can serve the model, the user is told so plainly
  (`CONNECTED_DATA_NO_PRIVATE_ENDPOINT`), never retried on a free model. A capacity failure of the
  shared key (spend cap, out of credits) says so without the generic "switch to a free model"
  advice, which such a conversation cannot follow.

**Free models never receive connector content:**
- A free turn (Free only, a pinned free model, or the free chain used while the shared key is
  capped) gets **no connector tool** and **no connector context block**. When the user has
  connections, the model is told why (so it explains instead of guessing), and a message that
  asked for connected data gets a notice.
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
  them. A free turn of a user with connections gets **no memory distilled from connected
  content**: the server memory lookup skips the marked rows (`buildUserMemoryBlock(…,
  { excludeConnected })`: full-text and recency queries filter `product`; the vector search asks
  for twice the rows and drops the marked ones), so the rest of their memory still personalises
  the turn. The memory the client composes into `systemPrompt` (the "Background facts about the
  user" block, parity-tested against the client) is stripped; the persona stays. The client keeps
  the `connectorData: true` answer as a flag on its local memory and leaves that memory out of
  Free only turns itself (below), which also covers users who removed every connection.
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
  flagged memory is never composed into a turn that may run on a free model: every Free only turn,
  and any turn naming a free model (`:free` or $0 in the catalog). The persona is kept.
- *Calm notice.* The 409 `CONNECTED_DATA_NEEDS_STANDARD_MODEL` (chat, swarm, recipes, or the
  provider backstop's refusal arriving mid-stream as copy alone) and a 402 whose copy carries the
  connected-content budget sentence become an info notice turn: the server's copy, `role="status"`,
  the info tone (`TONE_SURFACE.info`, `TONE_TEXT.info`), and two actions with 44 px targets on touch screens. They are never an error
  turn, never history sent back, and get no follow-ups or feedback.
  - Free-model refusal: **Use a standard model** turns Free only off and sends the message again on a
    standard model, or opens the model picker when a free model is pinned on the chat (or locked in
    Settings). **New chat** is the other action.
  - Usage refusal: **New chat** and **API keys**, the two ways forward its copy names. A standard
    model is not offered there, because the usage is what ran out.

**Turns without connector content are unchanged** (users with no connections, no marked
history): the OpenRouter body is byte-identical to before (verified by hashing the request
bodies of a plain paid and a plain free-only turn against the previous code).

**Other providers** (`providerPolicies.ts`; this table changes no routing):

| Provider | Coverage |
|---|---|
| OpenRouter | per-request `data_collection: 'deny'` + no free models (above) |
| OpenAI, Anthropic | their published API terms: API data is not used for training by default |
| Gemini (direct key) | **owner to confirm** the platform key is on a paid (billing-enabled) project: unpaid Gemini API use may be used to improve Google products and read by human reviewers |
| NVIDIA, DeepSeek, Z.ai, MiniMax, Tencent, xAI | **not verified**: owner to confirm before connector content is used with them |

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
  unflagged. The client can only withhold flagged memory from turns it knows may be free. Two server
  re-plans move a turn onto free models after the client composed it: the usage-budget re-plan and
  the capped-key free chain. For a user who removed every connection, those re-plans still carry
  flagged memory, because the server strips the block only for users with connections. The same
  user's paid turns carry it without `deny`.
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
   call `assertProviderBudget`/`noteProviderCall` in a custom fetcher; add the
   hostname to `HOST_TO_PROVIDER` + a budget in `DEFAULT_BUDGETS`
   (`lib/providerUsage.ts`).
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
