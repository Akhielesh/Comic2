// symbolResolve — turn a human phrase ("rivian", "s&p 500", "gold", "AAPL") into a
// tradable symbol the stock tool understands. Standalone (no widget/catalog deps) so it
// can be shared by the intent resolver, the widget catalog's field builder, and the
// dashboard command grammar without an import cycle.

export interface ResolvedSymbol {
  symbol: string;
  name: string;
}

// Popular company / fund names → ticker. Keyed by lowercase name and common aliases.
// Broad on the household names people actually type; anything missing still passes
// through (a bare ticker, or the server's own alias table).
const COMPANY: Record<string, ResolvedSymbol> = {
  apple: { symbol: 'AAPL', name: 'Apple' },
  microsoft: { symbol: 'MSFT', name: 'Microsoft' },
  nvidia: { symbol: 'NVDA', name: 'NVIDIA' },
  amazon: { symbol: 'AMZN', name: 'Amazon' },
  google: { symbol: 'GOOGL', name: 'Alphabet (Google)' },
  alphabet: { symbol: 'GOOGL', name: 'Alphabet (Google)' },
  meta: { symbol: 'META', name: 'Meta' },
  facebook: { symbol: 'META', name: 'Meta' },
  tesla: { symbol: 'TSLA', name: 'Tesla' },
  rivian: { symbol: 'RIVN', name: 'Rivian' },
  lucid: { symbol: 'LCID', name: 'Lucid' },
  netflix: { symbol: 'NFLX', name: 'Netflix' },
  disney: { symbol: 'DIS', name: 'Disney' },
  amd: { symbol: 'AMD', name: 'AMD' },
  intel: { symbol: 'INTC', name: 'Intel' },
  broadcom: { symbol: 'AVGO', name: 'Broadcom' },
  qualcomm: { symbol: 'QCOM', name: 'Qualcomm' },
  micron: { symbol: 'MU', name: 'Micron' },
  palantir: { symbol: 'PLTR', name: 'Palantir' },
  oracle: { symbol: 'ORCL', name: 'Oracle' },
  salesforce: { symbol: 'CRM', name: 'Salesforce' },
  adobe: { symbol: 'ADBE', name: 'Adobe' },
  uber: { symbol: 'UBER', name: 'Uber' },
  lyft: { symbol: 'LYFT', name: 'Lyft' },
  airbnb: { symbol: 'ABNB', name: 'Airbnb' },
  coinbase: { symbol: 'COIN', name: 'Coinbase' },
  robinhood: { symbol: 'HOOD', name: 'Robinhood' },
  paypal: { symbol: 'PYPL', name: 'PayPal' },
  visa: { symbol: 'V', name: 'Visa' },
  mastercard: { symbol: 'MA', name: 'Mastercard' },
  walmart: { symbol: 'WMT', name: 'Walmart' },
  costco: { symbol: 'COST', name: 'Costco' },
  target: { symbol: 'TGT', name: 'Target' },
  starbucks: { symbol: 'SBUX', name: 'Starbucks' },
  mcdonalds: { symbol: 'MCD', name: "McDonald's" },
  nike: { symbol: 'NKE', name: 'Nike' },
  boeing: { symbol: 'BA', name: 'Boeing' },
  ford: { symbol: 'F', name: 'Ford' },
  gm: { symbol: 'GM', name: 'General Motors' },
  'general motors': { symbol: 'GM', name: 'General Motors' },
  jpmorgan: { symbol: 'JPM', name: 'JPMorgan' },
  'jp morgan': { symbol: 'JPM', name: 'JPMorgan' },
  goldman: { symbol: 'GS', name: 'Goldman Sachs' },
  'goldman sachs': { symbol: 'GS', name: 'Goldman Sachs' },
  'bank of america': { symbol: 'BAC', name: 'Bank of America' },
  berkshire: { symbol: 'BRK-B', name: 'Berkshire Hathaway' },
  exxon: { symbol: 'XOM', name: 'ExxonMobil' },
  chevron: { symbol: 'CVX', name: 'Chevron' },
  pfizer: { symbol: 'PFE', name: 'Pfizer' },
  moderna: { symbol: 'MRNA', name: 'Moderna' },
  'eli lilly': { symbol: 'LLY', name: 'Eli Lilly' },
  'johnson & johnson': { symbol: 'JNJ', name: 'Johnson & Johnson' },
  unitedhealth: { symbol: 'UNH', name: 'UnitedHealth' },
  spotify: { symbol: 'SPOT', name: 'Spotify' },
  snowflake: { symbol: 'SNOW', name: 'Snowflake' },
  shopify: { symbol: 'SHOP', name: 'Shopify' },
  block: { symbol: 'XYZ', name: 'Block' },
  snap: { symbol: 'SNAP', name: 'Snap' },
  pinterest: { symbol: 'PINS', name: 'Pinterest' },
  reddit: { symbol: 'RDDT', name: 'Reddit' },
  arm: { symbol: 'ARM', name: 'Arm Holdings' },
  'super micro': { symbol: 'SMCI', name: 'Super Micro' },
  supermicro: { symbol: 'SMCI', name: 'Super Micro' },
  dell: { symbol: 'DELL', name: 'Dell' },
  ibm: { symbol: 'IBM', name: 'IBM' },
  cisco: { symbol: 'CSCO', name: 'Cisco' }
};

