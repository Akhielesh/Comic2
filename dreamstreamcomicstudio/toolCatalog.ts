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
  | 'media'
  | 'agents';

export type ToolAuth = 'none' | 'optional' | 'required';

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
  { id: 'agents', label: 'Agents', icon: 'Network', blurb: 'Delegate complex tasks to a swarm.' }
];

export const TOOL_CATALOG: ToolMeta[] = [
  // ---------------------------------------------------------------- search ------
  {
    name: 'web_search', label: 'Web search', category: 'search', kind: 'builtin', provider: 'SearXNG → DuckDuckGo → Bing → Wikipedia (free, keyless) · Tavily/Brave/Google if keyed',
    description: 'Search the live web for current, factual or post-training information with ranked results and citations.',
    auth: 'optional', authEnv: 'SEARXNG_URL', rateLimit: 'Free keyless sources by default (open-source SearXNG + scrapers); self-host SearXNG via SEARXNG_URL, or add a free TAVILY_API_KEY/BRAVE_API_KEY, for higher reliability',
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
    dataShape: 'News card: dated, sourced headlines + citations.', docsUrl: 'https://news.google.com',
    keywords: ['news', 'headline', 'breaking', 'happening', 'latest on', 'updates', 'press']
  },
  // ---------------------------------------------------------------- weather -----
  {
    name: 'get_weather', label: 'Weather', category: 'weather', kind: 'builtin', provider: 'Open-Meteo',
    description: 'Current weather, forecast, UV and air quality for a place.',
    auth: 'none', rateLimit: '~10,000 calls/day (no key)',
    dataShape: 'Weather card: temp, conditions, 5-day forecast.', docsUrl: 'https://open-meteo.com',
    keywords: ['weather', 'temperature', 'forecast', 'rain', 'snow', 'humidity', 'wind', 'uv', 'air quality', 'hot', 'cold']
  },
  // ---------------------------------------------------------------- finance -----
  {
    name: 'get_stock', label: 'Markets (stocks, commodities, FX)', category: 'finance', kind: 'builtin', provider: 'Yahoo Finance (Stooq fallback)',
    description: 'Live quote for stocks, ETFs, indices, commodities (gold, oil, metals), FX pairs and crypto — with an intraday→multi-year range timeline, 52-week range, stats, peers and headlines.',
    auth: 'none', rateLimit: 'Fair use (keyless)',
    dataShape: 'Rich market card: price, range timeline, 52-wk, peers, news.', docsUrl: 'https://finance.yahoo.com',
    keywords: ['stock', 'share', 'ticker', 'nasdaq', 's&p', 'dow', 'index', 'equity', 'market', 'gold', 'silver', 'platinum', 'copper', 'oil', 'crude', 'brent', 'commodity', 'commodities', 'metals', 'natural gas', 'futures']
  },
  {
    name: 'crypto_price', label: 'Crypto prices', category: 'finance', kind: 'api', provider: 'CoinGecko',
    description: 'Current price, market cap and 24h change of a cryptocurrency.',
    auth: 'none', rateLimit: '~10-30 calls/min (public demo tier)',
    dataShape: 'Interactive price card (chart) + 24h %, market cap, rank.', docsUrl: 'https://www.coingecko.com/en/api',
    keywords: ['crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'coin', 'token', 'solana', 'dogecoin', 'altcoin']
  },
  {
    name: 'exchange_rate', label: 'Currency exchange', category: 'finance', kind: 'api', provider: 'Frankfurter (ECB)',
    description: 'Convert between fiat currencies using official ECB reference rates.',
    auth: 'none', rateLimit: 'Unlimited fair use (no key)',
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
  // -------------------------------------------------------------- knowledge -----
  {
    name: 'wiki_lookup', label: 'Wikipedia', category: 'knowledge', kind: 'api', provider: 'Wikipedia REST',
    description: 'Encyclopedic summary of a topic, person, place, event or concept.',
    auth: 'none', rateLimit: '~200 req/s per IP (no key)',
    dataShape: 'Text extract + source link + thumbnail.', docsUrl: 'https://www.mediawiki.org/wiki/API:REST_API',
    keywords: ['wikipedia', 'who is', 'what is', 'history of', 'about', 'encyclopedia', 'biography', 'background']
  },
  {
    name: 'search_books', label: 'Books', category: 'knowledge', kind: 'api', provider: 'Open Library',
    description: 'Search books by title, author or subject with covers and links.',
    auth: 'none', rateLimit: 'Fair use (~100/min suggested)',
    dataShape: 'List: title, author, year, cover image + links.', docsUrl: 'https://openlibrary.org/developers/api',
    keywords: ['book', 'books', 'author', 'novel', 'read', 'reading', 'isbn', 'publication']
  },
  {
    name: 'search_papers', label: 'Research papers', category: 'knowledge', kind: 'api', provider: 'arXiv',
    description: 'Search academic/research papers across sciences with abstracts.',
    auth: 'none', rateLimit: '1 request / 3s suggested',
    dataShape: 'List: title, authors, abstract, link.', docsUrl: 'https://info.arxiv.org/help/api',
    keywords: ['paper', 'papers', 'research', 'arxiv', 'study', 'academic', 'scientific', 'preprint', 'citation']
  },
  {
    name: 'hacker_news', label: 'Hacker News', category: 'knowledge', kind: 'api', provider: 'HN (Algolia)',
    description: 'Tech, startup and programming stories the dev community is discussing.',
    auth: 'none', rateLimit: '~10,000 req/hr (no key)',
    dataShape: 'List: title, points, comments, link.', docsUrl: 'https://hn.algolia.com/api',
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
    dataShape: 'Text: meanings, examples, synonyms.', docsUrl: 'https://dictionaryapi.dev',
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
    auth: 'none', rateLimit: 'Unlimited fair use (no key)',
    dataShape: 'Text profile + flag image.', docsUrl: 'https://restcountries.com',
    keywords: ['country', 'capital', 'population', 'currency of', 'flag', 'nation', 'demographics']
  },
  {
    name: 'ip_lookup', label: 'IP geolocation', category: 'geo', kind: 'api', provider: 'ip-api.com',
    description: 'Geolocate an IP address or domain — country, city, ISP and coordinates.',
    auth: 'none', rateLimit: '45 req/min per IP (HTTP, no key)',
    dataShape: 'Text: location, ISP, ASN, coordinates.', docsUrl: 'https://ip-api.com/docs',
    keywords: ['ip', 'ip address', 'geolocate', 'whois', 'server location', 'hostname', 'isp']
  },
  {
    name: 'public_holidays', label: 'Public holidays', category: 'geo', kind: 'api', provider: 'Nager.Date',
    description: 'National/public holidays for a country and year.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Text: list of dated holidays.', docsUrl: 'https://date.nager.at/swagger',
    keywords: ['holiday', 'holidays', 'public holiday', 'bank holiday', 'day off', 'national day']
  },
  {
    name: 'sun_times', label: 'Sunrise / sunset', category: 'geo', kind: 'api', provider: 'sunrise-sunset.org',
    description: 'Sunrise, sunset, solar noon and day length for a place.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Text: sun event times (UTC).', docsUrl: 'https://sunrise-sunset.org/api',
    keywords: ['sunrise', 'sunset', 'golden hour', 'daylight', 'day length', 'solar noon', 'dawn', 'dusk']
  },
  {
    name: 'world_time', label: 'World time', category: 'geo', kind: 'api', provider: 'Open-Meteo geocoding + Intl',
    description: 'Current local date/time and UTC offset for a place or timezone.',
    auth: 'none', rateLimit: 'Geocoding fair use; time computed locally',
    dataShape: 'Text: local time, offset, weekday.', docsUrl: 'https://open-meteo.com',
    keywords: ['time in', 'what time', 'timezone', 'current time', 'utc offset', 'time difference', 'clock']
  },
  {
    name: 'zip_lookup', label: 'Postal codes', category: 'geo', kind: 'api', provider: 'Zippopotam',
    description: 'Resolve a postal/ZIP code to place, region and coordinates.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Text: places, state, coordinates.', docsUrl: 'https://www.zippopotam.us',
    keywords: ['zip', 'zip code', 'postal code', 'postcode', 'area code', 'what city is']
  },
  {
    name: 'find_university', label: 'Universities', category: 'geo', kind: 'api', provider: 'Hipolabs',
    description: 'Search universities/colleges by name and country with official sites.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Text: names, countries, websites.', docsUrl: 'http://universities.hipolabs.com',
    keywords: ['university', 'universities', 'college', 'school', 'campus', 'higher education']
  },
  // ----------------------------------------------------------------- space ------
  {
    name: 'iss_location', label: 'ISS tracker', category: 'space', kind: 'api', provider: 'Where the ISS at? / Open Notify',
    description: "The International Space Station's live position, altitude and speed.",
    auth: 'none', rateLimit: '~1 req/s (no key, dual-source)',
    dataShape: 'Text + map marker of the ISS.', docsUrl: 'https://wheretheiss.at/w/developer',
    keywords: ['iss', 'space station', 'international space station', 'where is the iss', 'satellite position']
  },
  {
    name: 'people_in_space', label: 'People in space', category: 'space', kind: 'api', provider: 'Open Notify',
    description: 'Astronauts currently in space and their spacecraft.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Text: count + names grouped by craft.', docsUrl: 'http://open-notify.org',
    keywords: ['who is in space', 'people in space', 'astronauts', 'cosmonauts', 'how many in space']
  },
  {
    name: 'earthquakes', label: 'Earthquakes', category: 'space', kind: 'api', provider: 'USGS',
    description: 'Recent significant earthquakes worldwide with magnitude and a map.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Text + map of recent quakes.', docsUrl: 'https://earthquake.usgs.gov/fdsnws/event/1',
    keywords: ['earthquake', 'earthquakes', 'seismic', 'tremor', 'magnitude', 'quake', 'richter']
  },
  {
    name: 'space_launches', label: 'Rocket launches', category: 'space', kind: 'api', provider: 'SpaceX API',
    description: 'Upcoming or recent SpaceX launches with dates, details and webcasts.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Text: missions, dates, links, patches.', docsUrl: 'https://github.com/r-spacex/SpaceX-API',
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
    dataShape: 'Text: ingredients + steps + dish photo.', docsUrl: 'https://www.themealdb.com/api.php',
    keywords: ['recipe', 'cook', 'cooking', 'how to make', 'dish', 'meal', 'ingredients', 'food recipe']
  },
  {
    name: 'find_cocktail', label: 'Cocktails', category: 'food', kind: 'api', provider: 'TheCocktailDB',
    description: 'Cocktail/drink recipe with ingredients, measures and instructions.',
    auth: 'none', rateLimit: 'Fair use (test key)',
    dataShape: 'Text: ingredients + steps + drink photo.', docsUrl: 'https://www.thecocktaildb.com/api.php',
    keywords: ['cocktail', 'drink', 'mocktail', 'bartender', 'mixology', 'how to make a', 'margarita', 'mojito']
  },
  // ------------------------------------------------------------ entertainment ---
  {
    name: 'pokemon_info', label: 'Pokémon', category: 'entertainment', kind: 'api', provider: 'PokéAPI',
    description: 'Pokémon types, stats, height/weight and artwork.',
    auth: 'none', rateLimit: 'Fair use (caching encouraged)',
    dataShape: 'Text: types, stats + artwork image.', docsUrl: 'https://pokeapi.co',
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
    name: 'tv_show', label: 'TV shows', category: 'entertainment', kind: 'api', provider: 'TVMaze',
    description: 'TV show genres, premiere, network, rating and summary.',
    auth: 'none', rateLimit: '~20 calls / 10s (no key)',
    dataShape: 'Text profile + poster image.', docsUrl: 'https://www.tvmaze.com/api',
    keywords: ['tv show', 'series', 'episode', 'season', 'sitcom', 'show about', 'aired', 'tv series']
  },
  {
    name: 'anime_info', label: 'Anime', category: 'entertainment', kind: 'api', provider: 'Jikan (MyAnimeList)',
    description: 'Anime score, episodes, year, genres and synopsis.',
    auth: 'none', rateLimit: '3 req/s, 60 req/min (no key)',
    dataShape: 'Text profile + poster image.', docsUrl: 'https://jikan.moe',
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
    dataShape: 'Text: repos, stars, language + links.', docsUrl: 'https://docs.github.com/rest',
    keywords: ['github', 'repo', 'repository', 'open source', 'library for', 'package on github', 'star']
  },
  {
    name: 'npm_package', label: 'npm packages', category: 'dev', kind: 'api', provider: 'npm registry',
    description: 'npm package version, license, homepage and weekly downloads.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Text: version, deps, downloads + link.', docsUrl: 'https://github.com/npm/registry',
    keywords: ['npm', 'node package', 'javascript library', 'npm package', 'yarn', 'pnpm']
  },
  {
    name: 'pypi_package', label: 'PyPI packages', category: 'dev', kind: 'api', provider: 'PyPI',
    description: 'PyPI (Python) package version, summary, author and license.',
    auth: 'none', rateLimit: 'Fair use (no key)',
    dataShape: 'Text: version, summary, license + link.', docsUrl: 'https://warehouse.pypa.io/api-reference/json.html',
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
  // --------------------------------------------------------------- codegen ------
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
  // ----------------------------------------------------------------- agents -----
  {
    name: 'run_agent_swarm', label: 'Agent swarm', category: 'agents', kind: 'builtin', provider: 'DreamStream orchestrator',
    description: 'Delegate complex, multi-domain tasks to specialized agents that work in parallel and synthesize one answer.',
    auth: 'required', authEnv: 'OPENROUTER_API_KEY', rateLimit: 'Bounded by your model usage limits',
    dataShape: 'Synthesized answer + live agent trace.', docsUrl: 'https://dreamstream.app',
    keywords: ['research everything', 'comprehensive', 'multi-step', 'plan and execute', 'deep dive', 'compare across']
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
