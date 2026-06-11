# Data Connectors & Source Research Guide

> **Who this is for:** you, while researching/signing up for data providers.
> **What it maps to:** every item names the exact env var and code seam the app
> already has (or that the widget-platform work wires), so when you finish your
> research the integration is "set the env var → widget goes live". Nothing in
> this doc requires code changes on your side.

---

## 1. How a connector plugs into this app (read this once)

Every external data source enters through ONE pattern:

```
server/src/ai/tools/<domain>.ts     ← the fetcher (a ChatTool)
        │  reads envKey('SOME_API_KEY')  — undefined ⇒ degraded mode
        │  on failure/absence: returns an honest `notice` { message, fix }
        ▼
toolCatalog.ts                      ← auth: 'none' | 'optional' | 'required'
        │                              + authEnv: 'SOME_API_KEY' (shows in Tools dashboard)
        ▼
apiTypes.ts REFRESHABLE_TOOLS       ← read-only snapshot tools join this list
        ▼                              → refresh button, /loop monitors, dashboards
client widget                       ← renders model data today, live data when keyed
```

Key properties you can rely on while researching:

- **Keys are environment variables on Railway** (server-side only — never shipped
  to the browser). Set them in the deployment env; no redeploy of code needed
  beyond restart.
- **Everything degrades honestly.** An unset key produces a capability notice in
  chat ("Set FINNHUB_API_KEY to lift…"), not a fake answer.
- **Read-only snapshot tools are loop-able.** Anything on `REFRESHABLE_TOOLS`
  automatically works with widget refresh, `/loop` monitors, and custom
  dashboards. So one good data source powers four surfaces at once.

### How to evaluate any provider (checklist for your research)

1. **Auth model** — key in query/header? OAuth? (OAuth = much more work; avoid
   unless necessary, e.g. Reddit.)
2. **Rate limit on the FREE tier** — per minute and per month. Our refresh
   pattern polls; a 100/month tier (aviationstack) supports ~3 lookups/day.
3. **Server-side friendly** — we call from Node (Railway), so CORS doesn't
   matter, but IP-based limits do (shared egress IPs can be pre-exhausted —
   exactly what happened with keyless GitHub in testing).
4. **License/TOS** — are you allowed to *display* the data in your product?
   (Most market-data free tiers: personal/display ok, redistribution not.)
5. **History depth** — widgets want sparklines: does the API give 30+ points?
6. **Latency & freshness** — delayed 15-min quotes are fine for cards; say so in
   the UI footer.

---

## 2. Already live & keyless — NOTHING for you to do

| Domain | Provider | Powers |
|---|---|---|
| Stocks/indices/commodities/FX quotes | Yahoo Finance → Stooq fallback | `get_stock`, `get_ticker_tape`, `build_portfolio`, finance terminal |
| Crypto | CoinGecko public tier | `crypto_price` |
| Fiat FX + 30-day series | Frankfurter (ECB) | `exchange_rate`, `convert_currency` |
| Weather/AQ/pollen | Open-Meteo | `get_weather`, trip enrichments |
| News | Google News RSS | `get_news`, headlines everywhere |
| Stock sentiment | CNN Fear & Greed | `get_market_sentiment` |
| Crypto sentiment | alternative.me | `get_market_sentiment` |
| US yield curve | Treasury daily par-yield XML | `get_yield_curve` |
| US national debt | Treasury FiscalData (Debt to the Penny) | `get_national_debt` (debt clock) |
| Places/POI | OpenStreetMap/Nominatim | `find_places`, `show_map`, trip geocoding |
| Quakes, ISS, space | USGS, Open Notify, SpaceX | space tools |

**Caveat to watch:** Yahoo and CNN are *unofficial* public endpoints. They work
today and have for years, but they can change without notice. If finance becomes
a paying feature, budget for a real market-data vendor (see §4-A).

---

## 3. Free keys to grab now (≈10 min each) — seams already wired

Set these in the Railway environment; each one upgrades an existing feature the
moment it exists. **No research needed, just sign-up.**

