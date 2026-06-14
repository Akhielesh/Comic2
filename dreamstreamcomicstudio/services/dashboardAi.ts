// Dashboard AI command router — turns a natural-language command from the sticky
// dashboard bar into board creations or tile edits. Deterministic and local-first
// (free, instant, works offline): a small grammar covers the common commands; the
// full chat composer remains the heavyweight AI path. Pure parsing is exported
// separately so it's unit-testable.

import {
  createDashboard,
  updateTile,
  addTile,
  type CustomDashboard,
  type DashboardTile
} from './customDashboards';
import { resolveWidgetIntent } from './widgetIntent';
import { resolveStockSymbol } from './symbolResolve';
import type { WidgetDensity } from '../components/chat/artifacts/kit';

export interface DashboardCommandResult {
  kind: 'created' | 'updated' | 'error';
  dashboardId?: string;
  message: string;
  changedTileIds?: string[];
}

type TileSpec = Omit<DashboardTile, 'id'>;

export type DashboardPlan =
  | { kind: 'create'; name: string; icon?: string; tiles: TileSpec[] }
  | { kind: 'edit'; tool: string; args: Record<string, unknown>; label: string }
  | { kind: 'add'; tool: string; args: Record<string, unknown>; label: string; density: WidgetDensity }
  | { kind: 'error'; message: string };

// "add/pin/track/watch <thing>" — a single-widget intent. We let the smart resolver
// turn the rest of the phrase into the right tile (so "pin rivian" → RIVN stock, "track
// bitcoin" → crypto price, "add weather tokyo" → weather), instead of guessing here.
const ADD_RE = /^(?:add|pin|track|watch)\s+(?:a\s+|an\s+|the\s+)?(.+)/i;

// "change/set/switch/update [the] weather [widget] to Tokyo" → tool edit.
const EDIT_RE =
  /^(?:change|set|switch|update)\s+(?:the\s+)?(weather|stocks?|news|crypto|coins?|places?|videos?|currency|fx|map)\s*(?:widget\s*)?(?:to|for|about|on)\s+(.+)$/i;

const EDIT_TOOLS: Record<string, (v: string) => { tool: string; args: Record<string, unknown>; label: string }> = {
  weather: (v) => ({ tool: 'get_weather', args: { location: v }, label: `Weather · ${v}` }),
  stock: (v) => {
    const r = resolveStockSymbol(v);
    return { tool: 'get_stock', args: { symbol: r?.symbol ?? v }, label: r?.name ?? v.toUpperCase() };
  },
  news: (v) => ({ tool: 'get_news', args: { query: v }, label: `News · ${v}` }),
  crypto: (v) => ({ tool: 'crypto_price', args: { coin: v }, label: `${v} price` }),
  coin: (v) => ({ tool: 'crypto_price', args: { coin: v }, label: `${v} price` }),
  place: (v) => ({ tool: 'find_places', args: { query: v }, label: `Places · ${v}` }),
  video: (v) => ({ tool: 'video_search', args: { query: v }, label: `Videos · ${v}` }),
  currency: (v) => ({ tool: 'exchange_rate', args: parseFx(v), label: `FX · ${v.toUpperCase()}` }),
  fx: (v) => ({ tool: 'exchange_rate', args: parseFx(v), label: `FX · ${v.toUpperCase()}` }),
  map: (v) => ({ tool: 'show_map', args: { places: v.split(/,| and /i).map((s) => s.trim()).filter(Boolean) }, label: `Map · ${v}` })
};

const parseFx = (v: string): Record<string, unknown> => {
  const m = v.toUpperCase().match(/([A-Z]{3})\s*(?:TO|\/|->|→)\s*([A-Z]{3})/);
  return m ? { from: m[1], to: m[2] } : { from: 'USD', to: v.toUpperCase().slice(0, 3) };
};

/** "plan a trip to Lisbon" → "Lisbon" (destination phrasing beats generic topic). */
const extractPlace = (command: string): string | null => {
  const m = command.match(/(?:\bto|\bin|\bat)\s+([^,.!?]+)[,.!?]?\s*$/i);
  return m ? m[1].trim() : null;
};

