# Platform data audit — tools, connections, rendering, telemetry (June 2026)

**Why this exists:** the user asked, fairly, whether anyone had actually gone
through *all* of the platform's tools/APIs/MCPs, how each integrates with the
widget gallery, and what data/logs/metrics the platform collects — in one
honest, verifiable place. This document is that inventory. Every count below is
derived from the code (`toolCatalog.ts`, `registry.ts`, `apiTypes.ts`,
`ChatArtifacts.tsx`, `ComponentGallery.tsx`) — not from memory. Where something
is **not** verified or **not** integrated, it says so.

Regenerate the cross-reference matrix any time:
`TOOL_CATALOG` ⇄ `KNOWN_TOOL_NAMES` ⇄ `REFRESHABLE_TOOLS` (a drift of any kind
is a bug; as of this audit they are perfectly in sync).

## Headline numbers (verified against code, 2026-06-12)

| Surface | Count | Enforced by |
|---|---|---|
| Built-in tools (registry = catalog, zero drift) | **102** | `registry.catalog.test.ts` |
| Dashboard-eligible live tools (`REFRESHABLE_TOOLS`) | **23** | `widgetCatalog.coverage.test.ts` (all 23 + AI tile addable from the board gallery) |
| Rich artifact types with renderers | **54** | `gallery.coverage.test.ts` (every renderer must have a live gallery demo) |
| Curated MCP servers (one-click) | **13** | `mcpCatalog.ts` (+ unlimited user-added servers) |
| SaaS connectors via Nango (self-hosted, keyed) | 800+ integrations | `nango.ts` (dormant without `NANGO_SECRET_KEY`) |
| Optional connector keys (all free tiers) | **10** | `CONNECTOR_KEYS` (surfaced in Settings → Tools) |

## 1. Tool inventory (all 102, by category)

Columns: rendering = how results reach the user today; board = `LIVE-TILE`
means it can live on a dashboard and refresh itself; verification = how far it
has actually been exercised (**live** = executed against the real upstream in
the June 2026 sessions; **unit** = pure parsers/builders unit-tested, upstream
not runtime-verified; **unverified** = code-reviewed only).

### Finance (18) — deep-audited this session
| Tool | Source(s) | Rendering | Board | Verified |
|---|---|---|---|---|
| get_stock | Yahoo (consolidated, primary) → Alpaca IEX (keyed fallback) → Stooq | MarketCard (ranges 1D–MAX, candles, stats, peers, headlines) | LIVE-TILE | **live** (equities, indices, gold/silver/copper/crude/platinum, FX aliases; bad-key fallback matrix) |
| get_ticker_tape | Yahoo light quotes (Stooq fallback) | TickerTape | LIVE-TILE | **live** |
| get_market_sentiment | CNN Fear&Greed + alternative.me | MarketSentiment gauges | LIVE-TILE | **live** |
| get_yield_curve | US Treasury par-yield XML | YieldCurveCard | LIVE-TILE | **live** (was ~19s vs 20s timeout → parallel + 30min cache) |
| crypto_price | CoinGecko (key optional; auto-fallback keyless; majors skip /search; 60s cache) | MarketCard | LIVE-TILE | **live** (incl. misconfigured-key fallback) |
| get_funding_rates | Binance USD-M public | DataTable | LIVE-TILE | **live** |
| get_stablecoins | DefiLlama | DataTable | LIVE-TILE | **live** |
| get_cot_positioning | CFTC Socrata | DataTable | LIVE-TILE | **live** |
| get_national_debt | US Treasury FiscalData | DebtClock | LIVE-TILE | **live** |
| get_predictions | Polymarket Gamma | DataTable | LIVE-TILE | unit |
| get_econ_calendar | Finnhub (keyed) / model-supplied | EconCalendar | LIVE-TILE | **live** (keyless = honest empty notice; needs `FINNHUB_API_KEY` for live events) |
| get_earnings_calendar | Finnhub (keyed) / model-supplied | EarningsCountdown | LIVE-TILE | **live** (same caveat) |
| show_macro_tiles | FRED (keyed) / model-supplied | MacroTiles | LIVE-TILE | **live** (keyless = model values + notice; needs `FRED_API_KEY`) |
| exchange_rate | Frankfurter (ECB) | text | LIVE-TILE | **live** |
| convert_currency | Frankfurter (ECB) | CurrencyConverter | LIVE-TILE | unit |
| build_portfolio | Yahoo/Stooq quotes | PortfolioCard | LIVE-TILE | unit |
| build_finance_terminal | Yahoo/Stooq | FinanceTerminal | chat-pin | unit |
| render_central_banks | in-app (model data) | CentralBankWatch | snapshot-pin | unit |

