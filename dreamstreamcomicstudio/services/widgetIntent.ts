// widgetIntent — turn a plain phrase ("rivian stock", "weather tokyo", "bitcoin",
// "AI news", "usd to eur") into ready-to-pin dashboard widget suggestions. This is the
// "just tell me what you want" layer over the widget catalog: the user shouldn't need to
// know the exact tool, ticker symbol, or field names.
//
// Pure + dependency-free so it can run on every keystroke. It never throws; an
// unrecognized phrase simply falls back to a keyword search over the catalog.

import type { WidgetDensity } from '../components/chat/artifacts/kit';
import { EMBED_TILE, WIDGET_BY_TOOL, searchWidgets, type WidgetDef } from '../components/chat/widgetCatalog';
import { isEmbeddableVideo } from '../components/chat/videoEmbed';
import { resolveStockSymbol } from './symbolResolve';

export interface WidgetSuggestion {
  key: string;
  def: WidgetDef;
  /** Primary line on the suggestion card, e.g. "Rivian" or "Weather · Tokyo". */
  title: string;
  /** Secondary line, e.g. "Stock · RIVN". */
  subtitle: string;
  args: Record<string, unknown>;
  /** Tile label once pinned. */
  label: string;
  density: WidgetDensity;
  /** True → can be pinned in one tap. False → open the config form, prefilled. */
  ready: boolean;
  /** Prefill for the config form when not directly addable. */
  values?: Record<string, string>;
}

// --- Lookups ---------------------------------------------------------------

// Crypto names / tickers → the coin id the crypto_price tool understands.
const CRYPTO: Record<string, { coin: string; name: string }> = {
  bitcoin: { coin: 'bitcoin', name: 'Bitcoin' }, btc: { coin: 'bitcoin', name: 'Bitcoin' },
  ethereum: { coin: 'ethereum', name: 'Ethereum' }, eth: { coin: 'ethereum', name: 'Ethereum' },
  solana: { coin: 'solana', name: 'Solana' }, sol: { coin: 'solana', name: 'Solana' },
  cardano: { coin: 'cardano', name: 'Cardano' }, ada: { coin: 'cardano', name: 'Cardano' },
  dogecoin: { coin: 'dogecoin', name: 'Dogecoin' }, doge: { coin: 'dogecoin', name: 'Dogecoin' },
  xrp: { coin: 'ripple', name: 'XRP' }, ripple: { coin: 'ripple', name: 'XRP' },
  polkadot: { coin: 'polkadot', name: 'Polkadot' }, dot: { coin: 'polkadot', name: 'Polkadot' },
  chainlink: { coin: 'chainlink', name: 'Chainlink' }, link: { coin: 'chainlink', name: 'Chainlink' },
  litecoin: { coin: 'litecoin', name: 'Litecoin' }, ltc: { coin: 'litecoin', name: 'Litecoin' },
  avalanche: { coin: 'avalanche-2', name: 'Avalanche' }, avax: { coin: 'avalanche-2', name: 'Avalanche' },
  polygon: { coin: 'matic-network', name: 'Polygon' }, matic: { coin: 'matic-network', name: 'Polygon' },
  bnb: { coin: 'binancecoin', name: 'BNB' }
};

// Phrases that name a specific keyless/no-config tool directly.
const DIRECT_TOOLS: { match: RegExp; tool: string; title: string }[] = [
  { match: /\b(fear\s*(and|&)?\s*greed|sentiment)\b/, tool: 'get_market_sentiment', title: 'Fear & Greed' },
  { match: /\byield\s*curve\b/, tool: 'get_yield_curve', title: 'Yield curve' },
  { match: /\b(national\s*debt|debt\s*clock)\b/, tool: 'get_national_debt', title: 'US debt clock' },
  { match: /\b(cot|positioning)\b/, tool: 'get_cot_positioning', title: 'COT positioning' },
  { match: /\b(perp|funding\s*rate)/, tool: 'get_funding_rates', title: 'Perp funding' },
  { match: /\bstablecoin/, tool: 'get_stablecoins', title: 'Stablecoin watch' },
  { match: /\b(earnings)\b/, tool: 'get_earnings_calendar', title: 'Earnings calendar' },
  { match: /\b(econ(omic)?\s*calendar)\b/, tool: 'get_econ_calendar', title: 'Econ calendar' },
  { match: /\b(macro|cpi|inflation|unemployment|fed\s*funds)\b/, tool: 'show_macro_tiles', title: 'Macro indicators' },
  { match: /\b(ticker\s*tape|market\s*tape)\b/, tool: 'get_ticker_tape', title: 'Market tape' },
  { match: /\b(ask\s*ai|assistant)\b/, tool: 'ai_chat', title: 'Ask AI' }
];

