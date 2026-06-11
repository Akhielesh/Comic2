// Smart picks — context-relevant dashboard suggestions mined from the user's own
// data: their long-term chat memory and recent conversation titles. Each pick is a
// one-click dashboard tile (a whitelisted live-data tool call). Relevance over
// volume: only surface a pick when something in the user's data actually points at
// it; generic fallbacks (local weather, top news, S&P 500) fill in only when the
// mined picks run thin.

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

const timezoneCity = (): string | null => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const city = tz.split('/').pop()?.replace(/_/g, ' ').trim();
    if (city && !/^(UTC|GMT|Etc)/i.test(city)) return city;
  } catch {
    /* fall through */
  }
  return null;
};

/**
 * Derive smart dashboard picks from the user's memory text and recent chat titles.
 * `existingKeys` (tool:args of tiles already pinned) suppresses duplicates.
 */
export const deriveSmartPicks = (
  memory: string,
  sessionTitles: string[],
  existingKeys: Set<string> = new Set()
): SmartPick[] => {
  const corpus = `${memory}\n${sessionTitles.join('\n')}`;
  const picks: SmartPick[] = [];
  const seen = new Set(existingKeys);
  const push = (pick: SmartPick) => {
    const key = dedupeKey(pick.tile);
    if (seen.has(key)) return;
    seen.add(key);
    picks.push(pick);
  };

  for (const sym of mineTickers(corpus)) {
    const crypto = CRYPTO_IDS[sym.toLowerCase()];
    if (crypto) {
      push({
        label: `${crypto === 'bitcoin' ? 'Bitcoin' : 'Ethereum'} price`,
        reason: 'mentioned in your chats',
        tile: { tool: 'crypto_price', args: { coin: crypto }, label: crypto === 'bitcoin' ? 'Bitcoin' : 'Ethereum', density: 'compact' }
      });
    } else {
      push({
        label: `${sym} stock`,
        reason: 'mentioned in your chats',
        tile: { tool: 'get_stock', args: { symbol: sym }, label: sym, density: 'compact' }
      });
    }
  }

  for (const place of minePlaces(corpus)) {
    push({
      label: `Weather · ${place}`,
      reason: 'a place from your chats',
      tile: { tool: 'get_weather', args: { location: place }, label: place, density: 'compact' }
    });
  }

  for (const topic of mineTopics(corpus)) {
    push({
      label: `News · ${topic}`,
      reason: 'a topic you follow',
      tile: { tool: 'get_news', args: { query: topic }, label: topic, density: 'compact' }
    });
  }

  // Fallbacks only when the mined picks run thin — keep the row useful on day one.
  if (picks.length < 3) {
    const city = timezoneCity();
    if (city) {
      push({
        label: `Weather · ${city}`,
        reason: 'your timezone',
        tile: { tool: 'get_weather', args: { location: city }, label: city, density: 'compact' }
      });
    }
    push({
      label: 'Top headlines',
      reason: 'daily pulse',
      tile: { tool: 'get_news', args: { topic: 'top' }, label: 'Top headlines', density: 'compact' }
    });
    push({
      label: 'S&P 500',
      reason: 'market pulse',
      tile: { tool: 'get_stock', args: { symbol: '^GSPC' }, label: 'S&P 500', density: 'compact' }
    });
  }

  return picks.slice(0, 6);
};

export const tileKey = dedupeKey;