| Env var | Where to get it | What it unlocks | Free tier |
|---|---|---|---|
| `GITHUB_TOKEN` | github.com → Settings → Developer settings → fine-grained PAT (public repos, read-only) | `/code-review` PR fetches: 60/hr → 5,000/hr | free |
| `FRED_API_KEY` | fred.stlouisfed.org/docs/api/api_key.html | **Macro tiles go live** (CPI, unemployment, GDP, Fed funds… real series + sparklines) | free, generous |
| `FINNHUB_API_KEY` | finnhub.io/register | **Earnings calendar goes live**; economic calendar *if your tier includes it* (verify — see §4-B) | 60 calls/min |
| `AVIATIONSTACK_API_KEY` | aviationstack.com (free plan) | **Flight status goes live** (real-time status, delays, gates) | 100 req/month (≈3 lookups/day — fine for personal trips) |
| `FOURSQUARE_API_KEY` | developer.foursquare.com | Place ratings/photos/price on `find_places` | free tier |
| `TAVILY_API_KEY` *or* `BRAVE_API_KEY` | tavily.com / brave.com/search/api | Reliable web search (research + deep-research quality jumps) | both have free tiers |
| `NASA_API_KEY` | api.nasa.gov | APOD limits 30/hr → 1,000/hr | free |

---

## 4. THE RESEARCH LIST — decisions only you can make

These are the source gaps blocking the *rest* of the widget catalog. For each:
candidates, the trade-off, and the question you need to answer. Ordered by
value-per-effort.

### A. Real market-data vendor (the "get serious about finance" decision)
*Unblocks:* market breadth, reliable intraday, options/IV, pre/post quotes,
volatility surface, price ladder.
- **Candidates:** Polygon.io (from $29/mo, excellent API), Finnhub paid,
  Twelve Data, Alpha Vantage (free 25 req/day — too small except prototyping),
  Tiingo, EODHD.
- **Trade-off:** Yahoo-keyless is free but unofficial; a vendor gives you a
  contract, websockets, and breadth/options endpoints.
- **Your questions:** monthly budget? US-only or global? do you want
  websocket streaming (true "live" tickers) or is 60s polling enough?

### B. Economic calendar (the highest-value missing dataset)
*Unblocks:* econ calendar timeline beats/misses, "what's releasing today",
macro-tile release countdowns.
- **Candidates:** Finnhub `/calendar/economic` (**verify whether your free tier
  includes it — it moved between tiers historically**), Trading Economics
  (gold standard, $$), FMP (financialmodelingprep.com, has a free-tier econ
  calendar), EconDB, Marketaux.
- **Your questions:** which provider's free tier actually returns
  actual/forecast/previous + importance ranking? Test with curl before
  committing. The widget seam accepts exactly those fields.

### C. Earnings extras: implied move
*Unblocks:* the "±6% implied move" chip on earnings cards (the calendar itself
is covered by Finnhub in §3).
- **Candidates:** options chains from Tradier (free sandbox), CBOE delayed,
  Polygon options ($). Implied move = ATM straddle price ÷ spot.
- **Your question:** is the chip worth an options-data dependency, or do we let
  the model estimate it with a label saying so?

### D. Central-bank implied path
*Unblocks:* live market-implied rate path on the Central Bank Watch card
(card ships now with model-supplied data).
- **Candidates:** CME FedWatch (no public API — scrape/licensed), Polygon Fed
  futures, FRED has *target* rates (wired) but not implied paths.
- **Honest take:** lowest priority — the model keeps this card useful from news.

### E. Positioning & sentiment extras
- **COT positioning: ✅ BUILT** — `get_cot_positioning` reads the CFTC Socrata
  API (keyless, weekly). Nothing for you to do.
- **Put/call ratio:** CBOE publishes free delayed stats pages/CSVs.
- **AAII sentiment:** weekly, members-only — usually scraped; TOS-check it.
- **WSB/social velocity:** Reddit API (free OAuth app, 100 q/min) or
  apewisdom.io (free unofficial JSON). **Your question:** is social data worth
  an OAuth app + TOS exposure?

### F. Crypto depth
- **Stablecoins (DefiLlama): ✅ BUILT** — `get_stablecoins` (supplies + peg
  deviations, depeg flags). Keyless.
