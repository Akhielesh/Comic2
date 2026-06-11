// Custom Dashboards — localStorage-backed store for user-built live dashboards.
//
// A dashboard is a named collection of widget tiles. Each tile pins ONE
// whitelisted live-data tool call (REFRESHABLE_TOOLS in apiTypes.ts); the view
// re-executes it via services/chatApi.refreshArtifact() and renders the result
// with the same artifact cards the chat uses. Pure client-side state — same
// pattern as services/mcpServers.ts (local list + change event).

export interface DashboardTile {
  id: string;
  /** Whitelisted live-data tool, e.g. 'get_stock' (see REFRESHABLE_TOOLS). */
  tool: string;
  /** Arguments for the tool call (e.g. { symbol: 'AAPL' }). */
  args: Record<string, unknown>;
  /** Friendly label shown in loading/error states ("AAPL", "Business news"). */
  label?: string;
  /** Which version of the widget card to render. */
  density: 'compact' | 'detailed';
}

export interface CustomDashboard {
  id: string;
  name: string;
  /** Small emoji shown next to the name in the switcher. */
  icon?: string;
  tiles: DashboardTile[];
  createdAt: string;
  /** Locked = view-only pulse mode: tile toolbars hidden, no move/remove/add. */
  locked?: boolean;
}

/** A starter dashboard offered by the empty state's "Start from template". */
export interface DashboardTemplate {
  id: string;
  name: string;
  icon: string;
  description: string;
  tiles: Array<Omit<DashboardTile, 'id'>>;
}

const STORAGE = 'ds.dashboards.v1';
export const DASHBOARDS_CHANGED = 'dreamstream:dashboards-changed';

const isDensity = (v: unknown): v is DashboardTile['density'] => v === 'compact' || v === 'detailed';

const sanitizeTile = (t: unknown): DashboardTile | null => {
  if (!t || typeof t !== 'object') return null;
  const tile = t as Partial<DashboardTile>;
  if (typeof tile.id !== 'string' || !tile.id || typeof tile.tool !== 'string' || !tile.tool) return null;
  return {
    id: tile.id,
    tool: tile.tool,
    args: tile.args && typeof tile.args === 'object' && !Array.isArray(tile.args) ? (tile.args as Record<string, unknown>) : {},
    ...(typeof tile.label === 'string' && tile.label ? { label: tile.label } : {}),
    density: isDensity(tile.density) ? tile.density : 'detailed'
  };
};

const sanitizeDashboard = (d: unknown): CustomDashboard | null => {
  if (!d || typeof d !== 'object') return null;
  const dash = d as Partial<CustomDashboard>;
  if (typeof dash.id !== 'string' || !dash.id || typeof dash.name !== 'string' || !dash.name) return null;
  return {
    id: dash.id,
    name: dash.name,
    ...(typeof dash.icon === 'string' && dash.icon ? { icon: dash.icon } : {}),
    tiles: Array.isArray(dash.tiles) ? dash.tiles.map(sanitizeTile).filter((t): t is DashboardTile => t !== null) : [],
    createdAt: typeof dash.createdAt === 'string' && dash.createdAt ? dash.createdAt : new Date().toISOString(),
    ...(dash.locked === true ? { locked: true } : {})
  };
};

const read = (): CustomDashboard[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeDashboard).filter((d): d is CustomDashboard => d !== null);
  } catch {
    return [];
  }
};

const write = (list: CustomDashboard[]) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE, JSON.stringify(list));
    window.dispatchEvent(new CustomEvent(DASHBOARDS_CHANGED));
  } catch {
    /* storage unavailable (private mode) — dashboards just don't persist */
  }
};

const uuid = (prefix: string) =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// ------------------------------------------------------------------ CRUD ------

export const listDashboards = (): CustomDashboard[] => read();