const INDEX: Record<string, ResolvedSymbol> = {
  's&p': { symbol: '^GSPC', name: 'S&P 500' },
  's&p 500': { symbol: '^GSPC', name: 'S&P 500' },
  'sp500': { symbol: '^GSPC', name: 'S&P 500' },
  'spx': { symbol: '^GSPC', name: 'S&P 500' },
  nasdaq: { symbol: '^IXIC', name: 'Nasdaq Composite' },
  'dow': { symbol: '^DJI', name: 'Dow Jones' },
  'dow jones': { symbol: '^DJI', name: 'Dow Jones' },
  russell: { symbol: '^RUT', name: 'Russell 2000' },
  vix: { symbol: '^VIX', name: 'VIX' },
  ftse: { symbol: '^FTSE', name: 'FTSE 100' },
  nikkei: { symbol: '^N225', name: 'Nikkei 225' }
};

const COMMODITY: Record<string, ResolvedSymbol> = {
  gold: { symbol: 'gold', name: 'Gold' },
  silver: { symbol: 'silver', name: 'Silver' },
  oil: { symbol: 'crude oil', name: 'Crude oil' },
  'crude oil': { symbol: 'crude oil', name: 'Crude oil' },
  crude: { symbol: 'crude oil', name: 'Crude oil' },
  'natural gas': { symbol: 'NG=F', name: 'Natural gas' },
  copper: { symbol: 'HG=F', name: 'Copper' },
  platinum: { symbol: 'PL=F', name: 'Platinum' }
};

const STOP = new Set(['the', 'a', 'an', 'to', 'in', 'of', 'on', 'for', 'and', 'or', 'is', 'it', 'my', 'me', 'add']);

const looksLikeTicker = (w: string) => /^[A-Za-z]{1,5}([.-][A-Za-z]{1,2})?$/.test(w);

/**
 * Resolve a phrase to a tradable symbol via the name maps, else accept a bare ticker.
 * Returns null when the phrase isn't a recognizable single asset.
 */
export const resolveStockSymbol = (raw: string): ResolvedSymbol | null => {
  const k = (raw || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!k) return null;
  if (COMPANY[k]) return COMPANY[k];
  if (INDEX[k]) return INDEX[k];
  if (COMMODITY[k]) return COMMODITY[k];
  if (!STOP.has(k) && looksLikeTicker(k)) return { symbol: k.toUpperCase(), name: k.toUpperCase() };
  return null;
};

/** Best-effort symbol for a free-typed field: resolved ticker, else the raw text as-is
 *  (so "^GSPC", "BTC-USD", "gold" and server-side aliases still pass straight through). */
export const coerceSymbol = (raw: string): string => resolveStockSymbol(raw)?.symbol ?? raw.trim();
