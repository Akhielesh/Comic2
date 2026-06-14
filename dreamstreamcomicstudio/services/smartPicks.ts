// Smart picks — context-relevant dashboard suggestions mined from the user's own
// data: their long-term chat memory and recent conversation titles. Each pick is a
// one-click dashboard tile (a whitelisted live-data tool call). Relevance over
// volume: a pick only surfaces when something in the user's data actually points
// at it. NO generic fallbacks — without real signal the row stays hidden.

import type { DashboardTile } from './customDashboards';

export interface SmartPick {
  /** Chip label, e.g. "NVDA stock" / "Weather · Tokyo". */
  label: string;
  /** Why this is suggested (shown as the chip tooltip), e.g. "from your memory". */
  reason: string;
  tile: Omit<DashboardTile, 'id'>;
}

// Common English words that look like tickers — never treat these as symbols.
const TICKER_STOPWORDS = new Set([
  'A', 'I', 'AM', 'AN', 'AS', 'AT', 'BE', 'BY', 'DO', 'GO', 'IF', 'IN', 'IS', 'IT', 'ME', 'MY',
  'NO', 'OF', 'OK', 'ON', 'OR', 'SO', 'TO', 'UP', 'US', 'WE', 'THE', 'AND', 'FOR', 'NOT', 'YOU',
  'ALL', 'NEW', 'CAN', 'GET', 'NOW', 'API', 'CEO', 'USA', 'USD', 'EUR', 'GBP', 'FAQ', 'PDF',
  'HTML', 'JSON', 'YAML', 'SQL', 'CSS', 'PLAN', 'TRIP', 'GOAL', 'NEWS', 'CHAT', 'CODE', 'LIVE'
]);

const dedupeKey = (t: Omit<DashboardTile, 'id'>): string => `${t.tool}:${JSON.stringify(t.args)}`;

/** $NVDA / "NVDA stock" / "stock NVDA" style ticker mentions. */
const mineTickers = (text: string): string[] => {
  const out = new Set<string>();
  for (const m of text.matchAll(/\$([A-Z]{1,5})\b/g)) out.add(m[1]);
  for (const m of text.matchAll(/\b([A-Z]{2,5})\s+(?:stock|shares|ticker|quote)\b/gi)) {
    const sym = m[1].toUpperCase();
    if (!TICKER_STOPWORDS.has(sym)) out.add(sym);
  }
  for (const m of text.matchAll(/\b(?:stock|shares|ticker|quote|track(?:ing)?)\s+([A-Z]{2,5})\b/g)) {
    const sym = m[1].toUpperCase();
    if (!TICKER_STOPWORDS.has(sym)) out.add(sym);
  }
  for (const m of text.matchAll(/\b(bitcoin|ethereum|btc|eth)\b/gi)) out.add(m[1].toLowerCase());
  return [...out].slice(0, 4);
};

/** "lives in Tokyo" / "trip to Lisbon" / "visiting Kyoto" style place mentions. */
const minePlaces = (text: string): string[] => {
  const out = new Set<string>();
  const re = /\b(?:lives? in|based in|located in|moving to|from|visiting|trip to|travel(?:ing|ling)? to|flying to|going to)[ \t]+([A-Z][a-zA-Z]+(?:[ ][A-Z][a-zA-Z]+)?)/g;
  for (const m of text.matchAll(re)) {
    const place = m[1].trim();
    // Skip sentence-start false positives ("from The…", "going to Be…").
    if (place.split(/\s+/).every((w) => w.length > 2)) out.add(place);
  }
  return [...out].slice(0, 3);
};

/** "interested in fusion" / "learning Spanish" / "building a comic app" topics. */
const mineTopics = (text: string): string[] => {
  const out = new Set<string>();
  const re = /\b(?:interested in|learning(?: about)?|following|researching|working on|building)\s+(?:a\s+|an\s+|the\s+)?([a-zA-Z][a-zA-Z0-9 -]{2,32}?)(?=[.,;\n)]|$| and | with | for )/gi;
  for (const m of text.matchAll(re)) {
    const topic = m[1].trim();
    if (topic && topic.split(/\s+/).length <= 4) out.add(topic);
  }
  return [...out].slice(0, 3);
};

const CRYPTO_IDS: Record<string, string> = { btc: 'bitcoin', bitcoin: 'bitcoin', eth: 'ethereum', ethereum: 'ethereum' };

/** Whole-name patterns that signal a throwaway/test board. */
const JUNK_NAME = /^(new (dash)?board|board|dashboard|abc+|xyz+|aaa+|zzz+|\d+|[a-z])$/i;
/** Leading tokens that signal a scratch board even with trailing words ("Test 123"). */
const JUNK_FIRST_WORD =
  /^(test\w*|testing|untitled|asdf\w*|qwerty\w*|temp\w*|tmp|foo|bar|baz|sample|demo|example|placeholder|xxx+)$/;

/** True when a dashboard name reads as a test/placeholder/gibberish board. */
export const isJunkDashboardName = (name?: string): boolean => {
  const n = (name || '').trim();
  if (!n) return false; // an empty name isn't junk; rely on other signal
  if (JUNK_NAME.test(n)) return true;
  const first = n.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, '');
  if (JUNK_FIRST_WORD.test(first)) return true;
  // A single low-information token with no vowels ("xkcd", "qwrt") reads as junk.
  return /^[a-z]{3,8}$/i.test(n) && !/[aeiou]/i.test(n);
};

/** Words inside a dashboard NAME that must never be mistaken for a place token. */
const NAME_NONPLACE = new Set([
  'Trip', 'Travel', 'Vacation', 'Holiday', 'Getaway', 'Visit', 'Tour', 'Itinerary', 'Plan', 'Planner',
  'My', 'The', 'Dashboard', 'Board', 'Pulse', 'Daily', 'Weekly', 'Market', 'Markets', 'News', 'Watch'
]);