/** Pull the subject out of a create command ("study dashboard for ML" → "ML"). */
export const extractTopic = (command: string): string => {
  const m = command.match(/(?:for|about|on|of)\s+(.+)$/i);
  let topic = (m ? m[1] : command)
    .replace(/^(?:build|create|make|plan|start|new)\s+/i, '')
    .replace(/\b(?:me|a|an|the|please|dashboard|board|tracker|sprint|project)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return topic;
};

// "directions from X to Y" / "route to the airport from home" / "commute…" —
// a travel need gets the real multi-modal directions widget.
const DIRECTIONS_RE = /(?:directions|route|commute|how\s+(?:do\s+i|to)\s+get)\b.*?\bfrom\s+(.+?)\s+to\s+(.+)$/i;
const DIRECTIONS_TO_FROM_RE = /(?:directions|route|commute|how\s+(?:do\s+i|to)\s+get)\b.*?\bto\s+(.+?)\s+from\s+(.+)$/i;

/** Parse a command into a deterministic plan. Pure — no storage access. */
export const parseDashboardCommand = (raw: string): DashboardPlan => {
  const command = raw.trim();
  if (!command) return { kind: 'error', message: 'Tell me what to build or change.' };

  const dir = command.match(DIRECTIONS_RE) ?? command.match(DIRECTIONS_TO_FROM_RE);
  if (dir) {
    const swapped = !DIRECTIONS_RE.test(command);
    const from = (swapped ? dir[2] : dir[1]).trim().replace(/[.!?]$/, '');
    const to = (swapped ? dir[1] : dir[2]).trim().replace(/[.!?]$/, '');
    if (from && to) {
      return { kind: 'edit', tool: 'get_directions', args: { from, to }, label: `${from} → ${to}` };
    }
  }
  if (/^(?:directions|route|commute)\b/i.test(command)) {
    return { kind: 'error', message: 'Give me both ends — e.g. “directions from home to Dulles Airport”.' };
  }

  const edit = command.match(EDIT_RE);
  if (edit) {
    const raw = edit[1].toLowerCase();
    // "news" is not a plural — only strip the s when the singular is a known noun.
    const noun = EDIT_TOOLS[raw] ? raw : raw.replace(/s$/, '');
    const value = edit[2].trim().replace(/[.!]$/, '');
    const make = EDIT_TOOLS[noun];
    if (make && value) return { kind: 'edit', ...make(value) };
  }

  // "add/pin/track/watch X" → resolve to one ready-to-pin widget via the smart resolver.
  const addM = command.match(ADD_RE);
  if (addM) {
    const s = resolveWidgetIntent(addM[1].replace(/\bwidget\b/i, '').trim())[0];
    if (s && s.ready) return { kind: 'add', tool: s.def.tool, args: s.args, label: s.label, density: s.density };
  }

  const c = command.toLowerCase();
  const topic = extractTopic(command);
  const t = topic || 'today';

  if (/study|learn|exam|revise|course/.test(c)) {
    return {
      kind: 'create', name: `Study · ${t}`, icon: '📚',
      tiles: [
        { tool: 'video_search', args: { query: `${t} tutorial` }, label: `Learn ${t}`, density: 'detailed' },
        { tool: 'get_news', args: { query: t }, label: `News · ${t}`, density: 'compact' }
      ]
    };
  }
  if (/cook|recipe|dinner|meal|bake/.test(c)) {
    return {
      kind: 'create', name: `Cook · ${t}`, icon: '🍳',
      tiles: [
        { tool: 'video_search', args: { query: `how to cook ${t}` }, label: `Cooking ${t}`, density: 'detailed' },
        { tool: 'find_places', args: { query: 'grocery store' }, label: 'Groceries nearby', density: 'compact' }
      ]
    };
  }
  if (/market|stock|invest|portfolio|trading/.test(c)) {
    return {
      kind: 'create', name: 'Markets', icon: '📈',
      tiles: [
        { tool: 'get_stock', args: { symbol: '^GSPC' }, label: 'S&P 500', density: 'compact' },
        { tool: 'get_stock', args: { symbol: '^IXIC' }, label: 'Nasdaq', density: 'compact' },
        { tool: 'crypto_price', args: { coin: 'bitcoin' }, label: 'Bitcoin', density: 'compact' },
        { tool: 'get_news', args: { query: 'stock market' }, label: 'Market news', density: 'detailed' }
      ]
    };
  }
  if (/trip|travel|visit|vacation|holiday/.test(c)) {
    const city = extractPlace(command) || t;
    return {
      kind: 'create', name: `Trip · ${city}`, icon: '✈️',
      tiles: [
        { tool: 'get_weather', args: { location: city }, label: `Weather · ${city}`, density: 'compact' },
        { tool: 'find_places', args: { query: 'attractions', near: city }, label: `See in ${city}`, density: 'detailed' },
        { tool: 'show_map', args: { places: [city] }, label: city, density: 'compact' },
        { tool: 'get_news', args: { query: city }, label: `News · ${city}`, density: 'compact' }
      ]
    };
  }
  if (/build|make|project|how to|diy|fix/.test(c)) {
    return {
      kind: 'create', name: `Project · ${t}`, icon: '🛠️',
      tiles: [
        { tool: 'video_search', args: { query: `how to ${t}` }, label: `How to ${t}`, density: 'detailed' },
        { tool: 'get_news', args: { query: t }, label: `News · ${t}`, density: 'compact' }
      ]
    };
  }
  // Generic topic board.
  return {
    kind: 'create', name: t.charAt(0).toUpperCase() + t.slice(1), icon: '✨',
    tiles: [
      { tool: 'get_news', args: { query: t }, label: `News · ${t}`, density: 'detailed' },
      { tool: 'video_search', args: { query: t }, label: `Videos · ${t}`, density: 'compact' }
    ]
  };
};

/** Execute a command against storage. Returns what the UI should do next. */
export const runDashboardCommand = async (
  command: string,
  board: { id: string; name: string; tiles: { id: string; tool: string; args: Record<string, unknown>; label?: string }[] } | null
): Promise<DashboardCommandResult> => {
  const plan = parseDashboardCommand(command);
  if (plan.kind === 'error') return { kind: 'error', message: plan.message };

  if (plan.kind === 'add') {
    const tile = { tool: plan.tool, args: plan.args, label: plan.label, density: plan.density };
    if (!board) {
      const dash = createDashboard(plan.label, '⚡', [tile]);
      return { kind: 'created', dashboardId: dash.id, message: `Started “${dash.name}” with that widget.` };
    }
    const added = addTile(board.id, tile);
    return { kind: 'updated', dashboardId: board.id, changedTileIds: [added.id], message: `Pinned ${plan.label} to “${board.name}”.` };
  }

  if (plan.kind === 'edit') {
    if (!board) {
      // No board open — bootstrap one around the requested widget instead of
      // bouncing the user ("change weather to Tokyo" on day one should just work).
      const dash = createDashboard(plan.label, '⚡', [{ tool: plan.tool, args: plan.args, label: plan.label, density: 'detailed' }]);
      return { kind: 'created', dashboardId: dash.id, message: `Started “${dash.name}” with that widget.` };
    }
    const matches = board.tiles.filter((t) => t.tool === plan.tool);
    if (matches.length === 0) {
      const added = addTile(board.id, { tool: plan.tool, args: plan.args, label: plan.label, density: 'detailed' });
      return { kind: 'updated', dashboardId: board.id, changedTileIds: [added.id], message: `Added ${plan.label} to “${board.name}”.` };
    }
    for (const tile of matches) updateTile(board.id, tile.id, { args: plan.args, label: plan.label });
    return {
      kind: 'updated', dashboardId: board.id, changedTileIds: matches.map((t) => t.id),
      message: `Updated ${matches.length === 1 ? plan.label : `${matches.length} widgets`} in “${board.name}”.`
    };
  }

  const dash: CustomDashboard = createDashboard(plan.name, plan.icon, plan.tiles);
  return { kind: 'created', dashboardId: dash.id, message: `Built “${dash.name}” with ${dash.tiles.length} live widgets.` };
};
