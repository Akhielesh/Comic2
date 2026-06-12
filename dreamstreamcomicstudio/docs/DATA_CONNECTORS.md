# Data Connectors Registry

**AI agents: this is the authoritative map of which API serves which topic, its
access/license terms, and how fully its data is rendered. When the user asks
"do we cover topic X?" answer FROM THIS DOC + `toolCatalog.ts`; when a topic is
missing, follow "Adding a connector" below and update this doc in the same PR.**

Machine-readable source of truth: `toolCatalog.ts` (`TOOL_CATALOG` — per-tool
provider/auth/license/rateLimit; `CONNECTOR_KEYS` — key onboarding). This doc adds
the topic→source mapping, utilization status, and operating rules.

## Topic → source map (verified June 2026)

| Topic / field | Primary source | Fallback(s) | Access (env) | Commercial license | Rendering |
|---|---|---|---|---|---|
| Web search | Self-hosted SearXNG | Tavily → Brave → Serper → Google CSE → DDG/Bing scrape → Wikipedia | `SEARXNG_URL`, `TAVILY_API_KEY`, `BRAVE_API_KEY`, `SERPER_API_KEY` | conditional (keyless scrapers best-effort) | text + citations |
| Weather/AQI | MET Norway (free, CC BY) | Open-Meteo (fallback; primary when `OPEN_METEO_API_KEY`/`OPEN_METEO_BASE_URL`) | `MET_USER_AGENT` | attribution ✓ | **rich card** ✓ |
| US equities | Alpaca IEX (keyed) | Yahoo (unofficial) → Stooq | `ALPACA_API_KEY_ID/_SECRET_KEY` | conditional | **rich card** ✓ |
| Indices/FX/commodities | Yahoo (unofficial) | Stooq | — | unofficial | **rich card** ✓ |
| Crypto | CoinGecko (+ demo/pro key) | none legal (exchange-direct feeds PROHIBIT commercial display) | `COINGECKO_API_KEY`, `COINGECKO_API_PLAN` | $35/mo Basic for commercial + attribution | **rich card** ✓ |
| Fiat FX rates | Frankfurter (ECB) | — | — | commercial-ok ✓ | text |
| News | Google News RSS (unofficial; article links decoded to publisher URLs server-side) | — (GDELT is the planned fallback) | — | unofficial — never sole source | **rich card** ✓ + split reader |
| Article reader (extraction) | Direct fetch + heuristic reader | Jina Reader proxy (keyless best-effort; key lifts limits) | `JINA_API_KEY` (optional) | per-publisher; honest open-original fallback | **reader pane** ✓ |
| Places/POI | Foursquare (keyed) | OpenStreetMap Overpass (overpass-api.de → kumi.systems mirror; name/brand/cuisine-aware search) | `FOURSQUARE_API_KEY` | conditional | **rich card** ✓ |
| Geocoding/maps | OSM Nominatim | Open-Meteo geocoder | — | fair-use ✓ | **map** ✓ |
| Directions/routing | FOSSGIS OSRM (drive/bike/foot, alternatives) | — (transit deep-links to Google Maps) | — | fair-use demo server ✓ (budgeted 20/min) | **rich card** ✓ animated routes |
| IP geolocation | IPinfo Lite (keyed) | ip-api.com (NON-commercial — dev only) | `IPINFO_TOKEN` | attribution ✓ | text |
| Knowledge/papers/books | Wikipedia, arXiv, OpenLibrary | — | — | open ✓ | text-only ⚠ |
| Geo/civic (countries, holidays, time, postal) | REST Countries, Nager.Date, Zippopotam | — | — | open ✓ | text-only ⚠ |
| Space/science | Open Notify, Launch Library, USGS | — | — | open ✓ | text-only ⚠ |
| Food, words, entertainment | TheMealDB/CocktailDB, dictionaries, Jikan etc. | — | — | open/fair-use | text-only ⚠ |
| Dev (GitHub, npm, PyPI, QR) | public APIs | — | — | open ✓ | text-only ⚠ |
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

## Rendering coverage (honest status)

Rich artifact cards exist for: weather, markets, crypto, news, places, finance
widgets (ticker tape, sentiment, yield curve, portfolio, calendars), travel
widgets, learning, dataviz, dashboards (52 artifact types total — see
`ARTIFACT_RENDERERS` in `components/chat/artifacts/ChatArtifacts.tsx`).

**Known gap (next milestone): the knowledge, geo, space, food, words,
entertainment and dev tool packs return plain text** even where the API gives
structured data. When upgrading one, follow the artifact pipeline in `CLAUDE.md`
(apiTypes → renderer → gallery demo → tool emission) and the kit primitives.

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
