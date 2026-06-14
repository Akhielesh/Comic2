// The complete dashboard widget catalog — EVERY refreshable live-data tool the
// platform has, addable from the board's "Add widget" gallery (enforced by
// widgetCatalog.coverage.test.ts against REFRESHABLE_TOOLS, the same way the
// component gallery is enforced for artifact renderers).
//
// Each entry declares its category, an icon + blurb for the picker, the small
// form fields needed to configure it (shared by the add panel and the tile's
// in-place editor), one-tap presets, and an honest `note` when live data needs
// an optional key or AI-provided context.

import {
  ArrowRightLeft, Banknote, Bitcoin, CalendarClock, CalendarRange, CandlestickChart, Clapperboard,
  CloudSun, Coins, Gauge, Landmark, LineChart, Map as MapIcon, MapPin, MessageCircle, Navigation,
  Newspaper, PiggyBank, Plane, Route, Scale, Sparkles, TrendingUp
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { WidgetDensity } from './artifacts/kit';
import type { DashboardTile } from '../../services/customDashboards';
import { coerceSymbol } from '../../services/symbolResolve';

// 'ai_chat' is a special tile: a mini assistant box on the board (no live-data tool).
export const AI_CHAT_TILE = 'ai_chat';

export type WidgetCategory = 'Essentials' | 'Markets' | 'Crypto' | 'Travel & places' | 'Calendars & more';

export const WIDGET_CATEGORIES: WidgetCategory[] = ['Essentials', 'Markets', 'Crypto', 'Travel & places', 'Calendars & more'];

export interface WidgetField {
  key: string;
  label: string;
  placeholder?: string;
  optional?: boolean;
  /** Comma-separated input stored as string[] in args. */
  list?: boolean;
  /** Renders a <select> instead of a text input. */
  select?: { value: string; label: string }[];
  default?: string;
}

export interface WidgetPreset {
  label: string;
  args: Record<string, unknown>;
  tileLabel?: string;
}

export interface WidgetDef {
  tool: string;
  label: string;
  icon: LucideIcon;
  blurb: string;
  category: WidgetCategory;
  defaultDensity: WidgetDensity;
  /** Config fields ([] = add instantly with `{}` args). */
  fields: WidgetField[];
  /** One-tap starting points shown above the fields. */
  presets?: WidgetPreset[];
  /** Honest caveat (optional key, AI-provided data…) shown in the picker. */
  note?: string;
}

export const WIDGET_CATALOG: WidgetDef[] = [
  // ----------------------------------------------------------- Essentials ----
  {
    tool: AI_CHAT_TILE,
    label: 'Ask AI',
    icon: MessageCircle,
    blurb: 'A mini chat box right on the board',
    category: 'Essentials',
    defaultDensity: 'detailed',
    fields: []
  },
  {
    tool: 'get_news',
    label: 'News',
    icon: Newspaper,
    blurb: 'Live headlines with an in-board reader',
    category: 'Essentials',
    defaultDensity: 'detailed',
    fields: [
      {
        key: 'topic',
        label: 'Section',
        select: [
          { value: 'top', label: 'Top stories' },
          { value: 'world', label: 'World' },
          { value: 'business', label: 'Business' },
          { value: 'technology', label: 'Technology' },
          { value: 'science', label: 'Science' },
          { value: 'sports', label: 'Sports' },
          { value: 'health', label: 'Health' }
        ],
        default: 'top',
        optional: true
      },
      { key: 'query', label: 'Or a topic search', placeholder: 'e.g. “AI chips” (overrides section)', optional: true }
    ],
    presets: [
      { label: 'Breaking now', args: { query: 'breaking news' }, tileLabel: 'Breaking news' },
      { label: 'Top stories', args: { topic: 'top' }, tileLabel: 'Top headlines' },
      { label: 'Business', args: { topic: 'business' }, tileLabel: 'Business news' },
      { label: 'Tech', args: { topic: 'technology' }, tileLabel: 'Tech news' }
    ]
  },
  {
    tool: 'get_weather',
    label: 'Weather',
    icon: CloudSun,
    blurb: 'Conditions + 5-day forecast',
    category: 'Essentials',
    defaultDensity: 'detailed',
    fields: [{ key: 'location', label: 'Location', placeholder: 'City or place — e.g. Tokyo or Austin, TX' }]
  },
  {
    tool: 'get_stock',
    label: 'Stock & commodities',
    icon: LineChart,
    blurb: 'Stocks, indices, gold, oil, FX pairs',
    category: 'Essentials',
    defaultDensity: 'compact',
    fields: [{ key: 'symbol', label: 'Symbol or asset', placeholder: 'AAPL, ^GSPC, gold, BTC-USD…' }],
    presets: [
      { label: 'S&P 500', args: { symbol: '^GSPC' } },
      { label: 'NVDA', args: { symbol: 'NVDA' } },
      { label: 'Gold', args: { symbol: 'gold' } },
      { label: 'Crude oil', args: { symbol: 'crude oil' } }
    ]
  },
  {
    tool: 'video_search',
    label: 'Videos',
    icon: Clapperboard,
    blurb: 'Tutorials, reviews and clips — plays in place',
    category: 'Essentials',
    defaultDensity: 'detailed',
    fields: [{ key: 'query', label: 'Search videos for', placeholder: 'how to make croissants…' }]
  },
  // -------------------------------------------------------------- Markets ----
  {
    tool: 'get_ticker_tape',
    label: 'Market tape',
    icon: CandlestickChart,
    blurb: 'A scrolling tape of live quotes',
    category: 'Markets',
    defaultDensity: 'detailed',
    fields: [{ key: 'symbols', label: 'Symbols (comma-separated)', placeholder: 'Blank = major indices', list: true, optional: true }],
    presets: [
      { label: 'Major indices', args: {}, tileLabel: 'Market tape' },
      { label: 'Metals & energy', args: { symbols: ['GC=F', 'SI=F', 'HG=F', 'PL=F', 'CL=F', 'NG=F'] }, tileLabel: 'Metals & energy' },
      { label: 'Crypto majors', args: { symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD'] }, tileLabel: 'Crypto tape' },
      { label: 'Big tech', args: { symbols: ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META'] }, tileLabel: 'Big tech' }
    ]
  },
  {
    tool: 'compare_stocks',
    label: 'Compare assets',
    icon: LineChart,
    blurb: 'Overlay 2–6 stocks, commodities or crypto on one trend chart',
    category: 'Markets',
    defaultDensity: 'detailed',
    fields: [{ key: 'symbols', label: 'Symbols to compare (comma-separated)', placeholder: 'AAPL, TSLA, NVDA', list: true }],
    presets: [
      { label: 'Big tech', args: { symbols: ['AAPL', 'MSFT', 'NVDA', 'GOOGL'] }, tileLabel: 'Big tech' },
      { label: 'Gold · oil · S&P', args: { symbols: ['GC=F', 'CL=F', '^GSPC'] }, tileLabel: 'Gold · oil · S&P' },
      { label: 'AI chips', args: { symbols: ['NVDA', 'AMD', 'INTC'] }, tileLabel: 'AI chips' },
      { label: 'Crypto majors', args: { symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD'] }, tileLabel: 'Crypto' }
    ]
  },
  {
    tool: 'get_market_sentiment',
    label: 'Fear & Greed',
    icon: Gauge,
    blurb: 'Live sentiment gauges for stocks and crypto',
    category: 'Markets',
    defaultDensity: 'compact',
    fields: [
      {
        key: 'market',
        label: 'Market',
        select: [
          { value: 'both', label: 'Stocks + crypto' },
          { value: 'stocks', label: 'Stocks' },
          { value: 'crypto', label: 'Crypto' }
        ],
        default: 'both'
      }
    ]
  },
  {
    tool: 'get_yield_curve',
    label: 'Yield curve',
    icon: TrendingUp,
    blurb: 'Live US Treasury curve + inversion flag',
    category: 'Markets',
    defaultDensity: 'compact',
    fields: []
  },
  {
    tool: 'get_cot_positioning',
    label: 'COT positioning',
    icon: Scale,
    blurb: 'How speculators are positioned (CFTC)',
    category: 'Markets',
    defaultDensity: 'compact',
    fields: []
  },
  {
    tool: 'get_national_debt',
    label: 'US debt clock',
    icon: Landmark,
    blurb: 'The national debt, ticking live',
    category: 'Markets',
    defaultDensity: 'compact',
    fields: []
  },
  {
    tool: 'exchange_rate',
    label: 'Exchange rate',
    icon: ArrowRightLeft,
    blurb: 'Live fiat FX rate (ECB)',
    category: 'Markets',
    defaultDensity: 'compact',
    fields: [
      { key: 'from', label: 'From', placeholder: 'USD' },
      { key: 'to', label: 'To', placeholder: 'EUR' }
    ]
  },
  {
    tool: 'convert_currency',
    label: 'Currency converter',
    icon: Banknote,
    blurb: 'Interactive converter with a 30-day trend',
    category: 'Markets',
    defaultDensity: 'detailed',
    fields: [
      { key: 'from', label: 'From', placeholder: 'USD' },
      { key: 'to', label: 'To', placeholder: 'INR' }
    ]
  },
  {
    tool: 'build_portfolio',
    label: 'Watchlist / portfolio',
    icon: PiggyBank,
    blurb: 'Live-priced watchlist of your symbols',
    category: 'Markets',
    defaultDensity: 'detailed',
    fields: [{ key: 'holdings', label: 'Symbols (comma-separated)', placeholder: 'AAPL, NVDA, BTC-USD', list: true }],
    note: 'For share counts and P&L, build it from a chat and pin it.'
  },
  {
    tool: 'get_predictions',
    label: 'Prediction markets',
    icon: Sparkles,
    blurb: 'Live Polymarket odds on big events',
    category: 'Markets',
    defaultDensity: 'compact',
    fields: [{ key: 'query', label: 'Topic (optional)', placeholder: 'election, fed, bitcoin… blank = top markets', optional: true }]
  },
  {
    tool: 'show_macro_tiles',
    label: 'Macro indicators',
    icon: Gauge,
    blurb: 'CPI, unemployment, Fed funds and more',
    category: 'Markets',
    defaultDensity: 'detailed',
    fields: [],
    presets: [
      {
        label: 'US core set',
        args: {
          tiles: [
            { label: 'CPI (YoY)', seriesId: 'CPIAUCSL', unit: '%' },
            { label: 'Unemployment', seriesId: 'UNRATE', unit: '%' },
            { label: 'Fed funds', seriesId: 'FEDFUNDS', unit: '%' },
            { label: '30Y mortgage', seriesId: 'MORTGAGE30US', unit: '%' }
          ]
        },
        tileLabel: 'US indicators'
      }
    ],
    note: 'Live values need a (free) FRED key on the server.'
  },
  // --------------------------------------------------------------- Crypto ----
  {
    tool: 'crypto_price',
    label: 'Crypto price',
    icon: Bitcoin,
    blurb: 'Price, market cap and 24h change',
    category: 'Crypto',
    defaultDensity: 'compact',
    fields: [{ key: 'coin', label: 'Coin', placeholder: 'bitcoin, ethereum, solana…' }],
    presets: [
      { label: 'Bitcoin', args: { coin: 'bitcoin' } },
      { label: 'Ethereum', args: { coin: 'ethereum' } },
      { label: 'Solana', args: { coin: 'solana' } }
    ]
  },
  {
    tool: 'get_funding_rates',
    label: 'Perp funding',
    icon: Coins,
    blurb: 'Where leveraged crypto traders lean',
    category: 'Crypto',
    defaultDensity: 'compact',
    fields: []
  },
  {
    tool: 'get_stablecoins',
    label: 'Stablecoin watch',
    icon: Coins,
    blurb: 'Peg health of the big stablecoins',
    category: 'Crypto',
    defaultDensity: 'compact',
    fields: []
  },
  // ------------------------------------------------------ Travel & places ----
  {
    tool: 'find_places',
    label: 'Places',
    icon: MapPin,
    blurb: 'Restaurants, cafes, shops — or a specific spot by name',
    category: 'Travel & places',
    defaultDensity: 'detailed',
    fields: [
      { key: 'query', label: 'What to find', placeholder: 'coffee, ramen — or “mezeh”' },
      { key: 'near', label: 'Near', placeholder: 'Blank = my location', optional: true }
    ]
  },
  {
    tool: 'show_map',
    label: 'Map',
    icon: MapIcon,
    blurb: 'Pinned locations on a live map',
    category: 'Travel & places',
    defaultDensity: 'detailed',
    fields: [{ key: 'places', label: 'Places (comma-separated)', placeholder: 'Eiffel Tower, Louvre, Notre-Dame', list: true }]
  },
  {
    tool: 'get_directions',
    label: 'Directions',
    icon: Route,
    blurb: 'Drive / walk / bike routes with live ETAs',
    category: 'Travel & places',
    defaultDensity: 'detailed',
    fields: [
      { key: 'from', label: 'From', placeholder: 'Home, an address, a landmark…' },
      { key: 'to', label: 'To', placeholder: 'Where to?' }
    ]
  },
  {
    tool: 'get_flight_status',
    label: 'Flight status',
    icon: Plane,
    blurb: 'A flight’s live phase, gates and times',
    category: 'Travel & places',
    defaultDensity: 'compact',
    fields: [{ key: 'flightNumber', label: 'Flight number', placeholder: 'UA2402' }],
    note: 'Live tracking depends on provider availability.'
  },
  // --------------------------------------------------- Calendars & more ----
  {
    tool: 'get_econ_calendar',
    label: 'Econ calendar',
    icon: CalendarRange,
    blurb: 'Upcoming CPI, jobs and Fed releases',
    category: 'Calendars & more',
    defaultDensity: 'compact',
    fields: [],
    note: 'Live events need a (free) Finnhub key on the server.'
  },
  {
    tool: 'get_earnings_calendar',
    label: 'Earnings calendar',
    icon: CalendarClock,
    blurb: 'Who reports earnings, and when',
    category: 'Calendars & more',
    defaultDensity: 'compact',
    fields: [],
    note: 'Live events need a (free) Finnhub key on the server.'
  }
];

export const WIDGET_BY_TOOL: Record<string, WidgetDef> = Object.fromEntries(WIDGET_CATALOG.map((w) => [w.tool, w]));

export const TOOL_LABELS: Record<string, string> = Object.fromEntries(WIDGET_CATALOG.map((w) => [w.tool, w.label]));

/** Case-insensitive picker search across label, blurb, tool id and category. */
export const searchWidgets = (term: string): WidgetDef[] => {
  const q = term.trim().toLowerCase();
  if (!q) return WIDGET_CATALOG;
  return WIDGET_CATALOG.filter((w) =>
    [w.label, w.blurb, w.tool, w.category].some((s) => s.toLowerCase().includes(q))
  );
};

/** Build tile args + label from the def's field values; null while invalid. */
export const buildTileFromFields = (
  def: WidgetDef,
  values: Record<string, string>,
  density: WidgetDensity
): Omit<DashboardTile, 'id'> | null => {
  const args: Record<string, unknown> = {};
  const labelParts: string[] = [];
  for (const f of def.fields) {
    const raw = (values[f.key] ?? f.default ?? '').trim();
    if (!raw) {
      if (!f.optional) return null;
      continue;
    }
    if (f.list) {
      const items = raw.split(',').map((p) => p.trim()).filter(Boolean);
      if (!items.length) {
        if (!f.optional) return null;
        continue;
      }
      // build_portfolio expects holdings as [{ symbol }] watch-only entries.
      args[f.key] = def.tool === 'build_portfolio' ? items.map((symbol) => ({ symbol: symbol.toUpperCase() })) : items;
      labelParts.push(items.join(', '));
    } else {
      args[f.key] = raw;
      if (!f.select) labelParts.push(raw);
    }
  }
  // get_stock: accept a company name typed straight into the field ("rivian" → RIVN),
  // so the symbol box is forgiving instead of erroring on anything but an exact ticker.
  if (def.tool === 'get_stock' && typeof args.symbol === 'string') args.symbol = coerceSymbol(args.symbol);
  // get_news: a query overrides the section; drop the topic so the card is honest.
  if (def.tool === 'get_news' && typeof args.query === 'string' && args.query) delete args.topic;
  // show_macro_tiles requires a tile list — only its presets can add it.
  if (def.tool === 'show_macro_tiles' && !Object.keys(args).length) return null;
  const label = labelParts.length ? labelParts.slice(0, 2).join(' · ') : def.label;
  return { tool: def.tool, args, label: label.slice(0, 60), density };
};