export const createDashboard = (
  name: string,
  icon?: string,
  tiles?: Array<Omit<DashboardTile, 'id'> & { id?: string }>
): CustomDashboard => {
  const dash: CustomDashboard = {
    id: uuid('dash'),
    name: name.trim() || 'My dashboard',
    ...(icon && icon.trim() ? { icon: icon.trim() } : {}),
    tiles: (tiles ?? []).map((t) => ({
      id: t.id || uuid('tile'),
      tool: t.tool,
      args: { ...t.args },
      ...(t.label ? { label: t.label } : {}),
      density: isDensity(t.density) ? t.density : 'detailed'
    })),
    createdAt: new Date().toISOString()
  };
  write([...read(), dash]);
  return dash;
};

export const updateDashboard = (id: string, patch: { name?: string; icon?: string; locked?: boolean }) => {
  write(
    read().map((d) => {
      if (d.id !== id) return d;
      const next: CustomDashboard = { ...d };
      if (typeof patch.name === 'string') next.name = patch.name.trim() || next.name;
      if (patch.icon !== undefined) next.icon = patch.icon.trim() || undefined;
      if (typeof patch.locked === 'boolean') next.locked = patch.locked || undefined;
      return next;
    })
  );
};

export const removeDashboard = (id: string) => write(read().filter((d) => d.id !== id));

// ------------------------------------------------------------------ tiles -----

export const addTile = (dashId: string, tile: Omit<DashboardTile, 'id'> & { id?: string }): DashboardTile => {
  const entry: DashboardTile = {
    id: tile.id || uuid('tile'),
    tool: tile.tool,
    args: { ...tile.args },
    ...(tile.label ? { label: tile.label } : {}),
    density: isDensity(tile.density) ? tile.density : 'detailed'
  };
  write(read().map((d) => (d.id === dashId ? { ...d, tiles: [...d.tiles, entry] } : d)));
  return entry;
};

export const updateTile = (
  dashId: string,
  tileId: string,
  patch: Partial<Omit<DashboardTile, 'id'>>
) => {
  write(
    read().map((d) => {
      if (d.id !== dashId) return d;
      return {
        ...d,
        tiles: d.tiles.map((t) => {
          if (t.id !== tileId) return t;
          const next: DashboardTile = { ...t };
          if (typeof patch.tool === 'string' && patch.tool) next.tool = patch.tool;
          if (patch.args && typeof patch.args === 'object') next.args = { ...patch.args };
          if (patch.label !== undefined) next.label = patch.label || undefined;
          if (isDensity(patch.density)) next.density = patch.density;
          return next;
        })
      };
    })
  );
};

export const removeTile = (dashId: string, tileId: string) => {
  write(read().map((d) => (d.id === dashId ? { ...d, tiles: d.tiles.filter((t) => t.id !== tileId) } : d)));
};

/** Move a tile to an exact position (drag-drop reorder). */
export const reorderTile = (dashId: string, tileId: string, toIndex: number) => {
  write(
    read().map((d) => {
      if (d.id !== dashId) return d;
      const from = d.tiles.findIndex((t) => t.id === tileId);
      const to = Math.max(0, Math.min(d.tiles.length - 1, toIndex));
      if (from < 0 || from === to) return d;
      const tiles = [...d.tiles];
      const [moved] = tiles.splice(from, 1);
      tiles.splice(to, 0, moved);
      return { ...d, tiles };
    })
  );
};

/** Swap a tile with its neighbor (dir: -1 = up/earlier, 1 = down/later). */
export const moveTile = (dashId: string, tileId: string, dir: -1 | 1) => {
  write(
    read().map((d) => {
      if (d.id !== dashId) return d;
      const idx = d.tiles.findIndex((t) => t.id === tileId);
      const target = idx + dir;
      if (idx < 0 || target < 0 || target >= d.tiles.length) return d;
      const tiles = [...d.tiles];
      const [moved] = tiles.splice(idx, 1);
      tiles.splice(target, 0, moved);
      return { ...d, tiles };
    })
  );
};

export const onDashboardsChanged = (handler: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  const h = () => handler();
  window.addEventListener(DASHBOARDS_CHANGED, h);
  return () => window.removeEventListener(DASHBOARDS_CHANGED, h);
};