// ISO 4217 codes we'll treat as a currency pair (kept to the ones people actually convert).
const CURRENCIES = new Set([
  'usd', 'eur', 'gbp', 'jpy', 'inr', 'cad', 'aud', 'chf', 'cny', 'hkd', 'sgd', 'nzd',
  'sek', 'nok', 'dkk', 'krw', 'mxn', 'brl', 'zar', 'rub', 'aed', 'sar', 'try', 'thb',
  'php', 'idr', 'pln', 'ils', 'twd', 'myr', 'czk', 'huf'
]);

const clean = (s: string) => s.trim().replace(/\s+/g, ' ');
const stripWords = (s: string, words: string[]) =>
  clean(s.replace(new RegExp(`\\b(${words.join('|')})\\b`, 'gi'), ' '));

const mk = (
  tool: string,
  title: string,
  subtitle: string,
  args: Record<string, unknown>,
  label: string,
  ready: boolean,
  values?: Record<string, string>
): WidgetSuggestion | null => {
  const def = WIDGET_BY_TOOL[tool];
  if (!def) return null;
  return { key: `${tool}:${title}`, def, title, subtitle, args, label: label.slice(0, 60), density: def.defaultDensity, ready, values };
};

// --- Resolver --------------------------------------------------------------

export const resolveWidgetIntent = (queryRaw: string): WidgetSuggestion[] => {
  const query = clean(queryRaw);
  if (!query) return [];
  const q = query.toLowerCase();
  const out: WidgetSuggestion[] = [];
  const seen = new Set<string>();
  const add = (s: WidgetSuggestion | null) => {
    if (!s || seen.has(s.key)) return;
    seen.add(s.key);
    out.push(s);
  };

  // 0) A pasted YouTube/Vimeo link → a playable embed tile.
  if (/^https?:\/\/\S+$/i.test(query) && isEmbeddableVideo(query)) {
    add(mk(EMBED_TILE, 'Embed this video', 'Plays on the board', { url: query }, 'Video', true));
  }

  // 1) Direct, no-config tools named outright.
  for (const d of DIRECT_TOOLS) {
    if (d.match.test(q)) {
      const def = WIDGET_BY_TOOL[d.tool];
      if (def) add(mk(d.tool, d.title, def.blurb, d.tool === 'show_macro_tiles' && def.presets?.[0] ? def.presets[0].args : {}, d.title, true));
    }
  }

  // 2) Currency: "usd to eur", "convert 100 gbp to inr", "usd/eur". Both sides must be
  //    real ISO codes and the separator a standalone word/symbol — so "business" (bus-in-ess)
  //    and "how to get" never look like an FX pair.
  const cur =
    q.match(/\b([a-z]{3})\s+(?:to|in)\s+([a-z]{3})\b/) ||
    q.match(/\b([a-z]{3})\s*(?:->|→|\/)\s*([a-z]{3})\b/);
  if (cur && CURRENCIES.has(cur[1]) && CURRENCIES.has(cur[2])) {
    const from = cur[1].toUpperCase();
    const to = cur[2].toUpperCase();
    const convert = /\bconvert|converter\b/.test(q);
    add(mk(convert ? 'convert_currency' : 'exchange_rate', `${from} → ${to}`, convert ? 'Currency converter' : 'Exchange rate', { from, to }, `${from} → ${to}`, true));
  }

  // 3) Compare: "compare X and Y", "X vs Y".
  const cmp = q.match(/\b(?:compare\s+)?(.+?)\s+(?:vs\.?|versus|and)\s+(.+)/);
  if (/\b(vs\.?|versus|compare)\b/.test(q) && cmp) {
    const syms = [cmp[1], cmp[2]]
      .map((p) => resolveStockSymbol(stripWords(p, ['stock', 'stocks', 'share', 'shares', 'price'])))
      .filter(Boolean) as { symbol: string; name: string }[];
    if (syms.length >= 2) {
      add(mk('compare_stocks', syms.map((s) => s.name).join(' vs '), 'Compare assets', { symbols: syms.map((s) => s.symbol) }, syms.map((s) => s.symbol).join(' vs '), true));
    }
  }

  // 4) Weather.
  if (/\b(weather|forecast|temperature)\b/.test(q)) {
    const loc = stripWords(q, ['weather', 'forecast', 'temperature', 'in', 'at', 'for', 'the', 'today', 'tomorrow']);
    if (loc) add(mk('get_weather', `Weather · ${title(loc)}`, 'Conditions + 5-day forecast', { location: loc }, `Weather · ${title(loc)}`, true));
    else add(mk('get_weather', 'Weather', 'Pick a location', {}, 'Weather', false, {}));
  }

  // 5) Crypto by name/ticker.
  const cryptoHit = CRYPTO[q] || (/(coin|crypto)$/.test(q) && CRYPTO[stripWords(q, ['coin', 'crypto', 'price'])]);
  if (cryptoHit) add(mk('crypto_price', cryptoHit.name, 'Crypto · price, cap, 24h', { coin: cryptoHit.coin }, cryptoHit.name, true));

  // 6) News.
  if (/\b(news|headlines|breaking)\b/.test(q)) {
    const topic = stripWords(q, ['news', 'headlines', 'breaking', 'latest', 'about', 'on', 'the']);
    const SECTIONS = ['world', 'business', 'technology', 'tech', 'science', 'sports', 'health'];
    const section = SECTIONS.find((s) => topic === s || topic === `${s} news`);
    if (section) {
      const t = section === 'tech' ? 'technology' : section;
      add(mk('get_news', `${title(t)} news`, 'Live headlines', { topic: t }, `${title(t)} news`, true));
    } else if (topic) {
      add(mk('get_news', `News · ${topic}`, 'Live headlines', { query: topic }, `News · ${topic}`, true));
    } else {
      add(mk('get_news', 'Top headlines', 'Live headlines', { topic: 'top' }, 'Top headlines', true));
    }
  }

  // 7) Places / map / directions.
  const dir = q.match(/\b(?:directions?\s+)?from\s+(.+?)\s+to\s+(.+)/);
  if (/\b(directions|route|how\s+to\s+get)\b/.test(q) && dir) {
    add(mk('get_directions', `${title(dir[1])} → ${title(dir[2])}`, 'Live route + ETA', { from: clean(dir[1]), to: clean(dir[2]) }, `${title(dir[1])} → ${title(dir[2])}`, true));
  }
  if (/\bmap\s+of\b|\bon\s+(a|the)\s+map\b/.test(q)) {
    const place = clean(q.replace(/\bmap\s+of\b|\bon\s+(a|the)\s+map\b/g, ' '));
    if (place) add(mk('show_map', `Map · ${title(place)}`, 'Pinned on a live map', { places: [place] }, `Map · ${title(place)}`, true));
  }
  if (/\b(restaurants?|coffee|cafe|cafes|food|ramen|sushi|bars?|places|near\s+me)\b/.test(q) && !/\bweather\b/.test(q)) {
    const near = q.match(/\bnear\s+(.+)/);
    const what = stripWords(near ? q.slice(0, q.indexOf('near')) : q, ['find', 'show', 'places']);
    if (what) add(mk('find_places', `Places · ${what}`, 'Restaurants, cafes, shops', near ? { query: what, near: clean(near[1]) } : { query: what }, `Places · ${what}`, true));
  }

  // 8) Video / how-to.
  if (/\b(video|videos|youtube|watch|how\s+to)\b/.test(q)) {
    const vq = stripWords(q, ['video', 'videos', 'youtube', 'watch', 'search', 'for']) || query;
    add(mk('video_search', `Videos · ${vq}`, 'Plays in place', { query: vq }, `Videos · ${vq}`, true));
  }

  // 9) Flight number.
  const flight = query.toUpperCase().match(/\b([A-Z]{2}\s?\d{1,4})\b/);
  if (flight && /\bflight\b/.test(q)) add(mk('get_flight_status', `Flight ${flight[1].replace(/\s/g, '')}`, 'Live status, gates, times', { flightNumber: flight[1].replace(/\s/g, '') }, `Flight ${flight[1].replace(/\s/g, '')}`, true));

  // 10) Stock / index / commodity by name or ticker (the "rivian" case).
  const sym = resolveStockSymbol(stripWords(q, ['stock', 'stocks', 'share', 'shares', 'price', 'quote', 'ticker']));
  if (sym && !/\b(news|weather|map|directions|video|crypto)\b/.test(q)) {
    add(mk('get_stock', sym.name, `Stock · ${sym.symbol}`, { symbol: sym.symbol }, sym.name, true));
  }

  // 11) Fallback: keyword search over the catalog (opens the config form).
  for (const def of searchWidgets(query).slice(0, 4)) {
    add(mk(def.tool, def.label, def.blurb, {}, def.label, def.fields.length === 0, {}));
  }

  return out.slice(0, 8);
};

const title = (s: string): string =>
  clean(s).replace(/\b\w/g, (c) => c.toUpperCase());

// Curated quick-pin starting points for the empty state.
export const quickPickSuggestions = (): WidgetSuggestion[] =>
  [
    mk('get_news', 'Top headlines', 'Live news', { topic: 'top' }, 'Top headlines', true),
    mk('get_stock', 'S&P 500', 'Stock · ^GSPC', { symbol: '^GSPC' }, 'S&P 500', true),
    mk('crypto_price', 'Bitcoin', 'Crypto · price', { coin: 'bitcoin' }, 'Bitcoin', true),
    mk('get_weather', 'Weather', 'Pick a location', {}, 'Weather', false, {}),
    mk('get_market_sentiment', 'Fear & Greed', 'Market mood', {}, 'Fear & Greed', true),
    mk('get_ticker_tape', 'Market tape', 'Live quotes', {}, 'Market tape', true)
  ].filter(Boolean) as WidgetSuggestion[];