### News / search (4)
| Tool | Source(s) | Rendering | Board | Verified |
|---|---|---|---|---|
| get_news | Google News RSS (links decoded to publisher URLs server-side) | NewsDigest + split reader | LIVE-TILE | **live** (decode verified; extraction limited by publisher bot-walls — `JINA_API_KEY` raises success a lot) |
| web_search | SearXNG → Tavily/Brave/Serper/CSE → DDG/Bing → Wikipedia | text + citations | chat | unit (chain), live (DDG path) |
| image_search | DuckDuckGo | image grid | chat | unit |
| video_search | DuckDuckGo | VideoResults (inline play, PiP) | LIVE-TILE | **live** |

### Places / travel (13)
| Tool | Source(s) | Rendering | Board | Verified |
|---|---|---|---|---|
| find_places | Foursquare (keyed) / OSM Overpass (name/brand/cuisine-aware, mirrored) | PlacesResults + map | LIVE-TILE | **live** ("mezeh" case) |
| show_map | Nominatim + Leaflet | MapArtifactCard | LIVE-TILE | **live** |
| get_directions | FOSSGIS OSRM (drive/bike/foot + alternatives) | DirectionsCard (animated) | LIVE-TILE | **live** |
| get_weather | MET Norway → Open-Meteo | WeatherStation | LIVE-TILE | **live** |
| plan_trip | geocoding + Open-Meteo | ItineraryCard | snapshot-pin | unit |
| get_flight_status | aviationstack (keyed) / model data | FlightStatus | LIVE-TILE | unverified upstream (keyless = model data) |
| render_boarding_pass / world_clocks / packing_list / trip_budget / trip_countdown / cheatsheet / loyalty_wallet | in-app | bespoke cards | snapshot-pin | unit |