/** Bare ALL-CAPS tickers in a SHORT deliberate board name (e.g. "NVDA & TSLA"). Safe
 *  here precisely because a board name is short and intentional, unlike free prose. */
const mineNameTickers = (name: string): string[] => {
  const out = new Set<string>();
  for (const m of name.matchAll(/\b([A-Z]{2,5})\b/g)) {
    const sym = m[1].toUpperCase();
    if (!TICKER_STOPWORDS.has(sym)) out.add(sym);
  }
  return [...out].slice(0, 4);
};

/** A place named in a travel-themed board ("Lisbon Trip", "Tokyo getaway"). */
const mineNamePlaces = (name: string): string[] => {
  if (!/\b(trip|travel|vacation|holiday|getaway|visit|tour|itinerary|weekend)\b/i.test(name)) return [];
  const out = new Set<string>();
  for (const m of name.matchAll(/\b([A-Z][a-z]{2,})\b/g)) if (!NAME_NONPLACE.has(m[1])) out.add(m[1]);
  return [...out].slice(0, 2);
};

/** The coarse category a tile/pick belongs to — used to bias picks toward the board's
 *  established theme (a finance board surfaces tickers first; a travel board, places). */
type PickCategory = 'finance' | 'travel' | 'news' | 'other';
const toolCategory = (tool: string): PickCategory => {
  if (tool === 'get_stock' || tool === 'crypto_price' || tool.startsWith('get_market')) return 'finance';
  if (tool === 'get_weather' || tool === 'get_directions' || tool === 'get_places') return 'travel';
  if (tool === 'get_news') return 'news';
  return 'other';
};

/** Extra context that sharpens picks: the board's own name + the widgets already on it. */
export interface SmartPickContext {
  dashboardName?: string;
  tiles?: Array<{ tool: string; label?: string; args?: Record<string, unknown> }>;
}

/**
 * Derive smart dashboard picks from the board's own intent (its NAME), the widgets
 * already on it, and the user's memory + recent chat titles — in that priority order.
 * `existingKeys` (tool:args of pinned tiles) suppresses duplicates. A test/placeholder
 * board name suppresses picks entirely (no random suggestions on a throwaway board).
 */
export const deriveSmartPicks = (
  memory: string,
  sessionTitles: string[],
  existingKeys: Set<string> = new Set(),
  context: SmartPickContext = {}
): SmartPick[] => {
  const name = (context.dashboardName || '').trim();
  // Don't pollute a test/scratch board with suggestions.
  if (isJunkDashboardName(name)) return [];

  const picks: SmartPick[] = [];
  const seen = new Set(existingKeys);
  const push = (pick: SmartPick) => {
    const key = dedupeKey(pick.tile);
    if (seen.has(key)) return;
    seen.add(key);
    picks.push(pick);
  };

  const stockPick = (sym: string, reason: string) => {
    const crypto = CRYPTO_IDS[sym.toLowerCase()];
    if (crypto) {
      const label = crypto === 'bitcoin' ? 'Bitcoin' : 'Ethereum';
      push({ label: `${label} price`, reason, tile: { tool: 'crypto_price', args: { coin: crypto }, label, density: 'compact' } });
    } else {
      push({ label: `${sym} stock`, reason, tile: { tool: 'get_stock', args: { symbol: sym }, label: sym, density: 'compact' } });
    }
  };
  const placePick = (place: string, reason: string) =>
    push({ label: `Weather · ${place}`, reason, tile: { tool: 'get_weather', args: { location: place }, label: place, density: 'compact' } });
  const topicPick = (topic: string, reason: string) =>
    push({ label: `News · ${topic}`, reason, tile: { tool: 'get_news', args: { query: topic }, label: topic, density: 'compact' } });

  // 1) The board's NAME is the strongest intent signal — mine it first.
  if (name) {
    for (const sym of mineNameTickers(name)) stockPick(sym, "from this dashboard's name");
    for (const place of mineNamePlaces(name)) placePick(place, "from this dashboard's name");
    for (const sym of mineTickers(name)) stockPick(sym, "from this dashboard's name");
    for (const place of minePlaces(name)) placePick(place, "from this dashboard's name");
  }

  // 2) Then the user's broader context (memory + recent chats).
  const corpus = `${memory}\n${sessionTitles.join('\n')}`;
  for (const sym of mineTickers(corpus)) stockPick(sym, 'mentioned in your chats');
  for (const place of minePlaces(corpus)) placePick(place, 'a place from your chats');
  for (const topic of mineTopics(corpus)) topicPick(topic, 'a topic you follow');

  // 3) Bias toward the board's established theme: picks matching a category already on
  //    the board float to the top (stable), so a finance board leads with tickers, a
  //    travel board with places — relevance over a flat mined list.
  const boardCats = new Set<PickCategory>((context.tiles ?? []).map((t) => toolCategory(t.tool)).filter((c) => c !== 'other'));
  if (boardCats.size > 0) {
    picks.sort((a, b) => {
      const am = boardCats.has(toolCategory(a.tile.tool)) ? 0 : 1;
      const bm = boardCats.has(toolCategory(b.tile.tool)) ? 0 : 1;
      return am - bm;
    });
  }

  // NO generic fallbacks: picks must come from the user's own context (board name,
  // widgets, memory, chats). When there isn't enough signal the row simply doesn't
  // render — a canned "Top headlines / S&P 500" suggestion is noise, not personalization.
  return picks.slice(0, 6);
};

export const tileKey = dedupeKey;
