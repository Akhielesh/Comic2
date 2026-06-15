// Shared tool catalogue — the single source of truth for every live tool the AI
// chat agent can call. Imported by BOTH the client (settings dashboard, connector
// chips, smart auto-routing) and the server (relevance narrowing before the model
// sees the toolset). Framework-agnostic: no React, no Node — just data + helpers.
//
// Honesty note: `rateLimit` values are the documented/observed free-tier limits of
// each upstream provider as of integration; they are advisory, not enforced by us.
// `auth` reflects what the tool needs to run: 'none' works out of the box, 'optional'
// runs keyless but a configured env key lifts limits, 'required' needs a key.

export type ToolKind = 'api' | 'mcp' | 'builtin';

export type ToolCategory =
  | 'search'
  | 'news'
  | 'weather'
  | 'finance'
  | 'places'
  | 'travel'
  | 'knowledge'
  | 'words'
  | 'geo'
  | 'space'
  | 'food'
  | 'entertainment'
  | 'dev'
  | 'dataviz'
  | 'codegen'
  | 'learning'
  | 'productivity'
  | 'media'
  | 'agents';

export type ToolAuth = 'none' | 'optional' | 'required';

/**
 * Commercial-use licensing posture of a tool's PRIMARY data source (verified against
 * provider terms, June 2026 audit):
 *   'commercial-ok' — free for commercial use, no strings (e.g. government/public data).
 *   'attribution'   — free for commercial use with required visible credit (CC BY etc.).
 *   'conditional'   — free tier is personal/non-commercial; a key or paid plan unlocks
 *                     commercial rights (the tool degrades honestly until configured).
 *   'unofficial'    — unofficial/scrape endpoint with no license to rely on; never the
 *                     sole source for anything compliance-critical.
 */
export type ToolLicense = 'commercial-ok' | 'attribution' | 'conditional' | 'unofficial';

export const LICENSE_META: Record<ToolLicense, { label: string; blurb: string }> = {
  'commercial-ok': { label: 'COMMERCIAL OK', blurb: 'Free for commercial use, verified.' },
  attribution: { label: 'ATTRIBUTION', blurb: 'Free for commercial use with visible credit.' },
  conditional: { label: 'KEY FOR COMMERCIAL', blurb: 'Free tier is personal-use; a key/plan unlocks commercial rights.' },
  unofficial: { label: 'UNOFFICIAL', blurb: 'Unofficial endpoint — best-effort, no license guarantee.' }
};

export interface ToolMeta {
  /** Tool name the model and client reference (matches the server registry). */
  name: string;
  /** Human label for UI. */
  label: string;
  category: ToolCategory;
  /** API = direct REST call, MCP = Model Context Protocol server, builtin = first-party. */
  kind: ToolKind;
  /** Upstream data provider. */
  provider: string;
  /** What the tool does and when to use it (mirrors the model-facing description). */
  description: string;
  auth: ToolAuth;
  /** Env var that unlocks/raises limits, when auth is optional/required. */
  authEnv?: string;
  /** Documented/observed free-tier rate limit (honest, advisory). */
  rateLimit: string;
  /** The shape of data the tool returns to the model. */
  dataShape: string;
  /** Provider docs / homepage. */
  docsUrl: string;
  /** Routing keywords used by the smart selector to decide relevance. */
  keywords: string[];
  /** Commercial-use posture of the primary source (set on audited connectors). */
  license?: ToolLicense;
  /** One-line licensing/fallback note shown in the dashboard. */
  licenseNote?: string;
}

export interface CategoryMeta {
  id: ToolCategory;
  label: string;
  /** lucide-react icon name (resolved in the UI). */
  icon: string;
  blurb: string;
}

export const CATEGORY_META: CategoryMeta[] = [
  { id: 'search', label: 'Web & media search', icon: 'Search', blurb: 'Live web, image and video search.' },
  { id: 'news', label: 'News', icon: 'Newspaper', blurb: 'Real headlines by topic and region.' },
  { id: 'weather', label: 'Weather', icon: 'CloudSun', blurb: 'Current conditions and forecasts.' },
  { id: 'finance', label: 'Finance & markets', icon: 'LineChart', blurb: 'Stocks, crypto and currency rates.' },
  { id: 'places', label: 'Places & maps', icon: 'MapPin', blurb: 'Nearby places, geocoding and maps.' },
  { id: 'travel', label: 'Travel widgets', icon: 'Plane', blurb: 'Boarding passes, countdowns, packing lists, world clocks.' },
  { id: 'knowledge', label: 'Knowledge & reference', icon: 'BookOpen', blurb: 'Encyclopedia, books, papers, tech news.' },
  { id: 'words', label: 'Words & language', icon: 'Type', blurb: 'Definitions and word associations.' },
  { id: 'geo', label: 'Geography & civic', icon: 'Globe', blurb: 'Countries, holidays, time, postal, IP.' },
  { id: 'space', label: 'Space & science', icon: 'Rocket', blurb: 'ISS, launches, earthquakes, astronomy.' },
  { id: 'food', label: 'Food & drink', icon: 'UtensilsCrossed', blurb: 'Recipes and cocktail mixing.' },
  { id: 'entertainment', label: 'Entertainment & fun', icon: 'Gamepad2', blurb: 'TV, anime, games, trivia, jokes.' },
  { id: 'dev', label: 'Developer & utility', icon: 'Code2', blurb: 'GitHub, packages, QR codes, demographics.' },
  { id: 'dataviz', label: 'Data & charts', icon: 'BarChart3', blurb: 'Turn data into charts and KPI boards.' },
  { id: 'media', label: 'Media & images', icon: 'Image', blurb: 'Convert and resize images (deterministic, non-AI).' },
  { id: 'codegen', label: 'App builder', icon: 'AppWindow', blurb: 'Generate full multi-file apps with a live preview.' },
  { id: 'learning', label: 'Learning', icon: 'GraduationCap', blurb: 'Interactive quizzes and practice for studying any topic.' },
  { id: 'productivity', label: 'Goals & monitors', icon: 'Target', blurb: 'Goal trackers, live monitors, what-changed briefs.' },
  { id: 'agents', label: 'Agents', icon: 'Network', blurb: 'Delegate complex tasks to a swarm.' }
];