// -------------------------------------------------------------- templates -----

// get_weather REQUIRES a `location` argument (server registry: required:
// ['location'], no client-context fallback), so the "My day" template can't send
// `{}`. Best effort: derive a city from the IANA timezone ("Asia/Tokyo" → "Tokyo")
// so the starter dashboard lands close to home; the user can retarget the tile.
const timezoneCity = (): string => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const city = tz.split('/').pop()?.replace(/_/g, ' ').trim();
    if (city && !/^(UTC|GMT|Etc)/i.test(city)) return city;
  } catch {
    /* fall through */
  }
  return 'New York';
};

export const DASHBOARD_TEMPLATES: DashboardTemplate[] = [
  {
    id: 'markets',
    name: 'Markets',
    icon: '📈',
    description: 'Apple and the S&P 500 at a glance, with business headlines alongside.',
    tiles: [
      { tool: 'get_stock', args: { symbol: 'AAPL' }, label: 'Apple', density: 'compact' },
      { tool: 'get_stock', args: { symbol: '^GSPC' }, label: 'S&P 500', density: 'compact' },
      { tool: 'get_news', args: { topic: 'business' }, label: 'Business news', density: 'compact' }
    ]
  },
  {
    id: 'my-day',
    name: 'My day',
    icon: '☀️',
    description: 'Weather where you are plus today’s top headlines.',
    tiles: [
      { tool: 'get_weather', args: { location: timezoneCity() }, label: 'Weather', density: 'detailed' },
      { tool: 'get_news', args: { topic: 'top' }, label: 'Top headlines', density: 'compact' }
    ]
  },
  {
    id: 'trader-desk',
    name: 'Trader desk',
    icon: '🖥️',
    description: 'The live tape, Fear & Greed, the yield curve and speculative positioning — one screen.',
    tiles: [
      { tool: 'get_ticker_tape', args: {}, label: 'Market tape', density: 'detailed' },
      { tool: 'get_market_sentiment', args: { market: 'both' }, label: 'Fear & Greed', density: 'compact' },
      { tool: 'get_yield_curve', args: {}, label: 'Yield curve', density: 'compact' },
      { tool: 'get_cot_positioning', args: {}, label: 'COT positioning', density: 'compact' }
    ]
  },
  {
    id: 'macro-watch',
    name: 'Macro watch',
    icon: '🏛️',
    description: 'Key indicators (live with a FRED key), the econ calendar and the national debt clock.',
    tiles: [
      {
        tool: 'show_macro_tiles',
        args: {
          tiles: [
            { label: 'CPI (YoY)', seriesId: 'CPIAUCSL', unit: '%' },
            { label: 'Unemployment', seriesId: 'UNRATE', unit: '%' },
            { label: 'Fed funds', seriesId: 'FEDFUNDS', unit: '%' },
            { label: '30Y mortgage', seriesId: 'MORTGAGE30US', unit: '%' }
          ]
        },
        label: 'Indicators',
        density: 'detailed'
      },
      { tool: 'get_econ_calendar', args: {}, label: 'Econ calendar', density: 'compact' },
      { tool: 'get_national_debt', args: {}, label: 'Debt clock', density: 'compact' }
    ]
  },
  {
    id: 'crypto-pulse',
    name: 'Crypto pulse',
    icon: '🪙',
    description: 'BTC, perp-funding positioning and the stablecoin peg watch.',
    tiles: [
      { tool: 'crypto_price', args: { coin: 'bitcoin' }, label: 'Bitcoin', density: 'compact' },
      { tool: 'get_funding_rates', args: {}, label: 'Perp funding', density: 'compact' },
      { tool: 'get_stablecoins', args: {}, label: 'Stablecoins', density: 'compact' },
      { tool: 'get_market_sentiment', args: { market: 'crypto' }, label: 'Crypto sentiment', density: 'compact' }
    ]
  }
];