- **Funding rates: ✅ BUILT** — `get_funding_rates` (Binance USD-M public).
  Keyless.
- **BTC ETF flows:** Farside Investors (scrape-only) or SoSoValue. TOS-check.
- **Coinglass** ($) if you want aggregated funding/liquidations in one call.

### G. Prediction markets
- **Polymarket: ✅ BUILT** — `get_predictions` (Gamma API, keyless): top
  markets or a topic search, implied probabilities + volume.
- **Kalshi:** free API with an account (US-regulated) — still open if you want
  US-regulated markets too.

### H. Flights & travel (beyond the basic status now wired)
- **Live aircraft positions** (the moving-plane map): OpenSky Network (free,
  registered = better limits) or adsb.lol (free) — positions only, no schedule;
  pairs with aviationstack schedule data.
- **More flight lookups:** AeroDataBox via RapidAPI (~$10/mo for thousands of
  calls) or FlightAware AeroAPI (per-call pricing, the most reliable).
  **Your question:** how many flight lookups/month do you realistically need?
- **Hotels/reservations inbox:** there is **no public API** for reservations —
  the path is parsing confirmation emails. You already have the Gmail MCP
  connected; the decision is privacy/UX, not sourcing. When you green-light it,
  I build the parser → reservation cards pipeline.
- **Transit/rail:** per-region GTFS feeds (free) or Transitland (free key).
  Pick the cities you care about first.
- **Webcams (the WorldMonitor toy):** Windy Webcams API, free key.

### I. World-intelligence layers (the WorldMonitor map vibe)
- GDELT (free, global news events), ACLED (free key for researchers, conflict
  events), IODA (internet outages, free), NASA FIRMS (fires, free key),
  marine/AIS traffic (paid — aisstream.io has a free websocket tier).
- **Your question:** which 2–3 layers actually matter for your product? Each is
  its own integration.

---

## 5. Env-var wiring reference (current + being added this session)

| Env var | Status | Tool(s) |
|---|---|---|
| `GITHUB_TOKEN` | seam live | `fetch_github_pr` |
| `FOURSQUARE_API_KEY` | seam live | `find_places` |
| `SEARXNG_URL` / `TAVILY_API_KEY` / `BRAVE_API_KEY` | seam live | `web_search` |
| `NASA_API_KEY` | seam live | `nasa_apod` |
| `FRED_API_KEY` | **added this session** | `show_macro_tiles` |
| `FINNHUB_API_KEY` | **added this session** | `get_earnings_calendar`, `get_econ_calendar` |
| `AVIATIONSTACK_API_KEY` | **added this session** | `get_flight_status` |

## 6. Infrastructure decisions (not data, but blocking deeper features)

1. **`REDIS_URL`** (already in your env checklist): required before `/loop`
   monitors can run **server-side** (today they run only while the tab is open).
   Server-side monitors + notifications = the "agent watches markets while
   you sleep" feature. Decision: Railway Redis add-on vs Upstash.
2. **Notification channel** for fired monitors/alerts: email (your worker
   exists), web push, or in-app only. Pick one to start.
3. **Widget state sync:** check-offs (packing, goals) and layouts persist in
   localStorage per device. Syncing them needs a small Supabase table — say the
   word and I'll add the schema + sync layer.

---

## TL;DR — your shopping list, in order

1. Grab the §3 free keys (GITHUB, FRED, FINNHUB, AVIATIONSTACK, FOURSQUARE,
   TAVILY) — ~1 hour total, several widgets go live instantly.
2. Decide §4-A: pay for a market-data vendor or stay on keyless Yahoo.
3. Test §4-B econ-calendar candidates with curl; pick whichever free tier
   actually returns actual/forecast/previous.
4. Answer the flights question (§4-H): lookups/month → pick provider tier.
5. ~~Tell me which "no-signup, just build it" items to schedule~~ — **done:**
   CFTC COT, DefiLlama stablecoins, Polymarket and funding rates are all built
   and live (keyless). Still open from this bucket: Gmail reservation parsing
   (your privacy call) and Windy webcams.
6. Decide Redis + notifications (§6) when you want server-side monitors.