export const TOOL_CATALOG: ToolMeta[] = [
  // ---------------------------------------------------------------- search ------
  {
    name: 'web_search', label: 'Web search', category: 'search', kind: 'builtin', provider: 'SearXNG → DuckDuckGo → Bing → Wikipedia (free, keyless) · Tavily/Brave/Serper/Google if keyed',
    description: 'Search the live web for current, factual or post-training information with ranked results and citations.',
    auth: 'optional', authEnv: 'SEARXNG_URL', rateLimit: 'Free keyless sources by default (open-source SearXNG + scrapers); self-host SearXNG via SEARXNG_URL, or add a TAVILY_API_KEY (1k free/mo) / BRAVE_API_KEY ($5 credit ≈ 1k/mo) / SERPER_API_KEY, for higher reliability',
    license: 'conditional', licenseNote: 'Keyless scrapers are best-effort and block-prone from datacenter IPs; production should run a self-hosted SearXNG plus one keyed, non-scraping provider (Tavily/Brave).',
    dataShape: 'Ranked results: title, URL, snippet + citations.', docsUrl: 'https://duckduckgo.com',
    // Deliberately distinctive keywords only — web_search is also a guaranteed
    // backstop in routing/fallback, so it shouldn't win ties on generic words.
    keywords: ['search the web', 'web search', 'look up', 'google', 'search for', 'find online', 'browse', 'website']
  },
  {
    name: 'image_search', label: 'Image search', category: 'search', kind: 'builtin', provider: 'DuckDuckGo',
    description: 'Find images/photos/pictures of something on the web.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Image results: URL, title, thumbnail.', docsUrl: 'https://duckduckgo.com',
    keywords: ['image', 'photo', 'picture', 'pic', 'show me', 'what does', 'look like']
  },
  {
    name: 'video_search', label: 'Video search', category: 'search', kind: 'builtin', provider: 'DuckDuckGo',
    description: 'Find videos, tutorials, how-tos, reviews and clips.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Video cards: title, publisher, URL (plays inline).', docsUrl: 'https://duckduckgo.com',
    keywords: ['video', 'youtube', 'watch', 'tutorial', 'how to', 'clip', 'trailer']
  },
  // ----------------------------------------------------------------- news -------
  {
    name: 'get_news', label: 'News', category: 'news', kind: 'builtin', provider: 'Google News RSS',
    description: 'Latest news headlines from real outlets by topic or region.',
    auth: 'none', rateLimit: 'Fair use (public RSS)',
    license: 'unofficial', licenseNote: 'Unofficial public RSS — fine as a headline pointer (links go to the outlets), but never the sole source for a paid feature.',
    dataShape: 'News card: dated, sourced headlines + citations.', docsUrl: 'https://news.google.com',
    keywords: ['news', 'headline', 'breaking', 'happening', 'latest on', 'updates', 'press']
  },
  // ---------------------------------------------------------------- weather -----
  {
    name: 'get_weather', label: 'Weather', category: 'weather', kind: 'builtin', provider: 'MET Norway (primary) → Open-Meteo (fallback / when keyed)',
    description: 'Current weather, forecast, UV and air quality for a place.',
    auth: 'optional', authEnv: 'OPEN_METEO_API_KEY', rateLimit: 'MET Norway ~20 req/s fair use (keyless); Open-Meteo free tier is non-commercial — set OPEN_METEO_API_KEY or OPEN_METEO_BASE_URL (self-host) to make it primary',
    license: 'attribution', licenseNote: 'MET Norway is free for commercial use (CC BY 4.0, credit shown as a citation). Open-Meteo runs only as uptime fallback unless a paid key / self-hosted instance is configured.',
    dataShape: 'Weather card: temp, conditions, 5-day forecast.', docsUrl: 'https://api.met.no',
    keywords: ['weather', 'temperature', 'forecast', 'rain', 'snow', 'humidity', 'wind', 'uv', 'air quality', 'hot', 'cold']
  },
  // ---------------------------------------------------------------- finance -----
  {
    name: 'get_stock', label: 'Markets (stocks, commodities, FX)', category: 'finance', kind: 'builtin', provider: 'Alpaca IEX (US equities, if keyed) → Yahoo Finance → Stooq',
    description: 'Live quote for stocks, ETFs, indices, commodities (gold, oil, metals), FX pairs and crypto — with an intraday→multi-year range timeline, 52-week range, stats, peers and headlines.',
    auth: 'optional', authEnv: 'ALPACA_API_KEY_ID', rateLimit: 'Alpaca free Basic: ~200 req/min (IEX feed); keyless Yahoo/Stooq: fair use',
    license: 'conditional', licenseNote: 'Set free Alpaca keys to serve US equity prices from a licensed IEX feed; keyless Yahoo/Stooq are unofficial endpoints (indices/commodities/FX stay on them).',
    dataShape: 'Rich market card: price, range timeline, 52-wk, peers, news.', docsUrl: 'https://finance.yahoo.com',
    keywords: ['stock', 'share', 'ticker', 'nasdaq', 's&p', 'dow', 'index', 'equity', 'market', 'gold', 'silver', 'platinum', 'copper', 'oil', 'crude', 'brent', 'commodity', 'commodities', 'metals', 'natural gas', 'futures']
  },
  {
    name: 'crypto_price', label: 'Crypto prices', category: 'finance', kind: 'api', provider: 'CoinGecko',
    description: 'Current price, market cap and 24h change of a cryptocurrency.',
    auth: 'optional', authEnv: 'COINGECKO_API_KEY', rateLimit: '~10-30 calls/min keyless · 10k calls/mo with a free Demo key · 100k credits/mo on Basic ($35/mo)',
    license: 'conditional', licenseNote: 'Keyless/Demo tiers are non-commercial; commercial display rights start at CoinGecko Basic ($35/mo) and require the "Data provided by CoinGecko" credit (always attached). Exchange-direct "free" feeds (Binance/Coinbase) prohibit commercial display — not a legal fallback.',
    dataShape: 'Interactive price card (chart) + 24h %, market cap, rank.', docsUrl: 'https://www.coingecko.com/en/api',
    keywords: ['crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'coin', 'token', 'solana', 'dogecoin', 'altcoin']
  },
  {
    name: 'exchange_rate', label: 'Currency exchange', category: 'finance', kind: 'api', provider: 'Frankfurter (ECB)',
    description: 'Convert between fiat currencies using official ECB reference rates.',
    auth: 'none', rateLimit: 'Unlimited fair use (no key)',
    license: 'commercial-ok', licenseNote: 'Open-source service over official ECB reference rates (public data).',
    dataShape: 'Text: converted amount(s) + rate date.', docsUrl: 'https://www.frankfurter.app',
    keywords: ['currency', 'exchange', 'convert', 'usd', 'eur', 'gbp', 'forex', 'rate', 'money']
  },
  {
    name: 'build_finance_terminal', label: 'Finance terminal', category: 'finance', kind: 'builtin', provider: 'DreamStream (Yahoo/Stooq)',
    description: 'Assemble a live finance terminal — focus quote, index/KPI ribbon, watchlist table, sector heatmap and news — for a dashboard/overview of multiple tickers at once.',
    auth: 'none', rateLimit: 'Fair use (keyless quotes)',
    dataShape: 'Composite terminal: quote + KPIs + table + heatmap + news.', docsUrl: 'https://dreamstream.app',
    keywords: ['terminal', 'dashboard', 'watchlist', 'portfolio', 'markets today', 'market overview', 'track stocks', 'movers', 'indices', 'my stocks', 'finance dashboard']
  },
  {
    name: 'get_ticker_tape', label: 'Ticker tape', category: 'finance', kind: 'builtin', provider: 'Yahoo Finance (Stooq fallback)',
    description: 'A live scrolling market strip — price, day change and sparkline for a set of symbols (or a default market tape). The at-a-glance companion to the full quote card.',
    auth: 'none', rateLimit: 'Fair use (keyless quotes)',
    dataShape: 'Marquee strip + rows: symbol, price, Δ%, sparkline.', docsUrl: 'https://finance.yahoo.com',
    keywords: ['ticker tape', 'ticker', 'tape', 'market strip', 'watchlist strip', 'tickers', 'prices at a glance', 'marquee', 'how are markets']
  },
  {
    name: 'compare_stocks', label: 'Compare assets', category: 'finance', kind: 'builtin', provider: 'Yahoo Finance (Stooq fallback)',
    description: 'Overlay 2–6 assets (stocks, ETFs, indices, commodities, FX, crypto) on ONE interactive chart to compare TRENDS — % change rebased to the window start (the right way to compare different price scales, e.g. gold vs oil vs the S&P) or absolute price, with 1D…MAX range tabs and a legend that toggles each line. The go-to for "compare X vs Y", "X vs Y vs Z" and "how have gold, oil and the S&P moved".',
    auth: 'none', rateLimit: 'Fair use (keyless quotes)',
    dataShape: 'One overlay chart: rebased %/price lines + range tabs + legend toggle.', docsUrl: 'https://finance.yahoo.com',
    keywords: ['compare', 'comparison', 'versus', 'vs', 'overlay', 'relative performance', 'against', 'gold vs oil', 'trend comparison', 'outperform', 'correlation']
  },
  {
    name: 'get_market_sentiment', label: 'Fear & Greed', category: 'finance', kind: 'api', provider: 'CNN Fear & Greed · alternative.me',
    description: 'Live Fear & Greed sentiment gauges for stocks (CNN, with component indicators) and crypto (alternative.me), with history.',
    auth: 'none', rateLimit: 'Fair use (public endpoints)',
    dataShape: 'Animated 0–100 gauges + history sparkline + components.', docsUrl: 'https://www.cnn.com/markets/fear-and-greed',
    keywords: ['fear and greed', 'fear & greed', 'sentiment', 'market mood', 'greedy', 'fearful', 'risk appetite', 'market sentiment']
  },
  {
    name: 'get_yield_curve', label: 'Yield curve', category: 'finance', kind: 'api', provider: 'US Treasury',
    description: 'The live US Treasury par yield curve (1M–30Y) with 1-month / 1-year-ago comparison snapshots, the 10Y−2Y spread and an inversion flag.',
    auth: 'none', rateLimit: 'Fair use (public XML feed)',
    dataShape: 'Morphing curve chart + spread + inversion badge.', docsUrl: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates',
    keywords: ['yield curve', 'treasury yields', 'inversion', 'inverted curve', '10 year', '2 year', 'bond yields', 'rates curve', 'recession signal']
  },
  {
    name: 'build_portfolio', label: 'Portfolio (live-priced)', category: 'finance', kind: 'builtin', provider: 'DreamStream (Yahoo/Stooq quotes)',
    description: 'Turn listed holdings into a live-priced portfolio card — the server quotes every position and computes value, day P&L, total P&L and allocation weights.',
    auth: 'none', rateLimit: 'Fair use (keyless quotes)',
    dataShape: 'Portfolio hero: totals, allocation donut, holdings table.', docsUrl: 'https://dreamstream.app',
    keywords: ['portfolio', 'holdings', 'positions', 'i own', 'my stocks', 'allocation', 'p&l', 'pnl', 'gains', 'cost basis', 'net worth']
  },
  {
    name: 'convert_currency', label: 'Currency converter (widget)', category: 'finance', kind: 'api', provider: 'Frankfurter (ECB)',
    description: 'An interactive live currency converter card — current ECB rate, editable amount, 30-day trend and a "vs 30-day average" verdict.',
    auth: 'none', rateLimit: 'Unlimited fair use (no key)',
    dataShape: 'Converter card: rate, amount ⇄, 30-day sparkline, verdict.', docsUrl: 'https://www.frankfurter.app',
    keywords: ['convert currency', 'currency converter', 'exchange rate widget', 'good time to exchange', 'fx trend', 'money for trip', 'convert money']
  },
  {
    name: 'show_macro_tiles', label: 'Macro indicator tiles', category: 'finance', kind: 'builtin', provider: 'DreamStream (+ FRED when keyed)',
    description: 'A wall of macro indicator tiles (CPI, unemployment, GDP, Fed funds…) with change, sparkline and next-release countdown. Tiles with a FRED series id fill live when a key is set.',
    auth: 'optional', authEnv: 'FRED_API_KEY', rateLimit: 'FRED free tier is generous (120 req/min)',
    dataShape: 'Tile wall: value + delta + spark + release countdown.', docsUrl: 'https://fred.stlouisfed.org/docs/api/fred/',
    keywords: ['macro', 'cpi', 'inflation', 'unemployment', 'gdp', 'economy', 'economic indicators', 'fed funds', 'jobs report', 'pmi', 'macro dashboard']
  },
  {
    name: 'get_econ_calendar', label: 'Economic calendar', category: 'finance', kind: 'builtin', provider: 'DreamStream (+ Finnhub when keyed)',
    description: 'The week\'s economic releases on a timeline — importance dots, beat/miss coloring for past events, a "now" line. Live with a Finnhub key (tier-dependent); model-supplied otherwise.',
    auth: 'optional', authEnv: 'FINNHUB_API_KEY', rateLimit: 'Finnhub free: 60 calls/min (verify econ-calendar tier)',
    dataShape: 'Timeline strip + day-grouped event rows with actual/forecast/previous.', docsUrl: 'https://finnhub.io/docs/api/economic-calendar',
    keywords: ['economic calendar', 'econ calendar', 'fomc', 'nfp', 'cpi release', 'data this week', 'releases', 'economic events', 'jobs friday']
  },
  {
    name: 'get_earnings_calendar', label: 'Earnings countdown', category: 'finance', kind: 'builtin', provider: 'DreamStream (+ Finnhub when keyed)',
    description: 'Upcoming earnings as a countdown carousel — report date, before/after the bell, EPS estimates, implied move and an agent preview per company. Live dates with a Finnhub key.',
    auth: 'optional', authEnv: 'FINNHUB_API_KEY', rateLimit: 'Finnhub free: 60 calls/min',
    dataShape: 'Carousel cards: countdown, session, EPS est, implied move, preview.', docsUrl: 'https://finnhub.io/docs/api/earnings-calendar',
    keywords: ['earnings', 'earnings calendar', 'who reports', 'earnings this week', 'reports after close', 'eps estimate', 'earnings season', 'implied move']
  },
  {
    name: 'get_national_debt', label: 'National debt clock', category: 'finance', kind: 'api', provider: 'US Treasury FiscalData',
    description: 'The live US national debt as a running odometer, ticking per second from the recent drift ("Debt to the Penny", keyless).',
    auth: 'none', rateLimit: 'Fair use (public API)',
    dataShape: 'Odometer: live amount + $/second drift + Δ since previous record.', docsUrl: 'https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/',
    keywords: ['national debt', 'debt clock', 'us debt', 'deficit', 'debt to the penny', 'how much debt']
  },
  {
    name: 'render_central_banks', label: 'Central bank watch', category: 'finance', kind: 'builtin', provider: 'DreamStream (in-app)',
    description: 'A card per central bank (Fed, ECB, BoJ…) — current policy rate, days to the next meeting, market-implied path and the latest communication read.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Bank rows: rate, meeting countdown, implied-path mini chart.', docsUrl: 'https://dreamstream.app',
    keywords: ['fed', 'central bank', 'ecb', 'boj', 'rate decision', 'fomc meeting', 'interest rate', 'rate cut', 'rate hike', 'monetary policy', 'when does the fed meet']
  },
  {
    name: 'get_predictions', label: 'Prediction markets', category: 'finance', kind: 'api', provider: 'Polymarket (Gamma API)',
    description: 'Live prediction-market odds — top open markets (or a searched topic) with implied probability, 24h volume and close date.',
    auth: 'none', rateLimit: 'Fair use (public API)',
    dataShape: 'Sortable table: market, yes %, volume, close date.', docsUrl: 'https://docs.polymarket.com',
    keywords: ['odds', 'prediction market', 'polymarket', 'probability of', 'will x happen', 'election odds', 'betting markets', 'implied probability']
  },
  {
    name: 'get_funding_rates', label: 'Perp funding rates', category: 'finance', kind: 'api', provider: 'Binance USD-M (public)',
    description: 'Live crypto perpetual funding rates — 8h rate, annualized equivalent and mark price; positive = crowded long.',
    auth: 'none', rateLimit: 'Binance public limits (generous)',
    dataShape: 'Table: contract, 8h rate, annualized, mark, next funding.', docsUrl: 'https://binance-docs.github.io/apidocs/futures/en/',
    keywords: ['funding rate', 'funding', 'perp', 'perpetual', 'crowded long', 'crypto positioning', 'overheated', 'basis']
  },
  {
    name: 'get_stablecoins', label: 'Stablecoin board', category: 'finance', kind: 'api', provider: 'DefiLlama',
    description: 'Live stablecoin supplies, prices and peg deviation in bps for the largest USD stablecoins; depegs over 30 bps flagged.',
    auth: 'none', rateLimit: 'Fair use (public API)',
    dataShape: 'Table: coin, supply, price, peg Δ bps, mechanism.', docsUrl: 'https://defillama.com/docs/api',
    keywords: ['stablecoin', 'usdt', 'usdc', 'dai', 'depeg', 'peg', 'tether', 'stablecoin supply']
  },
  {
    name: 'get_cot_positioning', label: 'COT positioning', category: 'finance', kind: 'api', provider: 'CFTC (Socrata public API)',
    description: 'Weekly Commitments of Traders speculative positioning — non-commercial net longs and weekly change for major futures (gold, oil, S&P, FX, rates, BTC).',
    auth: 'none', rateLimit: 'Fair use (public API; weekly data)',
    dataShape: 'Table: market, net spec, Δ week, long/short, open interest.', docsUrl: 'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm',
    keywords: ['cot', 'commitments of traders', 'positioning', 'net longs', 'speculators', 'cftc', 'crowded trade', 'futures positioning']
  },
  // ----------------------------------------------------------------- places -----
  {
    name: 'find_places', label: 'Places / local', category: 'places', kind: 'builtin', provider: 'OpenStreetMap / Foursquare',
    description: 'Find nearby restaurants, cafes, hotels, shops and POIs with distance, hours and a map.',
    auth: 'optional', authEnv: 'FOURSQUARE_API_KEY', rateLimit: 'OSM fair use; Foursquare lifts ratings/photos',
    dataShape: 'Local card: name, distance, hours, website + map.', docsUrl: 'https://www.openstreetmap.org',
    keywords: ['restaurant', 'food', 'eat', 'cafe', 'coffee', 'bar', 'hotel', 'pharmacy', 'atm', 'shop', 'near me', 'nearby', 'places']
  },
  {
    name: 'show_map', label: 'Maps', category: 'places', kind: 'builtin', provider: 'OpenStreetMap (Leaflet)',
    description: 'Show an interactive map with markers and optional routes.',
    auth: 'none', rateLimit: 'Nominatim ~1 req/s geocoding',
    dataShape: 'Interactive map artifact with markers/route.', docsUrl: 'https://leafletjs.com',
    keywords: ['map', 'where is', 'directions', 'route', 'navigate', 'located', 'location of']
  },
  {
    name: 'get_directions', label: 'Directions', category: 'places', kind: 'builtin', provider: 'FOSSGIS OSRM (OpenStreetMap)',
    description: 'Real drive/walk/bike routes between two places with ETAs, distances and alternatives, on an animated map with a transport-mode toggle. Transit deep-links to Google Maps.',
    auth: 'none', rateLimit: 'FOSSGIS demo server fair use (budgeted 20/min)',
    dataShape: 'Directions card: mode pills, ETA/distance, animated route + alternatives.', docsUrl: 'https://routing.openstreetmap.de/about.html',
    keywords: ['directions', 'route', 'how do i get to', 'travel time', 'drive time', 'commute', 'walk', 'bike', 'eta', 'navigation']
  },
  // ----------------------------------------------------------------- travel -----
  {
    name: 'render_boarding_pass', label: 'Boarding pass', category: 'travel', kind: 'builtin', provider: 'DreamStream (in-app)',
    description: 'A wallet-style boarding pass card — route, gate/seat/group, status glow, QR code, and a flip side with fare class, baggage and tips.',
    auth: 'none', rateLimit: 'Unlimited (renders locally; QR via goqr.me)',
    dataShape: 'Flip card: pass front + details back, status-tinted.', docsUrl: 'https://dreamstream.app',
    keywords: ['boarding pass', 'flight', 'my flight', 'gate', 'seat', 'departure', 'check in', 'flight details', 'plane ticket']
  },
  {
    name: 'render_world_clocks', label: 'World clocks', category: 'travel', kind: 'builtin', provider: 'DreamStream (in-app, Intl)',
    description: 'Live ticking clocks for several places with day/night + sleep shading and a "good time to call home?" indicator for two zones.',
    auth: 'none', rateLimit: 'Unlimited (ticks locally, no API)',
    dataShape: 'Analog + digital clocks per zone, call-window hint.', docsUrl: 'https://dreamstream.app',
    keywords: ['world clock', 'time zones', 'timezone twins', 'time at home', 'call home', 'what time is it there', 'jet lag', 'time difference clock']
  },
  {
    name: 'render_packing_list', label: 'Packing list', category: 'travel', kind: 'builtin', provider: 'DreamStream (in-app, progress saved locally)',
    description: 'An interactive packing checklist generated from the trip (weather, length, activities) — grouped items the user checks off, progress persists.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Grouped checklist + progress ring + tips.', docsUrl: 'https://dreamstream.app',
    keywords: ['packing list', 'what to pack', 'pack for', 'suitcase', 'luggage list', 'packing checklist', 'travel checklist']
  },
  {
    name: 'render_trip_countdown', label: 'Trip countdown', category: 'travel', kind: 'builtin', provider: 'DreamStream + Open-Meteo weather',
    description: 'A live ticking countdown to departure with destination, a live destination weather strip and a prep checklist.',
    auth: 'none', rateLimit: 'Weather fair use (Open-Meteo, keyless)',
    dataShape: 'Countdown hero: D/H/M/S, weather strip, checklist.', docsUrl: 'https://dreamstream.app',
    keywords: ['countdown', 'days until', 'how long until my trip', 'trip countdown', 'departure countdown', 'days to go', 'upcoming trip']
  },
  {
    name: 'get_flight_status', label: 'Flight tracker', category: 'travel', kind: 'builtin', provider: 'DreamStream (+ aviationstack when keyed)',
    description: 'Track a flight — status, delays, terminal/gate and a route-progress arc. Live with an aviationstack key; renders the known schedule otherwise.',
    auth: 'optional', authEnv: 'AVIATIONSTACK_API_KEY', rateLimit: 'aviationstack free: 100 req/month',
    dataShape: 'Tracker card: route arc with plane position, times, delays, gates.', docsUrl: 'https://aviationstack.com/documentation',
    keywords: ['flight status', 'track flight', 'is my flight on time', 'flight delayed', 'where is flight', 'arrival time', 'departure status', 'flight tracker']
  },
  {
    name: 'render_trip_budget', label: 'Trip budget burn', category: 'travel', kind: 'builtin', provider: 'DreamStream (in-app)',
    description: 'A budget fuel-gauge for a trip — spent vs total with banded warning zones, per-category bars, and a pace verdict computed from the trip dates.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Fuel gauge + category bars + "exceed by day N" pace verdict.', docsUrl: 'https://dreamstream.app',
    keywords: ['trip budget', 'travel budget', 'am i on budget', 'spending on trip', 'budget burn', 'overspend', 'travel expenses', 'vacation budget']
  },
  {
    name: 'render_cheatsheet', label: 'Destination cheat-sheet', category: 'travel', kind: 'builtin', provider: 'DreamStream (in-app)',
    description: 'A per-city survival card — emergency numbers, tipping, plug type & voltage, cash norms, tap water, key phrases with pronunciation, scam warnings, etiquette.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Facts grid + phrases + warnings + etiquette.', docsUrl: 'https://dreamstream.app',
    keywords: ['cheat sheet', 'what should i know about', 'emergency number', 'tipping in', 'plug type', 'local customs', 'phrases', 'scams in', 'travel tips for']
  },
  {
    name: 'render_loyalty_wallet', label: 'Loyalty wallet', category: 'travel', kind: 'builtin', provider: 'DreamStream (in-app)',
    description: 'Stacked airline/hotel membership cards — points balances, tier progress to the next status, expiries and the agent\'s best redemption suggestion.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Stacked brand cards: points, tier progress, redemption tip.', docsUrl: 'https://dreamstream.app',
    keywords: ['loyalty', 'miles', 'points balance', 'frequent flyer', 'hotel points', 'status tier', 'redeem points', 'membership', 'rewards']
  },
  // -------------------------------------------------------------- knowledge -----
  {
    name: 'wiki_lookup', label: 'Wikipedia', category: 'knowledge', kind: 'api', provider: 'Wikipedia REST',
    description: 'Encyclopedic summary of a topic, person, place, event or concept.',
    auth: 'none', rateLimit: '~200 req/s per IP (no key)',
    dataShape: 'Document card: image, extract + source link (downloadable).', docsUrl: 'https://www.mediawiki.org/wiki/API:REST_API',
    keywords: ['wikipedia', 'who is', 'what is', 'history of', 'about', 'encyclopedia', 'biography', 'background']
  },
  {
    name: 'search_books', label: 'Books', category: 'knowledge', kind: 'api', provider: 'Open Library',
    description: 'Search books by title, author or subject with covers and links.',
    auth: 'none', rateLimit: 'Fair use (~100/min suggested)',
    dataShape: 'Document card: linked reading list (title, author, year) + covers.', docsUrl: 'https://openlibrary.org/developers/api',
    keywords: ['book', 'books', 'author', 'novel', 'read', 'reading', 'isbn', 'publication']
  },
  {
    name: 'search_papers', label: 'Research papers', category: 'knowledge', kind: 'api', provider: 'arXiv',
    description: 'Search academic/research papers across sciences with abstracts.',
    auth: 'none', rateLimit: '1 request / 3s suggested',
    dataShape: 'Document card: linked papers with authors + abstracts.', docsUrl: 'https://info.arxiv.org/help/api',
    keywords: ['paper', 'papers', 'research', 'arxiv', 'study', 'academic', 'scientific', 'preprint', 'citation']
  },
  {
    name: 'hacker_news', label: 'Hacker News', category: 'knowledge', kind: 'api', provider: 'HN (Algolia)',
    description: 'Tech, startup and programming stories the dev community is discussing.',
    auth: 'none', rateLimit: '~10,000 req/hr (no key)',
    dataShape: 'News card (split reader): stories with points/comments.', docsUrl: 'https://hn.algolia.com/api',
    keywords: ['hacker news', 'hn', 'tech news', 'startup', 'show hn', 'developer community', 'trending tech']
  },
  {
    name: 'number_fact', label: 'Number facts', category: 'knowledge', kind: 'api', provider: 'Numbers API',
    description: 'Interesting fact about a number, math property, year or date.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Text: a single fact.', docsUrl: 'http://numbersapi.com',
    keywords: ['number fact', 'fact about', 'math fact', 'this day', 'year', 'date fact', 'trivia number']
  },
  // ----------------------------------------------------------------- words ------
  {
    name: 'define_word', label: 'Dictionary', category: 'words', kind: 'api', provider: 'Free Dictionary',
    description: 'Definitions, part of speech, examples, phonetics and synonyms of a word.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Document card: phonetics, senses, examples, synonyms.', docsUrl: 'https://dictionaryapi.dev',
    keywords: ['define', 'definition', 'meaning', 'what does', 'mean', 'dictionary', 'pronounce', 'spelling']
  },
  {
    name: 'word_assoc', label: 'Word associations', category: 'words', kind: 'api', provider: 'Datamuse',
    description: 'Synonyms, antonyms, rhymes and related words for brainstorming and writing.',
    auth: 'none', rateLimit: '100,000 req/day (no key)',
    dataShape: 'Text: list of associated words.', docsUrl: 'https://www.datamuse.com/api',
    keywords: ['synonym', 'antonym', 'rhyme', 'rhymes with', 'similar word', 'related word', 'thesaurus', 'word for']
  },
  // ------------------------------------------------------------------ geo -------
  {
    name: 'country_info', label: 'Country facts', category: 'geo', kind: 'api', provider: 'REST Countries',
    description: 'Capital, population, languages, currencies, area, timezones and flag of a country.',
    auth: 'none', rateLimit: 'Unlimited fair use (no key) — but see license note',
    license: 'conditional', licenseNote: 'REST Countries deprecated its legacy keyless API in June 2026 (v3.1 now returns an error); the replacement v5 API requires an auth key. Needs a provider migration.',
    dataShape: 'Metric board: population, area, capital, currency… + flag.', docsUrl: 'https://restcountries.com',
    keywords: ['country', 'capital', 'population', 'currency of', 'flag', 'nation', 'demographics']
  },
  {
    name: 'ip_lookup', label: 'IP geolocation', category: 'geo', kind: 'api', provider: 'IPinfo Lite (if keyed) → ip-api.com',
    description: 'Geolocate an IP address or domain — country, network/ISP and (fallback) city and coordinates.',
    auth: 'optional', authEnv: 'IPINFO_TOKEN', rateLimit: 'IPinfo Lite: unlimited (free token) · ip-api fallback: 45 req/min (HTTP, no key)',
    license: 'conditional', licenseNote: 'ip-api.com free tier is non-commercial only — set a free IPINFO_TOKEN (commercial-OK with attribution, country/ASN level) for the compliant primary.',
    dataShape: 'Text: location, ISP, ASN, coordinates.', docsUrl: 'https://ipinfo.io/lite',
    keywords: ['ip', 'ip address', 'geolocate', 'whois', 'server location', 'hostname', 'isp']
  },
  {
    name: 'public_holidays', label: 'Public holidays', category: 'geo', kind: 'api', provider: 'Nager.Date',
    description: 'National/public holidays for a country and year.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Data table: date, holiday, weekday.', docsUrl: 'https://date.nager.at/swagger',
    keywords: ['holiday', 'holidays', 'public holiday', 'bank holiday', 'day off', 'national day']
  },
  {
    name: 'sun_times', label: 'Sunrise / sunset', category: 'geo', kind: 'api', provider: 'sunrise-sunset.org',
    description: 'Sunrise, sunset, solar noon and day length for a place.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Metric board: sunrise, sunset, solar noon, day length.', docsUrl: 'https://sunrise-sunset.org/api',
    keywords: ['sunrise', 'sunset', 'golden hour', 'daylight', 'day length', 'solar noon', 'dawn', 'dusk']
  },
  {
    name: 'world_time', label: 'World time', category: 'geo', kind: 'api', provider: 'Open-Meteo geocoding + Intl',
    description: 'Current local date/time and UTC offset for a place or timezone.',
    auth: 'none', rateLimit: 'Geocoding fair use; time computed locally',
    dataShape: 'Live world-clock card + local time text.', docsUrl: 'https://open-meteo.com',
    keywords: ['time in', 'what time', 'timezone', 'current time', 'utc offset', 'time difference', 'clock']
  },
  {
    name: 'zip_lookup', label: 'Postal codes', category: 'geo', kind: 'api', provider: 'Zippopotam',
    description: 'Resolve a postal/ZIP code to place, region and coordinates.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Data table: place, region, coordinates.', docsUrl: 'https://www.zippopotam.us',
    keywords: ['zip', 'zip code', 'postal code', 'postcode', 'area code', 'what city is']
  },
  {
    name: 'find_university', label: 'Universities', category: 'geo', kind: 'api', provider: 'Hipolabs',
    description: 'Search universities/colleges by name and country with official sites.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Data table: linked universities + country.', docsUrl: 'http://universities.hipolabs.com',
    keywords: ['university', 'universities', 'college', 'school', 'campus', 'higher education']
  },
  // ----------------------------------------------------------------- space ------
  {
    name: 'iss_location', label: 'ISS tracker', category: 'space', kind: 'api', provider: 'Where the ISS at? / Open Notify',
    description: "The International Space Station's live position, altitude and speed.",
    auth: 'none', rateLimit: '~1 req/s (no key, dual-source)',
    dataShape: 'Live map: ISS ground point with altitude/speed.', docsUrl: 'https://wheretheiss.at/w/developer',
    keywords: ['iss', 'space station', 'international space station', 'where is the iss', 'satellite position']
  },
  {
    name: 'people_in_space', label: 'People in space', category: 'space', kind: 'api', provider: 'Open Notify',
    description: 'Astronauts currently in space and their spacecraft.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Data table: astronaut × spacecraft.', docsUrl: 'http://open-notify.org',
    keywords: ['who is in space', 'people in space', 'astronauts', 'cosmonauts', 'how many in space']
  },
  {
    name: 'earthquakes', label: 'Earthquakes', category: 'space', kind: 'api', provider: 'USGS',
    description: 'Recent significant earthquakes worldwide with magnitude and a map.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Map: quake pins (magnitude/place, depth/time).', docsUrl: 'https://earthquake.usgs.gov/fdsnws/event/1',
    keywords: ['earthquake', 'earthquakes', 'seismic', 'tremor', 'magnitude', 'quake', 'richter']
  },
  {
    name: 'space_launches', label: 'Rocket launches', category: 'space', kind: 'api', provider: 'SpaceX API',
    description: 'Upcoming or recent SpaceX launches with dates, details and webcasts.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Data table: mission, date, status + webcast links.', docsUrl: 'https://github.com/r-spacex/SpaceX-API',
    keywords: ['rocket', 'launch', 'launches', 'spacex', 'falcon', 'mission', 'liftoff', 'space flight']
  },
  {
    name: 'nasa_apod', label: 'NASA picture of the day', category: 'space', kind: 'api', provider: 'NASA APOD',
    description: "NASA's Astronomy Picture of the Day with an expert explanation.",
    auth: 'optional', authEnv: 'NASA_API_KEY', rateLimit: 'DEMO_KEY: 30/hr, 50/day · key: 1,000/hr',
    dataShape: 'Image + explanation + date.', docsUrl: 'https://api.nasa.gov',
    keywords: ['apod', 'astronomy picture', 'nasa', 'space image', 'space photo', 'picture of the day']
  },
  // ------------------------------------------------------------------ food ------
  {
    name: 'find_recipe', label: 'Recipes', category: 'food', kind: 'api', provider: 'TheMealDB',
    description: 'Cooking recipe with ingredients and step-by-step instructions.',
    auth: 'none', rateLimit: 'Fair use (test key)',
    dataShape: 'Document card: photo, ingredients, steps (downloadable).', docsUrl: 'https://www.themealdb.com/api.php',
    keywords: ['recipe', 'cook', 'cooking', 'how to make', 'dish', 'meal', 'ingredients', 'food recipe']
  },
  {
    name: 'find_cocktail', label: 'Cocktails', category: 'food', kind: 'api', provider: 'TheCocktailDB',
    description: 'Cocktail/drink recipe with ingredients, measures and instructions.',
    auth: 'none', rateLimit: 'Fair use (test key)',
    dataShape: 'Document card: photo, ingredients, instructions.', docsUrl: 'https://www.thecocktaildb.com/api.php',
    keywords: ['cocktail', 'drink', 'mocktail', 'bartender', 'mixology', 'how to make a', 'margarita', 'mojito']
  },
  // ------------------------------------------------------------ entertainment ---
  {
    name: 'pokemon_info', label: 'Pokémon', category: 'entertainment', kind: 'api', provider: 'PokéAPI',
    description: 'Pokémon types, stats, height/weight and artwork.',
    auth: 'none', rateLimit: 'Fair use (caching encouraged)',
    dataShape: 'Metric board: base-stat gauges, type, size + artwork.', docsUrl: 'https://pokeapi.co',
    keywords: ['pokemon', 'pokémon', 'pikachu', 'pokedex', 'pokémon stats', 'pokemon type']
  },
  {
    name: 'trivia_questions', label: 'Trivia / quiz', category: 'entertainment', kind: 'api', provider: 'Open Trivia DB',
    description: 'Trivia/quiz questions with answers across categories and difficulties.',
    auth: 'none', rateLimit: '1 req / 5s per IP',
    dataShape: 'Text: questions, options, answers.', docsUrl: 'https://opentdb.com/api_config.php',
    keywords: ['trivia', 'quiz', 'quiz me', 'questions', 'ask me', 'game night', 'trivia questions']
  },
  {
    name: 'play_game', label: 'Mini-games', category: 'entertainment', kind: 'builtin', provider: 'DreamStream (in-app, plays locally)',
    description: 'Drop a fully playable mini-game into the chat — Snake, Brick breaker (paddle), 2048 or Memory match — with keyboard + touch controls, Compact/Medium/Large sizes and a fullscreen toggle.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Interactive game card: canvas/DOM game, score + best, resizable, fullscreen.', docsUrl: 'https://dreamstream.app',
    keywords: ['game', 'games', 'play', 'play a game', 'snake', 'breakout', 'brick breaker', '2048', 'memory', 'memory match', 'concentration', 'matching game', 'arcade', 'mini game', 'bored', 'take a break']
  },
  {
    name: 'tv_show', label: 'TV shows', category: 'entertainment', kind: 'api', provider: 'TVMaze',
    description: 'TV show genres, premiere, network, rating and summary.',
    auth: 'none', rateLimit: '~20 calls / 10s (no key)',
    dataShape: 'Document card: poster, facts, summary.', docsUrl: 'https://www.tvmaze.com/api',
    keywords: ['tv show', 'series', 'episode', 'season', 'sitcom', 'show about', 'aired', 'tv series']
  },
  {
    name: 'anime_info', label: 'Anime', category: 'entertainment', kind: 'api', provider: 'Jikan (MyAnimeList)',
    description: 'Anime score, episodes, year, genres and synopsis.',
    auth: 'none', rateLimit: '3 req/s, 60 req/min (no key)',
    dataShape: 'Document card: poster, facts, synopsis.', docsUrl: 'https://jikan.moe',
    keywords: ['anime', 'manga', 'myanimelist', 'mal', 'otaku', 'anime about', 'studio ghibli']
  },
  {
    name: 'random_joke', label: 'Jokes', category: 'entertainment', kind: 'api', provider: 'icanhazdadjoke',
    description: 'A random clean joke.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Text: one joke.', docsUrl: 'https://icanhazdadjoke.com',
    keywords: ['joke', 'jokes', 'make me laugh', 'funny', 'pun', 'dad joke']
  },
  {
    name: 'random_advice', label: 'Advice', category: 'entertainment', kind: 'api', provider: 'Advice Slip',
    description: 'A random piece of advice or wisdom.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Text: one piece of advice.', docsUrl: 'https://api.adviceslip.com',
    keywords: ['advice', 'tip', 'wisdom', 'give me advice', 'words of wisdom']
  },
  {
    name: 'useless_fact', label: 'Random facts', category: 'entertainment', kind: 'api', provider: 'uselessfacts',
    description: 'A random interesting trivia fact.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Text: one fact + source.', docsUrl: 'https://uselessfacts.jsph.pl',
    keywords: ['random fact', 'fun fact', 'interesting fact', 'tell me a fact', 'did you know']
  },
  // ------------------------------------------------------------------- dev ------
  {
    name: 'github_repo', label: 'GitHub repos', category: 'dev', kind: 'api', provider: 'GitHub',
    description: 'Search GitHub repositories by popularity — stars, language, license.',
    auth: 'optional', authEnv: 'GITHUB_TOKEN', rateLimit: '10 req/min keyless · 30/min with token',
    dataShape: 'Data table: repos × stars/forks/issues/language.', docsUrl: 'https://docs.github.com/rest',
    keywords: ['github', 'repo', 'repository', 'open source', 'library for', 'package on github', 'star']
  },
  {
    name: 'npm_package', label: 'npm packages', category: 'dev', kind: 'api', provider: 'npm registry',
    description: 'npm package version, license, homepage and weekly downloads.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Metric board: version, weekly downloads, license, deps.', docsUrl: 'https://github.com/npm/registry',
    keywords: ['npm', 'node package', 'javascript library', 'npm package', 'yarn', 'pnpm']
  },
  {
    name: 'pypi_package', label: 'PyPI packages', category: 'dev', kind: 'api', provider: 'PyPI',
    description: 'PyPI (Python) package version, summary, author and license.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Metric board: version, license, author.', docsUrl: 'https://warehouse.pypa.io/api-reference/json.html',
    keywords: ['pypi', 'pip', 'python package', 'python library', 'pip install']
  },
  {
    name: 'qr_code', label: 'QR codes', category: 'dev', kind: 'api', provider: 'goqr.me',
    description: 'Generate a QR code image encoding text, a URL or Wi-Fi credentials.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Generated QR code image.', docsUrl: 'https://goqr.me/api',
    keywords: ['qr code', 'qr', 'generate qr', 'barcode', 'make a qr']
  },
  {
    name: 'predict_name', label: 'Name demographics', category: 'dev', kind: 'api', provider: 'Agify / Genderize / Nationalize',
    description: 'Predict likely age, gender and nationality of a first name (statistical).',
    auth: 'none', rateLimit: '100 names/day each (no key)',
    dataShape: 'Text: age, gender, nationality estimates.', docsUrl: 'https://agify.io',
    keywords: ['age of name', 'gender of name', 'nationality of name', 'name origin', 'how old is the name']
  },
  {
    name: 'nango_search_integrations', label: 'API connectors (discover)', category: 'dev', kind: 'api', provider: 'Nango (self-hosted)',
    description: 'List the third-party API integrations connectable through Nango (Slack, Google, Notion, Stripe, GitHub, …, 800+). Discover a provider before connecting it.',
    auth: 'required', authEnv: 'NANGO_SECRET_KEY', rateLimit: 'Self-hosted (your infra)',
    dataShape: 'Text: provider names + their integration ids (provider_config_key).', docsUrl: 'https://nango.dev/docs',
    keywords: ['integration', 'connector', 'oauth', 'connect api', 'third party', 'slack', 'notion', 'stripe', 'salesforce', 'nango']
  },
  {
    name: 'nango_connect_integration', label: 'API connectors (authorize)', category: 'dev', kind: 'api', provider: 'Nango (self-hosted)',
    description: 'Start an OAuth/connect flow so an end user authorizes a provider; returns a short-lived connect session token the app hands to the Nango Connect UI.',
    auth: 'required', authEnv: 'NANGO_SECRET_KEY', rateLimit: 'Self-hosted (your infra)',
    dataShape: 'Text: connect session token + link (30-min expiry).', docsUrl: 'https://nango.dev/docs/guides/api-authorization/authorize-in-your-app-default-ui',
    keywords: ['authorize', 'oauth', 'connect account', 'sign in with', 'link account', 'grant access', 'nango']
  },
  {
    name: 'nango_call_api', label: 'API connectors (proxy)', category: 'dev', kind: 'api', provider: 'Nango (self-hosted)',
    description: "Make an authenticated request to a connected provider's API via the Nango proxy (Nango injects the user's credentials and refreshes tokens). Verify real response shapes or call APIs at runtime.",
    auth: 'required', authEnv: 'NANGO_SECRET_KEY', rateLimit: "Self-hosted + the provider's own limits",
    dataShape: "Text: the provider's HTTP status + response body.", docsUrl: 'https://nango.dev/docs/guides/proxy-requests',
    keywords: ['call api', 'proxy', 'fetch from', 'api request', 'get data from', 'post to', 'nango']
  },
  {
    name: 'generate_image', label: 'Image generation', category: 'dev', kind: 'builtin', provider: 'Gemini · Ideogram · Flux (BYOK — your account)',
    description: 'Generate a real image from a text prompt using your own image-generation account key (Gemini/Ideogram/Flux). For illustrations, hero/cover images, icons, OG/share images.',
    auth: 'required', authEnv: 'GEMINI_API_KEY', rateLimit: "Your provider account's limits",
    dataShape: 'An image (shown to the user) + a short confirmation.', docsUrl: 'https://ai.google.dev/gemini-api/docs/imagen',
    keywords: ['image', 'generate image', 'illustration', 'picture', 'art', 'hero image', 'icon', 'og image', 'cover', 'render image', 'imagen', 'ideogram', 'flux']
  },
  {
    name: 'render_video', label: 'HTML → MP4 video', category: 'dev', kind: 'api', provider: 'HyperFrames render worker (self-hosted)',
    description: 'Render a self-contained HTML/CSS/GSAP animation to an MP4 via a self-hosted headless-Chromium + ffmpeg worker. For motion graphics, promos, explainers.',
    auth: 'required', authEnv: 'STUDIO_VIDEO_RENDER_URL', rateLimit: 'Self-hosted (your infra)',
    dataShape: 'Text: a URL/path to the rendered MP4.', docsUrl: 'https://github.com/nexu-io/html-video',
    keywords: ['video', 'mp4', 'render', 'animation', 'motion graphics', 'hyperframes', 'html to video', 'promo', 'explainer']
  },
  {
    name: 'render_live_template', label: 'Live data artifact', category: 'dataviz', kind: 'builtin', provider: 'DreamStream (html_template_v1)',
    description: 'Render a data-driven HTML artifact from an html_template_v1 template ({{ dot.path }} bindings, no JS) + a data object — for live dashboards/reports that re-render from data.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Safe, HTML-escaped interpolated HTML.', docsUrl: 'https://dreamstream.app',
    keywords: ['live', 'dashboard', 'template', 'data-driven', 'report', 'binding', 'interpolate', 'live artifact']
  },
  // ---------------------------------------------------------------- dataviz -----
  {
    name: 'render_chart', label: 'Charts', category: 'dataviz', kind: 'builtin', provider: 'DreamStream (in-app SVG)',
    description: 'Render an interactive chart (line, area, bar, grouped/stacked bar, pie, donut, scatter) from data the model provides — visualize trends, comparisons, breakdowns and distributions.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Chart card with legend + hover tooltips.', docsUrl: 'https://dreamstream.app',
    keywords: ['chart', 'graph', 'plot', 'visualize', 'visualise', 'bar chart', 'line chart', 'pie chart', 'donut', 'scatter', 'trend', 'breakdown', 'distribution']
  },
  {
    name: 'render_ui', label: 'Generative UI', category: 'dataviz', kind: 'builtin', provider: 'DreamStream (in-app SVG)',
    description: 'Compose a bespoke in-chat layout from building blocks (stack/row/grid + text, metrics, charts, tables, images, callouts) when no single fixed card fits — a mini dashboard or a structured, well-aligned response.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'A composed card built from the Primitive Kit (whitelisted blocks).', docsUrl: 'https://dreamstream.app',
    keywords: ['layout', 'dashboard', 'compose', 'custom', 'arrange', 'panel', 'structure', 'align', 'build ui', 'overview', 'summary card', 'side by side', 'comparison layout']
  },
  {
    name: 'render_react', label: 'Custom React component', category: 'dataviz', kind: 'builtin', provider: 'DreamStream (sandboxed Sandpack)',
    description: 'Render a fully-custom interactive widget by writing a self-contained React (TSX) component, run in a sandboxed iframe. For genuinely bespoke interactions/visualizations beyond the render_ui block kit. The substrate where a 21st.dev / shadcn MCP\'s generated component lands.',
    auth: 'none', rateLimit: 'Unlimited (runs client-side in a sandbox)',
    dataShape: 'A self-contained React component, rendered in a sandboxed iframe (tap to run).', docsUrl: 'https://dreamstream.app',
    keywords: ['react', 'component', 'custom widget', 'tsx', 'jsx', 'interactive', 'code widget', 'build component', 'bespoke', 'simulator', 'calculator', 'sandbox', '21st.dev', 'shadcn']
  },
  {
    name: 'convert_data', label: 'Convert data', category: 'dataviz', kind: 'builtin', provider: 'DreamStream (in-app, deterministic)',
    description: 'Deterministically parse and convert raw tabular data (CSV / TSV / JSON) between formats and preview it as a table — no hand-transcription. For "turn this into a CSV", "parse this data", "convert this JSON to a table", or reshaping pasted data before charting.',
    auth: 'none', rateLimit: 'Unlimited (parses locally, no API)',
    dataShape: 'Converted text + a sortable table preview.', docsUrl: 'https://dreamstream.app',
    keywords: ['convert', 'csv', 'tsv', 'json', 'parse', 'reshape', 'transform', 'to csv', 'to json', 'tabular', 'spreadsheet', 'clean data', 'format data']
  },
  {
    name: 'analyze_data', label: 'Analyze data', category: 'dataviz', kind: 'builtin', provider: 'DreamStream (in-app, deterministic)',
    description: 'Deterministically compute statistics or group-by aggregations over raw tabular data (CSV/TSV/JSON) — descriptive stats per numeric column, or sum/avg/count/min/max grouped by a column. No model arithmetic. Returns a results table to chart.',
    auth: 'none', rateLimit: 'Unlimited (computes locally, no API)',
    dataShape: 'A statistics / aggregation results table.', docsUrl: 'https://dreamstream.app',
    keywords: ['analyze', 'analyse', 'statistics', 'stats', 'average', 'mean', 'median', 'sum', 'total', 'aggregate', 'group by', 'summarize', 'summarise', 'count by', 'min', 'max']
  },
  {
    name: 'transform_data', label: 'Transform data', category: 'dataviz', kind: 'builtin', provider: 'DreamStream (in-app, deterministic)',
    description: 'Reshape tabular data deterministically — filter rows, sort, select/drop columns, limit. Clean or narrow raw CSV/TSV/JSON before charting or analyzing it (e.g. "top 10 by revenue", "only active rows", "keep name + score sorted desc"). Returns the reshaped data to chain into render_chart / analyze_data.',
    auth: 'none', rateLimit: 'Unlimited (transforms locally, no API)',
    dataShape: 'The reshaped data + a table preview.', docsUrl: 'https://dreamstream.app',
    keywords: ['filter', 'sort', 'select', 'top', 'limit', 'reshape', 'where', 'order by', 'columns', 'rows', 'narrow', 'clean', 'wrangle', 'subset']
  },
  {
    name: 'convert_image', label: 'Convert image', category: 'media', kind: 'builtin', provider: 'DreamStream (sharp, non-AI)',
    description: 'Deterministically convert or resize an image (PNG/JPEG/WebP/AVIF) with sharp — no AI touches the pixels. Takes an https URL or a data:image URI. For "convert this jpg to png", "make a webp", "resize to 512px".',
    auth: 'none', rateLimit: 'Unlimited (local libvips, no API)',
    dataShape: 'The converted image, shown inline.', docsUrl: 'https://dreamstream.app',
    keywords: ['convert image', 'jpg', 'jpeg', 'png', 'webp', 'avif', 'resize', 'thumbnail', 'image format', 'compress image', 'shrink image', 'to png', 'to jpg']
  },
  {
    name: 'create_dashboard', label: 'Glass dashboard', category: 'dataviz', kind: 'builtin', provider: 'DreamStream (in-app SVG)',
    description: 'Compose a customizable, drag-to-rearrange dashboard of live widgets — clocks across time zones, countdowns, stats, charts, checklists, progress rings, a minimalist globe with flight arcs, notes and links. Built for trackers, trip plans, study boards and overviews.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Widget board: clock, countdown, stat, chart, progress, list, globe, note, links.', docsUrl: 'https://dreamstream.app',
    keywords: ['dashboard', 'widgets', 'tracker', 'overview', 'planner', 'trip', 'flight', 'countdown', 'clock', 'study plan', 'watchlist', 'board', 'glass']
  },
  {
    name: 'show_metrics', label: 'Metric board', category: 'dataviz', kind: 'builtin', provider: 'DreamStream (in-app SVG)',
    description: 'Show a board of KPI / stat tiles (value, delta, sparkline, progress ring, status) from data the model provides — dashboards, scorecards and at-a-glance summaries.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'KPI board: tiles with deltas, sparklines, rings.', docsUrl: 'https://dreamstream.app',
    keywords: ['dashboard', 'kpi', 'kpis', 'metrics', 'scorecard', 'stat board', 'at a glance', 'summary stats', 'overview']
  },
  {
    name: 'generate_quiz', label: 'Quiz / practice', category: 'learning', kind: 'builtin', provider: 'DreamStream (in-app, self-grading)',
    description: 'Generate an interactive, self-grading quiz (single-select, multi-select, true/false, short answer) to help the user learn or test a topic — with per-question explanations and hints.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Interactive quiz card: mixed-format questions, instant grading, score + explanations.', docsUrl: 'https://dreamstream.app',
    keywords: ['quiz', 'quiz me', 'test me', 'practice questions', 'practice problems', 'mcq', 'multiple choice', 'flashcards', 'assess', 'check my understanding', 'study', 'exam', 'review questions']
  },
  {
    name: 'sql_exercise', label: 'SQL playground', category: 'learning', kind: 'builtin', provider: 'DreamStream (sandboxed SQLite / sql.js)',
    description: 'Interactive SQL practice — the user writes and runs real queries against a sandboxed in-memory database, seeing real results and SQLite errors. For learning SQL, joins, aggregations and database basics.',
    auth: 'none', rateLimit: 'Auth + rate-limited; runs in an ephemeral in-memory DB (no filesystem/network).',
    dataShape: 'Runnable SQL editor + schema + task; live result table or error.', docsUrl: 'https://dreamstream.app',
    keywords: ['sql', 'sql exercise', 'practice sql', 'sql query', 'database', 'sqlite', 'joins', 'select query', 'learn sql', 'query practice', 'where clause', 'group by']
  },
  {
    name: 'code_exercise', label: 'Code playground (JS / Python)', category: 'learning', kind: 'builtin', provider: 'DreamStream (sandboxed Web Worker; Python via Pyodide)',
    description: 'Interactive JavaScript or Python practice — the user writes and runs real code in a sandboxed in-browser terminal, seeing real output and real errors/tracebacks. For learning JS or Python, methods, algorithms and general programming.',
    auth: 'none', rateLimit: 'Unlimited (runs locally in a sandboxed worker with a timeout; Python runtime lazy-loads once).',
    dataShape: 'Runnable JS/Python editor + task; live console output or error with stack/traceback.', docsUrl: 'https://dreamstream.app',
    keywords: ['javascript', 'js', 'python', 'py', 'code exercise', 'coding exercise', 'practice coding', 'practice javascript', 'practice python', 'run code', 'code playground', 'try it', 'algorithm practice', 'array methods', 'programming practice', 'leetcode']
  },
  {
    name: 'create_learning_path', label: 'Guided learning path', category: 'learning', kind: 'builtin', provider: 'DreamStream (in-app, progress tracked locally)',
    description: 'Build a guided, multi-module course the user follows inside chat: lessons, practice tasks, quiz/flashcard checkpoints and one-click practice prompts, with progress tracked across sessions. For "teach me X", study plans, curricula and skill roadmaps.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Interactive course card: modules → steps (read/practice/quiz/flashcards/project), per-step completion, progress ring.', docsUrl: 'https://dreamstream.app',
    keywords: ['learn', 'teach me', 'course', 'curriculum', 'study plan', 'roadmap', 'learning path', 'lesson plan', 'syllabus', 'get good at', 'master', 'bootcamp', 'guided learning']
  },
  {
    name: 'plan_trip', label: 'Travel planner', category: 'places', kind: 'builtin', provider: 'DreamStream (plan) + OpenStreetMap geocoding + Open-Meteo weather',
    description: 'Create an interactive day-by-day travel itinerary: timeline of stops with a live map (auto-geocoded), budget lines, packing list and live destination weather. For trip planning, weekend getaways, road trips and multi-city journeys.',
    auth: 'none', rateLimit: 'Fair use (Nominatim + Open-Meteo public APIs)',
    dataShape: 'Itinerary widget: day tabs, stop timeline with kind icons, map with numbered pins + route, budget + packing, weather strip.', docsUrl: 'https://dreamstream.app',
    keywords: ['trip', 'travel', 'itinerary', 'vacation', 'holiday', 'plan my trip', 'days in', 'weekend in', 'road trip', 'visit', 'travel plan', 'getaway', 'tour']
  },
  {
    name: 'generate_flashcards', label: 'Flashcards', category: 'learning', kind: 'builtin', provider: 'DreamStream (in-app)',
    description: 'Create an interactive flip-card study deck (term → definition) for memorizing vocabulary, formulas or facts — with shuffle, known/review marking and progress.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Flip-card deck: front/back cards, shuffle, known/review, progress.', docsUrl: 'https://dreamstream.app',
    keywords: ['flashcards', 'flash cards', 'memorize', 'memorise', 'study cards', 'vocab', 'vocabulary', 'drill', 'spaced repetition', 'anki']
  },
  {
    name: 'generate_document', label: 'Document / resource', category: 'learning', kind: 'builtin', provider: 'DreamStream (in-app, downloadable)',
    description: 'Author a downloadable document — study guide, cheat sheet, notes, report, plan, worksheet or reference — that the user can save as Markdown / HTML or print to PDF.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Document card with the rendered resource + .md / .html / PDF download buttons.', docsUrl: 'https://dreamstream.app',
    keywords: ['document', 'make a document', 'write a', 'cheat sheet', 'cheatsheet', 'study guide', 'guide', 'notes', 'handout', 'worksheet', 'report', 'summary document', 'pdf', 'downloadable', 'reference sheet', 'one-pager']
  },
  {
    name: 'generate_bundle', label: 'Resource bundle (.zip)', category: 'learning', kind: 'builtin', provider: 'DreamStream (in-app, downloadable .zip)',
    description: 'Package a SET of generated files (study guide + practice questions + flashcards, a starter project, data + a README) into one card the user can download per-file or all at once as a .zip — custom-built resources they keep.',
    auth: 'none', rateLimit: 'Unlimited (zipped locally in the browser, no API)',
    dataShape: 'Bundle card: list of named files with per-file download + a single download-all .zip.', docsUrl: 'https://dreamstream.app',
    keywords: ['bundle', 'zip', 'zip file', 'package', 'pack', 'kit', 'resources', 'download all', 'study pack', 'starter project', 'set of files', 'multiple files', 'toolkit', 'templates']
  },
  {
    name: 'render_table', label: 'Data table', category: 'dataviz', kind: 'builtin', provider: 'DreamStream (in-app)',
    description: 'Render a sortable, typed data table from rows the model provides — currency, percent, signed-delta, sparkline and badge cells. For watchlists, holdings, fundamentals grids, screeners and comparisons.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Sortable table with typed/colored cells + sparklines.', docsUrl: 'https://dreamstream.app',
    keywords: ['table', 'data table', 'tabular', 'rows', 'columns', 'spreadsheet', 'grid', 'compare side by side', 'holdings', 'screener', 'list of stocks']
  },
  {
    name: 'render_heatmap', label: 'Heatmap', category: 'dataviz', kind: 'builtin', provider: 'DreamStream (in-app)',
    description: 'Render a market/sector heatmap — a grid of tiles colored green→red by their change, optionally sized by market cap. For breadth at a glance: sector maps, movers, watchlist days.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Colored tile grid (treemap-style) by value.', docsUrl: 'https://dreamstream.app',
    keywords: ['heatmap', 'heat map', 'market map', 'sector map', 'treemap', 'breadth', 'gainers and losers', 'sector performance', 'movers map']
  },
  // ----------------------------------------------------------- productivity -----
  {
    name: 'ask_user', label: 'Ask the user', category: 'productivity', kind: 'builtin', provider: 'DreamStream (in-app)',
    description: 'Asks the user interactive clarifying questions (single-select, multi-select, free text) instead of guessing or dumping a wall of text. Answers come back as the next message so the assistant can tailor the result.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Question card: chips for single/multi choice, text inputs, a Send-answers button.', docsUrl: 'https://dreamstream.app',
    keywords: ['clarify', 'ask', 'question', 'which', 'preferences', 'options', 'choose', 'plan', 'trip', 'recommend', 'ambiguous', 'narrow down']
  },
  {
    name: 'create_goal_tracker', label: 'Goal tracker', category: 'productivity', kind: 'builtin', provider: 'DreamStream (in-app, progress saved locally)',
    description: 'An interactive goal tracker — target date, measurable metric, sequenced milestones the user checks off (progress persists), and next actions. The /goal skill.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Goal card: progress ring, milestone timeline, next actions.', docsUrl: 'https://dreamstream.app',
    keywords: ['goal', 'goals', 'resolution', 'habit', 'target', 'i want to', 'track my goal', 'milestones', 'okr', 'objective', 'accountability']
  },
  {
    name: 'render_whats_changed', label: 'What changed', category: 'productivity', kind: 'builtin', provider: 'DreamStream (in-app)',
    description: 'A prioritized "what changed since you last looked" changelog — price moves, fresh news, events — composed from live tool calls the agent just made.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Changelog rows with kind icons, weights and deltas.', docsUrl: 'https://dreamstream.app',
    keywords: ['what changed', 'whats new', "what's new", 'since yesterday', 'catch me up', 'changelog', 'updates since', 'morning brief', 'recap']
  },
  {
    name: 'create_monitor', label: 'Live monitor (loop)', category: 'productivity', kind: 'builtin', provider: 'DreamStream (loops a refreshable live tool)',
    description: 'A widget that re-runs one live-data tool on an interval (30s–1h) so it stays fresh on screen — stocks, weather, news, crypto, sentiment. The /loop skill.',
    auth: 'none', rateLimit: 'Inherits the looped tool\'s limits',
    dataShape: 'Self-refreshing wrapper around a live widget + cadence chip.', docsUrl: 'https://dreamstream.app',
    keywords: ['monitor', 'watch', 'keep an eye on', 'track live', 'loop', 'every 5 minutes', 'auto refresh', 'live updates', 'poll']
  },
  {
    name: 'create_widget_stack', label: 'Smart stack', category: 'productivity', kind: 'builtin', provider: 'DreamStream (rotates refreshable live tools)',
    description: 'One widget that auto-rotates between 2–4 live cards (stock + weather + news…), Apple-watch style — pauses on hover, each card refreshes through its own live source.',
    auth: 'none', rateLimit: 'Inherits the stacked tools\' limits',
    dataShape: 'Rotating stack with dots/arrows around live widget snapshots.', docsUrl: 'https://dreamstream.app',
    keywords: ['stack', 'smart stack', 'rotate', 'combine widgets', 'all in one widget', 'morning glance', 'rotating dashboard', 'carousel widget']
  },
  {
    name: 'render_pnl_calendar', label: 'Calendar heatmap (P&L)', category: 'dataviz', kind: 'builtin', provider: 'DreamStream (in-app)',
    description: 'A GitHub-style calendar heatmap of any signed daily series — trading P&L, savings, workout minutes — with total, win-rate and best/worst footer.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Week-column heatmap grid + totals footer.', docsUrl: 'https://dreamstream.app',
    keywords: ['pnl calendar', 'p&l calendar', 'daily pnl', 'contribution graph', 'calendar heatmap', 'green days', 'trading journal', 'streak calendar', 'daily tracker']
  },
  // --------------------------------------------------------------- codegen ------
  {
    name: 'fetch_github_pr', label: 'GitHub PR diff', category: 'dev', kind: 'api', provider: 'GitHub',
    description: 'Fetch a real pull-request or commit diff from public GitHub (title, stats, unified diff) so code reviews are grounded in the actual changes.',
    auth: 'optional', authEnv: 'GITHUB_TOKEN', rateLimit: '60 req/hr keyless · 5,000/hr with token',
    dataShape: 'PR meta + unified diff text (capped).', docsUrl: 'https://docs.github.com/rest/pulls',
    keywords: ['pull request', 'pr', 'diff', 'review this pr', 'github pr', 'merge request', 'commit diff', 'code changes']
  },
  {
    name: 'render_code_review', label: 'Code review card', category: 'dev', kind: 'builtin', provider: 'DreamStream (in-app)',
    description: 'A structured code-review verdict card — approve/request-changes, dimension scores, severity-grouped findings with file:line and suggested fixes. The /code-review skill.',
    auth: 'none', rateLimit: 'Unlimited (renders locally, no API)',
    dataShape: 'Verdict badge, score meters, findings with fix snippets.', docsUrl: 'https://dreamstream.app',
    keywords: ['code review', 'review my code', 'review this', 'critique code', 'audit code', 'find bugs', 'security review', 'lint', 'feedback on code']
  },
  {
    name: 'run_python', label: 'Run Python (sandbox)', category: 'codegen', kind: 'builtin', provider: 'DreamStream (Pyodide sandbox)',
    description: 'Write and run Python in a sandboxed Pyodide (CPython/WASM) runtime to compute, convert/transform data, or convert/resize/modify images. Pillow, numpy and pandas are available. Reads attached files from /input/, writes results to /output/, and returns stdout plus any images/files produced.',
    auth: 'none', rateLimit: 'Runs in a memory-sandboxed WASM runtime (no host filesystem/network); a single instance serializes runs with a per-run timeout.',
    dataShape: 'stdout text + produced images (shown inline) and small text/data files (echoed inline).', docsUrl: 'https://pyodide.org',
    keywords: ['run python', 'python', 'code', 'convert image', 'process file', 'compute', 'script', 'pillow', 'numpy', 'pandas']
  },
  {
    name: 'generate_app', label: 'App builder', category: 'codegen', kind: 'builtin', provider: 'DreamStream Code Studio',
    description: 'Build a complete multi-file app (React, vanilla JS, HTML/CSS) and open it in the live Code Studio panel with a real-time preview the user can edit and run.',
    auth: 'none', rateLimit: 'Unlimited (runs in-browser, no API)',
    dataShape: 'code_studio artifact: file tree + live Sandpack preview.', docsUrl: 'https://dreamstream.app',
    keywords: ['build an app', 'create an app', 'make an app', 'build a game', 'create a game', 'landing page', 'todo app', 'react app', 'web app', 'webapp', 'website', 'web page', 'webpage', 'build me', 'make me', 'write code', 'generate code', 'implement', 'scaffold', 'prototype', 'mockup', 'clone', 'create a component', 'build a tool', 'game', 'dashboard', 'calculator', 'simulator', 'visualizer']
  },
  // ------------------------------------------------------------ connectors -----
  // Per-user account connectors (Gmail/Drive/Calendar/Sheets/Maps). These act on the
  // SIGNED-IN user's OWN connected accounts; they report "connect it in Connectors"
  // until the user has authorized the source. See docs/CONNECTORS_FRAMEWORK.md.
  {
    name: 'gmail_search', label: 'Gmail (your inbox)', category: 'productivity', kind: 'builtin', provider: 'Google (your connected account)',
    description: "Search the signed-in user's own Gmail and return matching messages. Supports Gmail operators (from:, subject:, newer_than:7d, has:attachment).",
    auth: 'required', authEnv: 'GOOGLE_OAUTH_CLIENT_ID', rateLimit: 'Bounded by the user\'s Gmail API quota',
    dataShape: 'Matched messages: subject, sender, date, snippet + links.', docsUrl: 'https://developers.google.com/gmail/api',
    keywords: ['my email', 'my emails', 'my gmail', 'my inbox', 'search my mail', 'email from', 'check my email', 'unread email', 'message from', 'my messages']
  },
  {
    name: 'gmail_inbox', label: 'Gmail inbox (email terminal)', category: 'productivity', kind: 'builtin', provider: 'Google (your connected account)',
    description: "Open the signed-in user's Gmail as a big interactive inbox widget (searchable list + reading pane + open/reply). Optional query pre-filters with Gmail operators.",
    auth: 'required', authEnv: 'GOOGLE_OAUTH_CLIENT_ID', rateLimit: 'Bounded by the user\'s Gmail API quota',
    dataShape: 'Interactive email list: sender, subject, snippet, date, unread/star flags + a reading pane.', docsUrl: 'https://developers.google.com/gmail/api',
    keywords: ['my email', 'my inbox', 'open my email', 'show my email', 'go through my emails', 'check my mail', 'open gmail', 'my gmail', 'read my email', 'email terminal']
  },
  {
    name: 'gmail_unread', label: 'Gmail unread', category: 'productivity', kind: 'builtin', provider: 'Google (your connected account)',
    description: "Show the signed-in user's UNREAD Gmail as an interactive widget (unread-only email terminal).",
    auth: 'required', authEnv: 'GOOGLE_OAUTH_CLIENT_ID', rateLimit: 'Bounded by the user\'s Gmail API quota',
    dataShape: 'Interactive list of unread messages: sender, subject, snippet, date + a reading pane.', docsUrl: 'https://developers.google.com/gmail/api',
    keywords: ['unread email', 'unread emails', 'new mail', 'new emails', "what's new in my inbox", 'do i have new mail', 'any new emails', 'unread messages']
  },
  {
    name: 'gmail_compose', label: 'Gmail compose (draft)', category: 'productivity', kind: 'builtin', provider: 'Google (your connected account)',
    description: "Draft an email and show a compose widget with a one-click 'Open in Gmail' link. Read-only connection — it prepares the draft, it does not send.",
    auth: 'optional', authEnv: 'GOOGLE_OAUTH_CLIENT_ID', rateLimit: 'No API call — builds a Gmail compose link',
    dataShape: 'Editable compose form (to/cc/subject/body) + Gmail compose + mailto links.', docsUrl: 'https://developers.google.com/gmail/api',
    keywords: ['write an email', 'draft an email', 'compose an email', 'compose a message', 'draft a reply', 'write a message', 'send an email', 'email to']
  },
  {
    name: 'drive_search', label: 'Drive (your files)', category: 'productivity', kind: 'builtin', provider: 'Google (your connected account)',
    description: "Search the signed-in user's own Google Drive files by name and return matches (name, type, link, modified date).",
    auth: 'required', authEnv: 'GOOGLE_OAUTH_CLIENT_ID', rateLimit: 'Bounded by the user\'s Drive API quota',
    dataShape: 'Matched files: name, type, owner, modified date + links.', docsUrl: 'https://developers.google.com/drive/api',
    keywords: ['my files', 'my drive', 'google drive', 'my documents', 'my doc', 'my spreadsheet', 'my slides', 'find my file', 'my folder']
  },
  {
    name: 'calendar_agenda', label: 'Calendar (your schedule)', category: 'productivity', kind: 'builtin', provider: 'Google (your connected account)',
    description: "Open the signed-in user's own Google Calendar as an interactive agenda widget (agenda/week/month views, click-to-detail) and answer schedule/availability questions.",
    auth: 'required', authEnv: 'GOOGLE_OAUTH_CLIENT_ID', rateLimit: 'Bounded by the user\'s Calendar API quota',
    dataShape: 'Interactive calendar widget: events with start/end, location, attendees, RSVP status + links.', docsUrl: 'https://developers.google.com/calendar/api',
    keywords: ['my calendar', 'my schedule', 'my agenda', 'my meetings', 'upcoming events', 'next meeting', 'am i free', 'what do i have', 'my appointments', 'this week', 'today', 'tomorrow', 'free time']
  },
  {
    name: 'calendar_create_event', label: 'Calendar — create event', category: 'productivity', kind: 'builtin', provider: 'Google (your connected account)',
    description: "Prepare a NEW Google Calendar event (a confirmation card the user approves — never created silently). Use for 'add/schedule/book … on my calendar'.",
    auth: 'required', authEnv: 'GOOGLE_OAUTH_CLIENT_ID', rateLimit: 'Bounded by the user\'s Calendar API quota',
    dataShape: 'A confirmation card (title, time, location, attendees) with a Create button.', docsUrl: 'https://developers.google.com/calendar/api',
    keywords: ['add to my calendar', 'schedule a meeting', 'create an event', 'book a meeting', 'put on my calendar', 'set up a meeting', 'new event', 'schedule', 'remind me to meet', 'block time']
  },
  {
    name: 'calendar_update_event', label: 'Calendar — edit event', category: 'productivity', kind: 'builtin', provider: 'Google (your connected account)',
    description: "Prepare an EDIT to an existing calendar event (reschedule/rename/move) as a confirmation card the user approves. Needs the eventId from calendar_agenda.",
    auth: 'required', authEnv: 'GOOGLE_OAUTH_CLIENT_ID', rateLimit: 'Bounded by the user\'s Calendar API quota',
    dataShape: 'A confirmation card showing the change with a Save button.', docsUrl: 'https://developers.google.com/calendar/api',
    keywords: ['reschedule', 'move my meeting', 'change the time', 'edit event', 'update my calendar', 'push back the meeting', 'rename the event']
  },
  {
    name: 'calendar_delete_event', label: 'Calendar — delete event', category: 'productivity', kind: 'builtin', provider: 'Google (your connected account)',
    description: "Prepare to DELETE/cancel an event as a confirmation card the user approves. Needs the eventId from calendar_agenda.",
    auth: 'required', authEnv: 'GOOGLE_OAUTH_CLIENT_ID', rateLimit: 'Bounded by the user\'s Calendar API quota',
    dataShape: 'A confirmation card with a Delete button.', docsUrl: 'https://developers.google.com/calendar/api',
    keywords: ['cancel the meeting', 'delete event', 'remove from my calendar', 'cancel my appointment', 'clear my calendar']
  },
  {
    name: 'calendar_rsvp', label: 'Calendar — RSVP', category: 'productivity', kind: 'builtin', provider: 'Google (your connected account)',
    description: "Prepare an RSVP (accept/decline/tentative) to an invitation as a confirmation card the user approves. Needs the eventId from calendar_agenda.",
    auth: 'required', authEnv: 'GOOGLE_OAUTH_CLIENT_ID', rateLimit: 'Bounded by the user\'s Calendar API quota',
    dataShape: 'A confirmation card with accept/decline/tentative buttons.', docsUrl: 'https://developers.google.com/calendar/api',
    keywords: ['accept the invite', 'decline the meeting', 'rsvp', 'respond to the invitation', 'maybe attend', 'tentative']
  },
  {
    name: 'sheets_read', label: 'Sheets (read a range)', category: 'productivity', kind: 'builtin', provider: 'Google (your connected account)',
    description: "Read a range of cells from one of the signed-in user's own Google Sheets as structured rows for analysis/summary. Needs the spreadsheetId + an A1 range.",
    auth: 'required', authEnv: 'GOOGLE_OAUTH_CLIENT_ID', rateLimit: 'Bounded by the user\'s Sheets API quota',
    dataShape: 'Rows keyed by the header row (structured records).', docsUrl: 'https://developers.google.com/sheets/api',
    keywords: ['my spreadsheet', 'my google sheet', 'read my sheet', 'sheet range', 'analyze my sheet', 'data in my sheet']
  },
  {
    name: 'maps_lookup', label: 'Google Maps (geocode/places)', category: 'places', kind: 'builtin', provider: 'Google Maps (API key)',
    description: 'Geocode an address (address→coordinates) or text-search places/businesses via the connected Google Maps key.',
    auth: 'required', authEnv: 'GOOGLE_MAPS_API_KEY', rateLimit: 'Bounded by the Maps API key quota/budget',
    dataShape: 'Places/geocode results: name, formatted address, location, rating + map links.', docsUrl: 'https://developers.google.com/maps/documentation',
    keywords: ['geocode', 'google places', 'google maps', 'address to coordinates', 'lat long of', 'place lookup', 'find the address']
  },
  {
    name: 'connected_data_search', label: 'Search my connected data', category: 'productivity', kind: 'builtin', provider: 'Your connected accounts (synced)',
    description: "Unified RAG search across EVERYTHING the user connected and synced (their Gmail, Drive, Calendar, YouTube) in one query. Use when the source isn't specified.",
    auth: 'required', authEnv: 'GOOGLE_OAUTH_CLIENT_ID', rateLimit: 'Local query over synced data',
    dataShape: 'Top matching items across sources: title, source, snippet, date + links.', docsUrl: 'https://dreamstream.app',
    keywords: ['across my accounts', 'my connected data', 'search my stuff', 'what do i have about', 'in my accounts', 'my synced data', 'search everything i connected']
  },
  // ----------------------------------------------------------------- agents -----
  {
    name: 'run_agent_swarm', label: 'Agent swarm', category: 'agents', kind: 'builtin', provider: 'DreamStream orchestrator',
    description: 'Delegate complex, multi-domain tasks to specialized agents that work in parallel and synthesize one answer.',
    auth: 'required', authEnv: 'OPENROUTER_API_KEY', rateLimit: 'Bounded by your model usage limits',
    dataShape: 'Synthesized answer + live agent trace.', docsUrl: 'https://dreamstream.app',
    keywords: ['research everything', 'comprehensive', 'multi-step', 'plan and execute', 'deep dive', 'compare across']
  }
];

// ------------------------------------------------------ connector key registry -----

export interface ConnectorKeyMeta {
  /** Server env var that activates the upgrade. */
  env: string;
  provider: string;
  /** What setting this key unlocks, in plain words. */
  unlocks: string;
  /** Honest cost line — free-tier size and where paid starts. */
  cost: string;
  signupUrl: string;
  /** Which tool names benefit. */
  tools: string[];
}

/**
 * The "set these free keys" onboarding list (June 2026 audit) — every entry has a
 * genuinely free tier and upgrades reliability and/or commercial-use compliance.
 * Informational on the client (env vars live on the server/Railway).
 */
export const CONNECTOR_KEYS: ConnectorKeyMeta[] = [
  {
    env: 'ALPACA_API_KEY_ID', provider: 'Alpaca Market Data',
    unlocks: 'Licensed IEX fallback feed for US equity quotes (plus ALPACA_API_SECRET_KEY) that keeps stock cards alive if Yahoo blocks the server. Yahoo stays primary — IEX volume/ranges understate the consolidated tape.',
    cost: 'Free (Basic plan, ~200 req/min). Paid SIP feed from $99/mo — not needed for display.',
    signupUrl: 'https://alpaca.markets', tools: ['get_stock']
  },
  {
    env: 'TAVILY_API_KEY', provider: 'Tavily',
    unlocks: 'Reliable non-scraping web search built for AI agents — the production search backbone.',
    cost: 'Free 1,000 credits/mo; then ~$8 per 1k searches (pay-as-you-go).',
    signupUrl: 'https://www.tavily.com', tools: ['web_search']
  },
  {
    env: 'BRAVE_API_KEY', provider: 'Brave Search API',
    unlocks: 'Independent search index as a second non-scraping search provider.',
    cost: '$5 free credit/mo (≈1,000 searches, attribution required); then $5 per 1k.',
    signupUrl: 'https://brave.com/search/api/', tools: ['web_search']
  },
  {
    env: 'SERPER_API_KEY', provider: 'Serper.dev',
    unlocks: 'Cheapest paid Google-results escape hatch for search overflow.',
    cost: '2,500 free one-time credits; then ~$0.30–1.00 per 1k queries.',
    signupUrl: 'https://serper.dev', tools: ['web_search']
  },
  {
    env: 'SEARXNG_URL', provider: 'SearXNG (self-hosted)',
    unlocks: 'Your own metasearch instance — unlimited, private, free (deploy the Railway template).',
    cost: 'Free software; ~$5/mo of Railway resources.',
    signupUrl: 'https://docs.searxng.org', tools: ['web_search']
  },
  {
    env: 'COINGECKO_API_KEY', provider: 'CoinGecko',
    unlocks: 'Stable authenticated crypto data; the Basic plan adds the commercial-display license.',
    cost: 'Demo key free (10k calls/mo, non-commercial); commercial rights from $35/mo (Basic).',
    signupUrl: 'https://www.coingecko.com/en/api/pricing', tools: ['crypto_price']
  },
  {
    env: 'JINA_API_KEY', provider: 'Jina Reader',
    unlocks: 'Reliable in-app article reading: extracts stories from publishers that 403 datacenter IPs (the keyless tier is heavily rate-limited and best-effort).',
    cost: 'Free key with a generous monthly token grant; pay-as-you-go after.',
    signupUrl: 'https://jina.ai/reader', tools: ['get_news']
  },
  {
    env: 'IPINFO_TOKEN', provider: 'IPinfo Lite',
    unlocks: 'Commercial-legal IP geolocation (country/ASN, unlimited) replacing non-commercial ip-api.com.',
    cost: 'Free (attribution required); city-level from $49/mo.',
    signupUrl: 'https://ipinfo.io/lite', tools: ['ip_lookup']
  },
  {
    env: 'OPEN_METEO_API_KEY', provider: 'Open-Meteo (commercial)',
    unlocks: 'Makes Open-Meteo the primary weather source again (adds feels-like, visibility, AQI/pollen). Alternative: self-host via OPEN_METEO_BASE_URL (AGPL, free).',
    cost: 'Free path: MET Norway primary (default). Open-Meteo API Professional from €99/mo, or self-host for free.',
    signupUrl: 'https://open-meteo.com/en/pricing', tools: ['get_weather']
  },
  {
    env: 'FOURSQUARE_API_KEY', provider: 'Foursquare Places',
    unlocks: 'Ratings, photos and price tiers on local place search (OpenStreetMap stays the keyless fallback).',
    cost: 'Free tier; usage-based beyond it.',
    signupUrl: 'https://location.foursquare.com', tools: ['find_places']
  }
];

// ----------------------------------------------------------------- helpers -----

const BY_NAME = new Map<string, ToolMeta>(TOOL_CATALOG.map((t) => [t.name, t] as [string, ToolMeta]));

export const getToolMeta = (name: string): ToolMeta | undefined => BY_NAME.get(name);

export const toolsByCategory = (category: ToolCategory): ToolMeta[] =>
  TOOL_CATALOG.filter((t) => t.category === category);

/** All tool names in the catalogue. */
export const ALL_TOOL_NAMES: string[] = TOOL_CATALOG.map((t) => t.name);

// Route-built META tools: attached explicitly by the chat route (the swarm with provider
// creds; image gen with the user's BYOK image keys on explicit enable). They are NOT in the
// static tool registry, so routing them would just waste a smart-routing slot — exclude them.
const META_TOOL_NAMES = new Set(['run_agent_swarm', 'generate_image']);

/** Tool names that are safe to auto-enable / route to (everything except route-built meta tools). */
export const ROUTABLE_TOOL_NAMES: string[] = TOOL_CATALOG.filter((t) => !META_TOOL_NAMES.has(t.name)).map((t) => t.name);

const tokenize = (text: string): string[] => {
  const matches = text.toLowerCase().match(/[a-z0-9&]+/g);
  return matches ? matches.filter((w) => w.length > 1) : [];
};

/**
 * Score how relevant each candidate tool is to the user's message by keyword
 * overlap. Multi-word keywords (phrases) score higher than single tokens. Returns
 * tools sorted by descending score (ties keep catalogue order).
 */
export const scoreTools = (
  text: string,
  candidateNames: string[] = ROUTABLE_TOOL_NAMES
): { name: string; score: number }[] => {
  const lower = ` ${text.toLowerCase()} `;
  const tokens = new Set(tokenize(text));
  const scored = candidateNames
    .map((name) => {
      const meta = BY_NAME.get(name);
      if (!meta) return { name, score: 0 };
      let score = 0;
      for (const kw of meta.keywords) {
        if (kw.includes(' ')) {
          if (lower.includes(` ${kw} `) || lower.includes(`${kw} `) || lower.includes(` ${kw}`)) score += 3;
        } else if (tokens.has(kw)) {
          score += 2;
        }
      }
      return { name, score };
    })
    .filter((s) => s.score > 0);
  return scored.sort((a, b) => b.score - a.score);
};

/**
 * Tools the model should ALWAYS be offered (when enabled), regardless of whether the
 * user's wording matched a keyword. These are the freeform visualization tools plus the
 * universal grounding tools — so the model can DECIDE to chart/tabulate/look-up from
 * intent (the way ChatGPT does), instead of only when the message literally contains
 * "chart"/"table"/etc. web_search leads as the universal internet backstop.
 */
export const CORE_ALWAYS_TOOLS: string[] = [
  'web_search',
  'render_chart',
  'render_table',
  'show_metrics',
  'create_dashboard',
  'render_heatmap',
  'render_ui',
  'convert_data',
  'analyze_data',
  'transform_data',
  'run_python',
  'get_news',
  'wiki_lookup',
  // The app builder must ALWAYS be on the table: "build me X" is phrased a thousand
  // ways and keyword-matching alone routed it out far too often, so the model would
  // dump a Markdown code block instead of opening the live Code Studio. Keeping it in
  // the core set means the model can always CHOOSE to build a runnable app from intent.
  'generate_app'
];

/**
 * Smart selection: from the set of *enabled* tool names, pick the subset to hand the
 * model so it isn't given dozens of specs at once.
 *
 * Order of precedence (each fills remaining slots up to `max`):
 *   1. the swarm meta-tool, if enabled (decision is preserved);
 *   2. keyword-matched tools — so a clearly-invoked domain tool is never crowded out;
 *   3. the always-on core tools (visualization + grounding) — so the model can choose
 *      to visualize/ground even with no keyword hit;
 *   4. web_search backstop, then a web/news/wiki fallback if nothing else applied.
 *
 * Never returns more than `max` tools.
 */
export const selectRelevantTools = (
  text: string,
  enabledNames: string[],
  max = 20
): string[] => {
  if (enabledNames.length <= max) return enabledNames;
  const enabled = new Set(enabledNames);
  const keep = new Set<string>();
  // 1. Always preserve the swarm meta-tool decision.
  if (enabled.has('run_agent_swarm')) keep.add('run_agent_swarm');
  // 2. Keyword-matched tools first, so an explicitly-invoked domain tool always survives.
  const ranked = scoreTools(text, enabledNames.filter((n) => n !== 'run_agent_swarm'));
  for (const { name } of ranked) {
    if (keep.size >= max) break;
    keep.add(name);
  }
  // 3. Always-on core (visualization + grounding) fills the remaining slots.
  for (const core of CORE_ALWAYS_TOOLS) {
    if (keep.size >= max) break;
    if (enabled.has(core)) keep.add(core);
  }
  // 4. Backstops.
  if (keep.size < max && enabled.has('web_search')) keep.add('web_search');
  if (keep.size === 0) {
    for (const fallback of ['web_search', 'get_news', 'wiki_lookup']) {
      if (enabled.has(fallback)) keep.add(fallback);
    }
  }
  return Array.from(keep).slice(0, max);
};