### Data & viz, learning, agents, codegen, productivity, media (28)
All in-app/deterministic (no upstream): render_chart, render_table,
render_heatmap, show_metrics, create_dashboard, render_ui, render_live_template,
render_pnl_calendar, analyze_data, convert_data, transform_data, convert_image,
run_python (Pyodide), code_exercise, sql_exercise, generate_quiz/flashcards/
document/bundle, create_learning_path, create_goal_tracker, create_monitor,
create_widget_stack, render_whats_changed, render_code_review, ask_user,
generate_app, run_agent_swarm. Rendering: all have artifact cards + gallery
demos. Board: monitor/stack are LIVE-TILE-adjacent (they loop refreshable
tools); the rest pin as snapshots. Verified: unit (they're pure/local).

### Knowledge, geo, space, food, words, entertainment, dev long tail (~39)
wiki_lookup, search_papers (arXiv), search_books, hacker_news, number_fact;
country_info, zip_lookup, public_holidays, sun_times, world_time, ip_lookup,
find_university; iss_location, people_in_space, space_launches, earthquakes,
nasa_apod; find_recipe, find_cocktail; define_word, word_assoc; anime_info,
pokemon_info, tv_show, trivia_questions, random_joke/advice/fact; github_repo,
fetch_github_pr, npm_package, pypi_package, qr_code, predict_name, render_video,
generate_image, nango_* (3).

- **Rendering gap (known, still open):** most of this tail returns **plain
  text** even where the API gives structured data. This is the single biggest
  remaining widget-gallery integration gap and is tracked in
  `DATA_CONNECTORS.md` as the next milestone.
- Verified: unit for the tested parsers (duckduckgo, metno, news, places,
  convertData, …); the long-tail upstreams are **not** runtime-verified.

### MCP (13 curated + user-added)
Context7, GitHub, Filesystem, Memory, Puppeteer/Fetch-class servers etc. (see
`mcpCatalog.ts`). MCP tool results render as text in chat; they are **not**
integrated into the widget gallery or dashboards. Verified: connection
handshake unit-tested (`mcpClient.test.ts`); individual servers unverified.

## 2. What the platform collects (logs, analytics, metrics)

### Server-side, per upstream call (automatic for every tool above)
- **Provider usage meter** (`lib/providerUsage.ts`): per-provider calls, errors,
  budget-blocks, rolling per-minute + per-day counts vs free-tier budgets.
  In-memory; public snapshot at `GET /api/usage/providers`; per-**account**
  deltas flushed ~60s to Supabase **`provider_usage_log`** (append-only; daily
  rollup view `provider_usage_daily`).
- **Request log** (`requestLogger`): JSON lines per HTTP request — requestId,
  userId (when authed), method, path, status, latency.

### Server-side, money & models
- **`generation_cost_events`** — per-generation cost records (model, tokens, USD).
- **`model_pricing_snapshots`** — daily pricing sync history.
- **Platform allowance** (`platformAllowance.ts`): per-user monthly platform-funded
  model spend vs `PLATFORM_MONTHLY_ALLOWANCE_USD`; users see percent only.
- **Model popularity** (`usageAnalytics.ts`): aggregated per-model usage counts
  feeding the Model Library charts.
- **`user_plan_subscriptions`, `stripe_webhook_events`** — billing state.

### Product telemetry
- **`telemetry_events`** (`POST /api/telemetry/events`, optionalAuth, forgiving):
  client events batched; userId attached when present.
- **`user_feedback`** — explicit feedback submissions.
- **`email_log`** — every transactional/marketing send attempt + opens
  (tracking pixel), unsubscribes; hard monthly caps enforced.
- **`waitlist_signups`, `access_invites`, `notifications`** — growth loops.

### Client-side (localStorage, never leaves the device unless synced)
- **Tool analytics** (`services/toolAnalytics.ts`): per-tool run counts/outcomes
  powering the Tools dashboard.
- **Context log** (`services/contextLog.ts`), debug store, dashboards
  (`ds.dashboards.v1`), widget density/height prefs, shortlists, study progress.
- **Account settings snapshot** (encrypted server-side) syncs keys/settings/memory.

### Studio/ops tables (Supabase, server-only RLS)
`projects`, `studio_projects`, `studio_runs`, `profiles`, `verification_checks`
/`verification_findings`, `ventures`/`venture_checkpoints`, `user_roles`,
`user_api_keys` (encrypted), `mcp_servers`, `product_access`.

## 3. Honest verification ledger (June 2026 sessions)

**Live-verified end to end** (tool → artifact → card): the 14 finance/market
tools marked above, news (incl. Google-News link decoding), places, maps,
directions, weather, videos, article reader fallback chain, tile refresh
without auth, bad-key fallback matrix (Alpaca, CoinGecko).

**Unit-verified only:** the in-app/deterministic pack (pure), search chain
beyond DDG, travel cards, portfolio/terminal builders.

**Not verified at runtime:** the ~39-tool long tail's upstreams, MCP servers
individually, Nango, aviationstack, NASA APOD key path, render_video worker.

**Known integration gaps (the truthful to-do list):**
1. Long-tail tools render text, not cards (biggest gallery gap).
2. MCP results are text-only; no artifact bridge.
3. Dashboards are localStorage-only (no cross-device sync of boards).
4. Article extraction is publisher-limited without `JINA_API_KEY`.
5. Econ/earnings calendars + macro tiles need free keys for live data
   (`FINNHUB_API_KEY`, `FRED_API_KEY`) — honest notices shipped, data absent
   without them.
