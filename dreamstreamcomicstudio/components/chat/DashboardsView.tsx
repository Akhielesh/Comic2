import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Clapperboard, CloudSun, LayoutDashboard, LineChart, Loader2, Lock, LockOpen,
  Map as MapIcon, MapPin, Maximize2, Minimize2, MoreHorizontal, MoreVertical, Newspaper,
  Pencil, Plus, RefreshCw, Send, Sparkles, Trash2, X
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ChatArtifact } from '../../apiTypes';
import { refreshArtifact } from '../../services/chatApi';
import {
  DASHBOARD_TEMPLATES, addTile, createDashboard, listDashboards,
  onDashboardsChanged, removeDashboard, removeTile, reorderTile, updateDashboard, updateTile,
  type CustomDashboard, type DashboardTemplate, type DashboardTile
} from '../../services/customDashboards';
import { runDashboardCommand, type DashboardCommandResult } from '../../services/dashboardAi';
import { deriveSmartPicks, tileKey, type SmartPick } from '../../services/smartPicks';
import { getChatMemory, listChatSessions } from '../../services/chatStorage';
import { useAuth } from '../../contexts/AuthContext';
import { DensityProvider, relativeTime, type WidgetDensity } from './artifacts/kit';
import { renderArtifactNode } from './artifacts/ChatArtifacts';

// Custom Dashboards — personal, persistent boards of live widget tiles.
//
// Each tile pins one whitelisted live-data tool call (REFRESHABLE_TOOLS); we
// re-execute it via /api/chat/tool-refresh (services/chatApi.refreshArtifact) and
// render the result with the SAME artifact cards the chat uses, in the tile's
// chosen density. No model round-trip — these are pure data tools.
//
// The board doubles as the user's PULSE: a sticky AI command bar (greeting +
// natural-language build/change commands via services/dashboardAi), smart picks
// mined from their chat memory + recent conversations (services/smartPicks),
// drag-drop rearranging, and a lock toggle that freezes the layout view-only.

// ---------------------------------------------------------------- catalog -----

interface WidgetTypeDef {
  tool: string;
  label: string;
  icon: LucideIcon;
  blurb: string;
  defaultDensity: WidgetDensity;
}

const WIDGET_TYPES: WidgetTypeDef[] = [
  { tool: 'get_stock', label: 'Stock quote', icon: LineChart, blurb: 'Stocks, indices, gold, FX, crypto', defaultDensity: 'compact' },
  { tool: 'get_news', label: 'News', icon: Newspaper, blurb: 'Headlines by section or topic', defaultDensity: 'compact' },
  { tool: 'get_weather', label: 'Weather', icon: CloudSun, blurb: 'Conditions + 5-day forecast', defaultDensity: 'detailed' },
  { tool: 'find_places', label: 'Places', icon: MapPin, blurb: 'Restaurants, cafes, shops nearby', defaultDensity: 'detailed' },
  { tool: 'show_map', label: 'Map', icon: MapIcon, blurb: 'Pinned locations on a live map', defaultDensity: 'detailed' },
  { tool: 'video_search', label: 'Videos', icon: Clapperboard, blurb: 'Tutorials, reviews and clips', defaultDensity: 'detailed' }
];

const TOOL_LABELS: Record<string, string> = Object.fromEntries(WIDGET_TYPES.map((w) => [w.tool, w.label]));

/** Which artifact type each tool's refresh is expected to produce. */
const EXPECTED_ARTIFACT: Record<string, string> = {
  get_weather: 'weather',
  get_news: 'news_results',
  get_stock: 'stock_quote',
  find_places: 'places_results',
  show_map: 'map',
  video_search: 'video_results'
};

// Mirrors the get_news `topic` enum (server registry) — the sections offered here.
const NEWS_TOPICS = ['top', 'world', 'business', 'technology', 'science', 'sports', 'health'] as const;

// Render via the chat's full artifact registry — ANY refreshable widget can live on a
// board. (The old local 6-type switch silently rendered nothing for template tiles
// like the ticker tape, sentiment gauges or macro tiles.)
const renderArtifactCard = (artifact: ChatArtifact): React.ReactNode => renderArtifactNode(artifact);

// ------------------------------------------------------------- tile chrome ----

interface TileState {
  loading: boolean;
  artifact?: ChatArtifact;
  asOf?: string;
  error?: string;
}

/** Per-tool mini-form fields for the in-menu tile editor. Tools without an
 *  entry fall back to a raw-JSON args editor. */
interface TileEditField {
  key: string;
  label: string;
  placeholder?: string;
  optional?: boolean;
  /** Comma-separated input stored as string[] in args (e.g. show_map.places). */
  list?: boolean;
}

const TILE_EDIT_FIELDS: Record<string, TileEditField[]> = {
  get_stock: [{ key: 'symbol', label: 'Symbol or asset', placeholder: 'AAPL, ^GSPC, gold, BTC-USD…' }],
  get_weather: [{ key: 'location', label: 'Location', placeholder: 'Tokyo or Austin, TX' }],
  get_news: [{ key: 'query', label: 'Topic/query', placeholder: 'AI chips, business…' }],
  crypto_price: [{ key: 'coin', label: 'Coin', placeholder: 'bitcoin, ethereum…' }],
  find_places: [
    { key: 'query', label: 'What', placeholder: 'coffee, ramen, hotels…' },
    { key: 'near', label: 'Near', placeholder: 'Blank = my location', optional: true }
  ],
  video_search: [{ key: 'query', label: 'Query', placeholder: 'how to make croissants…' }],
  show_map: [{ key: 'places', label: 'Places (comma-separated)', placeholder: 'Eiffel Tower, Louvre', list: true }]
};

/** A sensible new tile label after an edit (mirrors AddWidgetPanel's labels). */
const labelForEditedArgs = (tool: string, values: Record<string, string>): string | undefined => {
  if (tool === 'find_places') {
    const query = (values.query ?? '').trim();
    const near = (values.near ?? '').trim();
    return near ? `${query} · ${near}` : query || undefined;
  }
  if (tool === 'show_map') {
    const places = (values.places ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    return places.length ? places.join(', ') : undefined;
  }
  const first = TILE_EDIT_FIELDS[tool]?.[0];
  const v = first ? (values[first.key] ?? '').trim() : '';
  return v || undefined;
};

/** Mini-form shown inside the tile's ⋯ popover. Known tools get 1–2 smart
 *  fields; anything else gets a validated raw-JSON args editor. */
const TileEditForm: React.FC<{
  tile: DashboardTile;
  onSave: (args: Record<string, unknown>, label?: string) => void;
  onCancel: () => void;
}> = ({ tile, onSave, onCancel }) => {
  const fields = TILE_EDIT_FIELDS[tile.tool];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (fields ?? []).map((f) => {
        // get_news tiles created from a section store { topic } — prefill from it.
        const v = tile.args[f.key] ?? (tile.tool === 'get_news' && f.key === 'query' ? tile.args.topic : undefined);
        return [f.key, f.list && Array.isArray(v) ? v.join(', ') : typeof v === 'string' || typeof v === 'number' ? String(v) : ''];
      })
    )
  );
  const [jsonText, setJsonText] = useState(() => JSON.stringify(tile.args, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);

  const valid = fields
    ? fields.every((f) => {
        if (f.optional) return true;
        const raw = (values[f.key] ?? '').trim();
        return f.list ? raw.split(',').some((p) => p.trim()) : !!raw;
      })
    : true;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (fields) {
      if (!valid) return;
      const args: Record<string, unknown> = {};
      for (const f of fields) {
        const raw = (values[f.key] ?? '').trim();
        if (!raw) continue; // optional + empty → omit
        args[f.key] = f.list ? raw.split(',').map((p) => p.trim()).filter(Boolean) : raw;
      }
      onSave(args, labelForEditedArgs(tile.tool, values));
      return;
    }
    try {
      const parsed: unknown = JSON.parse(jsonText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Args must be a JSON object.');
      onSave(parsed as Record<string, unknown>); // keep the existing label
    } catch (err) {
      setJsonError((err as Error)?.message || 'Invalid JSON.');
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2.5">
      <div className="text-xs font-semibold text-[var(--ds-ink)]">Edit {TOOL_LABELS[tile.tool] || tile.tool}</div>
      {fields ? (
        fields.map((f, i) => (
          <div key={f.key}>
            <FieldLabel>{f.label}</FieldLabel>
            <input
              autoFocus={i === 0}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
              className={inputCls}
            />
          </div>
        ))
      ) : (
        <div>
          <FieldLabel>Args (JSON)</FieldLabel>
          <textarea
            autoFocus
            rows={5}
            spellCheck={false}
            value={jsonText}
            onChange={(e) => {
              setJsonText(e.target.value);
              setJsonError(null);
            }}
            aria-label="Tool arguments as JSON"
            className="w-full resize-y rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] px-3 py-2 font-mono text-xs text-[var(--ds-ink)] outline-none transition-colors placeholder:text-[var(--ds-muted)] focus:border-[var(--ds-accent)]"
          />
          {jsonError && <p className="mt-1 text-[11px] text-rose-600">{jsonError}</p>}
        </div>
      )}
      <div className="flex items-center justify-end gap-1.5 pt-0.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!valid}
          className="rounded-lg bg-[var(--ds-accent)] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[var(--ds-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </form>
  );
};

const tileMenuItemCls =
  'flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--ds-hover)] disabled:pointer-events-none disabled:opacity-40';

const TileCard: React.FC<{
  tile: DashboardTile;
  state?: TileState;
  /** Locked board = view-only: the ⋯ menu offers only Refresh. */
  locked: boolean;
  onToggleDensity: () => void;
  onRefresh: () => void;
  onRemove: () => void;
  /** Persist edited args (+ optional new label), then refetch the tile. */
  onSaveEdit: (args: Record<string, unknown>, label?: string) => void;
}> = ({ tile, state, locked, onToggleDensity, onRefresh, onRemove, onSaveEdit }) => {
  const label = tile.label || TOOL_LABELS[tile.tool] || tile.tool;
  const hasCard = !!state?.artifact;
  // ⋯ popover: 'menu' lists actions; 'edit' swaps in the mini args form.
  const [menu, setMenu] = useState<'closed' | 'menu' | 'edit'>('closed');
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (menu === 'closed') return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu('closed');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu('closed');
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const close = () => setMenu('closed');

  return (
    <div className="group/tile relative">
      {/* ⋯ menu — appears on hover/focus, always reachable on touch. Drags
          starting inside it are cancelled so form text selection works. */}
      <div
        ref={menuRef}
        onDragStart={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        className={`absolute right-2 top-2 z-20 transition-opacity duration-200 focus-within:opacity-100 group-hover/tile:opacity-100 [@media(pointer:coarse)]:opacity-70 ${
          menu === 'closed' ? 'opacity-0' : 'opacity-100'
        }`}
      >
        <button
          type="button"
          title="Widget options"
          aria-label="Widget options"
          aria-expanded={menu !== 'closed'}
          onClick={() => setMenu((m) => (m === 'closed' ? 'menu' : 'closed'))}
          className="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] text-[var(--ds-muted)] shadow-[0_1px_3px_rgba(0,0,0,0.1)] backdrop-blur-sm transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>

        {menu === 'menu' && (
          <div className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-raised)] py-1 shadow-lg">
            {!locked && (
              <button type="button" onClick={() => setMenu('edit')} className={`${tileMenuItemCls} text-[var(--ds-ink)]`}>
                <Pencil className="h-3.5 w-3.5 text-[var(--ds-muted)]" /> Edit
              </button>
            )}
            <button
              type="button"
              disabled={state?.loading}
              onClick={() => {
                onRefresh();
                close();
              }}
              className={`${tileMenuItemCls} text-[var(--ds-ink)]`}
            >
              <RefreshCw className={`h-3.5 w-3.5 text-[var(--ds-muted)] ${state?.loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
            {!locked && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    onToggleDensity();
                    close();
                  }}
                  className={`${tileMenuItemCls} text-[var(--ds-ink)]`}
                >
                  {tile.density === 'compact' ? (
                    <Maximize2 className="h-3.5 w-3.5 text-[var(--ds-muted)]" />
                  ) : (
                    <Minimize2 className="h-3.5 w-3.5 text-[var(--ds-muted)]" />
                  )}
                  {tile.density === 'compact' ? 'Detailed view' : 'Compact view'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onRemove();
                    close();
                  }}
                  className={`${tileMenuItemCls} text-rose-600`}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </button>
              </>
            )}
          </div>
        )}

        {menu === 'edit' && !locked && (
          <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-raised)] p-3 shadow-lg">
            <TileEditForm
              tile={tile}
              onSave={(args, newLabel) => {
                onSaveEdit(args, newLabel);
                close();
              }}
              onCancel={() => setMenu('menu')}
            />
          </div>
        )}
      </div>

      {hasCard ? (
        <>
          <DensityProvider value={tile.density}>{renderArtifactCard(state!.artifact!)}</DensityProvider>
          <div className="mt-1 flex items-center gap-1 px-1 text-[10px] text-[var(--ds-muted)]">
            {state?.error && <span>Couldn’t refresh — showing last data ·</span>}
            <span>Updated {relativeTime(state?.asOf) || 'just now'}</span>
          </div>
        </>
      ) : state?.error ? (
        // Quiet retry row — the tile failed before it ever had data.
        <div className="flex items-center justify-between gap-2 rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 py-3">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-[var(--ds-ink)]">{label}</div>
            <div className="truncate text-[11px] text-[var(--ds-muted)]">{state.error}</div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={state.loading}
            className="shrink-0 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)] disabled:opacity-50"
          >
            {state.loading ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      ) : (
        // Loading skeleton — pulsing recessed well sized to the chosen density.
        <div
          aria-label={`Loading ${label}`}
          className={`animate-pulse rounded-2xl border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] ${
            tile.density === 'compact' ? 'h-32' : 'h-72'
          }`}
        />
      )}
    </div>
  );
};

// ----------------------------------------------------------- add-tile panel ---

const inputCls =
  'w-full rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] px-3 py-2 text-base text-[var(--ds-ink)] outline-none transition-colors placeholder:text-[var(--ds-muted)] focus:border-[var(--ds-accent)] sm:text-sm';

const FieldLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-muted)]">{children}</label>
);

const AddWidgetPanel: React.FC<{
  onAdd: (tile: Omit<DashboardTile, 'id'>) => void;
  onClose: () => void;
}> = ({ onAdd, onClose }) => {
  const [tool, setTool] = useState<string | null>(null);
  const [density, setDensity] = useState<WidgetDensity>('compact');
  const [fields, setFields] = useState<Record<string, string>>({ newsTopic: 'top' });
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));
  const val = (key: string) => (fields[key] ?? '').trim();

  const pick = (def: WidgetTypeDef) => {
    setTool(def.tool);
    setDensity(def.defaultDensity);
  };

  // Build the tile from the current fields; null while invalid (required empty).
  const draft = useMemo((): Omit<DashboardTile, 'id'> | null => {
    switch (tool) {
      case 'get_stock': {
        const symbol = val('symbol');
        return symbol ? { tool, args: { symbol }, label: symbol, density } : null;
      }
      case 'get_news': {
        const query = val('newsQuery');
        const topic = val('newsTopic') || 'top';
        return query
          ? { tool, args: { query }, label: query, density }
          : { tool, args: { topic }, label: `${topic === 'top' ? 'Top' : topic[0].toUpperCase() + topic.slice(1)} headlines`, density };
      }
      case 'get_weather': {
        // get_weather REQUIRES location server-side (no context fallback), so the
        // field is required here rather than offering a blank "My location".
        const location = val('location');
        return location ? { tool, args: { location }, label: location, density } : null;
      }
      case 'find_places': {
        const query = val('placesQuery');
        const near = val('placesNear');
        if (!query) return null;
        return { tool, args: { query, ...(near ? { near } : {}) }, label: near ? `${query} · ${near}` : query, density };
      }
      case 'show_map': {
        const places = val('mapPlaces').split(',').map((p) => p.trim()).filter(Boolean);
        return places.length ? { tool, args: { places }, label: places.join(', '), density } : null;
      }
      case 'video_search': {
        const query = val('videoQuery');
        return query ? { tool, args: { query }, label: query, density } : null;
      }
      default:
        return null;
    }
  }, [tool, fields, density]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (draft) onAdd(draft);
  };

  return (
    <div className="rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold text-[var(--ds-ink)]">Add a widget</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close add widget panel"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 1. Pick a widget type. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {WIDGET_TYPES.map((def) => {
          const Icon = def.icon;
          const selected = tool === def.tool;
          return (
            <button
              key={def.tool}
              type="button"
              onClick={() => pick(def)}
              className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                selected
                  ? 'border-[var(--ds-accent)] bg-[#D97757]/10'
                  : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] hover:bg-[var(--ds-hover)]'
              }`}
            >
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${selected ? 'text-[var(--ds-accent)]' : 'text-[var(--ds-muted)]'}`} />
              <span className="min-w-0">
                <span className="block text-xs font-semibold text-[var(--ds-ink)]">{def.label}</span>
                <span className="block truncate text-[10px] text-[var(--ds-muted)]">{def.blurb}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* 2. One or two smart fields for the chosen type. */}
      {tool && (
        <form onSubmit={submit} className="mt-4 space-y-3">
          {tool === 'get_stock' && (
            <div>
              <FieldLabel>Symbol or asset</FieldLabel>
              <input autoFocus required value={fields.symbol ?? ''} onChange={set('symbol')} placeholder="AAPL, ^GSPC, gold, BTC-USD…" className={inputCls} />
            </div>
          )}
          {tool === 'get_news' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <FieldLabel>Section</FieldLabel>
                <select value={fields.newsTopic ?? 'top'} onChange={set('newsTopic')} className={inputCls}>
                  {NEWS_TOPICS.map((t) => (
                    <option key={t} value={t}>
                      {t === 'top' ? 'Top stories' : t[0].toUpperCase() + t.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <FieldLabel>Or a topic search</FieldLabel>
                <input value={fields.newsQuery ?? ''} onChange={set('newsQuery')} placeholder="Optional — e.g. “AI chips” (overrides section)" className={inputCls} />
              </div>
            </div>
          )}
          {tool === 'get_weather' && (
            <div>
              <FieldLabel>Location (required)</FieldLabel>
              <input autoFocus required value={fields.location ?? ''} onChange={set('location')} placeholder="City or place — e.g. Tokyo or Austin, TX" className={inputCls} />
              <p className="mt-1 text-[10px] text-[var(--ds-muted)]">The weather tool needs a place — it can’t auto-detect your location here.</p>
            </div>
          )}
          {tool === 'find_places' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <FieldLabel>What to find</FieldLabel>
                <input autoFocus required value={fields.placesQuery ?? ''} onChange={set('placesQuery')} placeholder="coffee, ramen, hotels…" className={inputCls} />
              </div>
              <div>
                <FieldLabel>Near (optional)</FieldLabel>
                <input value={fields.placesNear ?? ''} onChange={set('placesNear')} placeholder="Blank = my location" className={inputCls} />
              </div>
            </div>
          )}
          {tool === 'show_map' && (
            <div>
              <FieldLabel>Places (comma-separated)</FieldLabel>
              <input autoFocus required value={fields.mapPlaces ?? ''} onChange={set('mapPlaces')} placeholder="Eiffel Tower, Louvre, Notre-Dame" className={inputCls} />
            </div>
          )}
          {tool === 'video_search' && (
            <div>
              <FieldLabel>Search videos for</FieldLabel>
              <input autoFocus required value={fields.videoQuery ?? ''} onChange={set('videoQuery')} placeholder="how to make croissants…" className={inputCls} />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {/* Density: glance card vs full detail. */}
            <div className="flex rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-0.5" role="group" aria-label="Widget density">
              {(['compact', 'detailed'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDensity(d)}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    density === d ? 'bg-[var(--ds-raised)] text-[var(--ds-ink)] shadow-sm' : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
                  }`}
                >
                  {d === 'compact' ? 'Compact' : 'Detailed'}
                </button>
              ))}
            </div>
            <button
              type="submit"
              disabled={!draft}
              className="ml-auto rounded-xl bg-[var(--ds-accent)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--ds-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Add widget
            </button>
          </div>
        </form>
      )}
    </div>
  );
};

// ------------------------------------------------------------- empty state ----

const TemplateCard: React.FC<{ template: DashboardTemplate; onUse: () => void }> = ({ template, onUse }) => (
  <button
    type="button"
    onClick={onUse}
    className="flex flex-col rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-4 text-left shadow-[0_1px_3px_rgba(0,0,0,0.05)] transition-colors hover:bg-[var(--ds-hover)]"
  >
    <div className="flex items-center gap-2">
      <span className="text-xl leading-none">{template.icon}</span>
      <span className="text-sm font-semibold text-[var(--ds-ink)]">{template.name}</span>
    </div>
    <p className="mt-1.5 text-xs text-[var(--ds-muted)]">{template.description}</p>
    <div className="mt-3 flex flex-wrap gap-1">
      {template.tiles.map((t, i) => (
        <span key={i} className="rounded-md border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-1.5 py-0.5 text-[10px] text-[var(--ds-muted)]">
          {t.label || TOOL_LABELS[t.tool] || t.tool}
        </span>
      ))}
    </div>
    <span className="mt-3 text-xs font-semibold text-[var(--ds-accent)]">Start from template →</span>
  </button>
);

// ------------------------------------------------------------------- view -----

const REFRESH_EVERY_MS = 5 * 60_000;

/** "Good morning" / "Good afternoon" / "Good evening" by local hour. */
const greeting = (): string => {
  const h = new Date().getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

// --------------------------------------------------------- AI command bar -----

/** First-paint suggestion chips → the fuller command each prefills. */
const COMMAND_CHIPS: Array<{ label: string; command: string }> = [
  { label: 'Study sprint', command: 'Build a study sprint dashboard for machine learning — tutorial videos, AI news and quiet cafes to work from' },
  { label: 'Cook tonight', command: 'Build a cook tonight dashboard — dinner recipe videos, grocery stores near me and tonight’s weather' },
  { label: 'Markets snapshot', command: 'Build a markets snapshot dashboard — S&P 500, NVDA, bitcoin and business headlines' },
  { label: 'Trip planner', command: 'Build a trip planner dashboard for Tokyo — weather, a map of the big sights and ramen near Shibuya' }
];

/** Sticky glass bar: greeting + a natural-language command line that builds or
 *  edits boards via services/dashboardAi. The bar shows the result message
 *  inline; structural side effects (switch board, refetch tiles) go through
 *  `onResult` so the view owns its state. */
const AiCommandBar: React.FC<{
  board: CustomDashboard | null;
  onResult: (result: DashboardCommandResult) => void;
}> = ({ board, onResult }) => {
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DashboardCommandResult | null>(null);
  // Chips are a first-paint affordance — gone after the first submit.
  const [virgin, setVirgin] = useState(true);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const command = input.trim();
    if (!command || pending) return;
    setPending(true);
    setResult(null);
    setVirgin(false);
    let res: DashboardCommandResult;
    try {
      res = await runDashboardCommand(command, board);
    } catch (err) {
      res = { kind: 'error', message: (err as Error)?.message || 'The AI couldn’t process that — try again.' };
    }
    setPending(false);
    setResult(res);
    if (res.kind !== 'error') {
      setInput('');
      onResult(res);
    }
  };

  return (
    <div className="sticky top-0 z-30 border-b border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] backdrop-blur">
      <div className="mx-auto w-full max-w-6xl px-3 py-2.5 sm:px-6">
        <form onSubmit={submit} className="flex items-center gap-2">
          <span className="hidden shrink-0 items-center gap-1.5 text-xs font-medium text-[var(--ds-muted)] sm:flex">
            <Sparkles className="h-3.5 w-3.5 text-[var(--ds-accent)]" />
            {greeting()}
          </span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={pending}
            aria-label="Tell the AI what to build or change"
            placeholder="Tell the AI what to build or change — “study dashboard for ML”, “change weather to Tokyo”, “stocks to NVDA”…"
            className="min-w-0 flex-1 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] px-3 py-1.5 text-base text-[var(--ds-ink)] outline-none transition-colors placeholder:text-[var(--ds-muted)] focus:border-[var(--ds-accent)] disabled:opacity-60 sm:text-sm"
          />
          <button
            type="submit"
            disabled={pending || !input.trim()}
            aria-label="Run AI command"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--ds-accent)] text-white transition-colors hover:bg-[var(--ds-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </form>
        {virgin && !input && !pending && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {COMMAND_CHIPS.map((c) => (
              <button
                key={c.label}
                type="button"
                title={c.command}
                onClick={() => setInput(c.command)}
                className="rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2.5 py-1 text-[11px] font-medium text-[var(--ds-muted)] transition-colors hover:border-[var(--ds-accent)] hover:text-[var(--ds-ink)]"
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        {result && (
          <p role="status" className={`mt-1.5 text-[11px] ${result.kind === 'error' ? 'text-rose-600' : 'text-[var(--ds-muted)]'}`}>
            {result.message}
          </p>
        )}
      </div>
    </div>
  );
};

export const DashboardsView: React.FC = () => {
  const { user } = useAuth();
  const [dashboards, setDashboards] = useState<CustomDashboard[]>(() => listDashboards());
  const [activeId, setActiveId] = useState<string | null>(() => listDashboards()[0]?.id ?? null);
  const [tileStates, setTileStates] = useState<Record<string, TileState>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [, setClockTick] = useState(0); // re-render so "Updated Xm ago" stays honest
  // Recent conversation titles — one signal for the smart picks row.
  const [sessionTitles, setSessionTitles] = useState<string[]>([]);
  // The tile currently being dragged (HTML5 DnD reorder), and the hovered drop slot.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const inflight = useRef(new Set<string>());
  const tileStatesRef = useRef(tileStates);
  tileStatesRef.current = tileStates;

  useEffect(() => onDashboardsChanged(() => setDashboards(listDashboards())), []);

  // Load recent chat titles once (IndexedDB, best-effort) for the smart picks row.
  useEffect(() => {
    let on = true;
    listChatSessions()
      .then((sessions) => {
        if (on) setSessionTitles(sessions.slice(0, 20).map((s) => s.title).filter(Boolean));
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, []);

  const active = useMemo(
    () => dashboards.find((d) => d.id === activeId) ?? dashboards[0],
    [dashboards, activeId]
  );
  const activeRef = useRef(active);
  activeRef.current = active;

  const fetchTile = useCallback(async (tile: DashboardTile) => {
    if (inflight.current.has(tile.id)) return;
    inflight.current.add(tile.id);
    setTileStates((prev) => ({ ...prev, [tile.id]: { ...prev[tile.id], loading: true } }));
    try {
      const result = await refreshArtifact(tile.tool, tile.args);
      const want = EXPECTED_ARTIFACT[tile.tool];
      const artifact = result.artifacts.find((a) => a.type === want) ?? result.artifacts[0];
      if (!artifact) throw new Error('No data returned — check the widget’s settings.');
      setTileStates((prev) => ({
        ...prev,
        [tile.id]: { loading: false, artifact, asOf: result.asOf ?? new Date().toISOString() }
      }));
    } catch (err) {
      const message = (err as Error)?.message || 'Couldn’t load live data.';
      setTileStates((prev) => ({ ...prev, [tile.id]: { ...prev[tile.id], loading: false, error: message } }));
    } finally {
      inflight.current.delete(tile.id);
    }
  }, []);

  // Initial fetch: any visible tile that has never loaded.
  useEffect(() => {
    if (!active) return;
    for (const tile of active.tiles) {
      if (!tileStatesRef.current[tile.id]) void fetchTile(tile);
    }
  }, [active, fetchTile]);

  // Auto-refresh every 5 minutes; skipped while the tab is hidden.
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      for (const tile of activeRef.current?.tiles ?? []) void fetchTile(tile);
    }, REFRESH_EVERY_MS);
    return () => window.clearInterval(id);
  }, [active?.id, fetchTile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tick every 30s so the relative "Updated …" labels keep up.
  useEffect(() => {
    const id = window.setInterval(() => setClockTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const startTemplate = (t: DashboardTemplate) => {
    const d = createDashboard(t.name, t.icon, t.tiles);
    setActiveId(d.id);
  };

  const handleNew = () => {
    const d = createDashboard(`Dashboard ${dashboards.length + 1}`);
    setActiveId(d.id);
    setDraftName(d.name);
    setRenaming(true);
    setAddOpen(true);
  };

  const handleAddTile = (input: Omit<DashboardTile, 'id'>) => {
    if (!active) return;
    const tile = addTile(active.id, input);
    setAddOpen(false);
    void fetchTile(tile);
  };

  const saveRename = () => {
    if (active && draftName.trim()) updateDashboard(active.id, { name: draftName });
    setRenaming(false);
  };

  const handleDelete = () => {
    if (!active) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    removeDashboard(active.id);
    setMenuOpen(false);
    setConfirmDelete(false);
    setActiveId(null);
  };

  const locked = !!active?.locked;

  // Smart picks: mined from the user's memory + recent chats, minus what's pinned.
  const smartPicks = useMemo<SmartPick[]>(() => {
    const existing = new Set((active?.tiles ?? []).map((t) => tileKey({ tool: t.tool, args: t.args, density: t.density })));
    return deriveSmartPicks(getChatMemory(user?.id), sessionTitles, existing);
  }, [active, sessionTitles, user?.id]);

  const addPick = (pick: SmartPick) => {
    if (active) {
      const tile = addTile(active.id, pick.tile);
      void fetchTile(tile);
      return;
    }
    // No board yet — a pick bootstraps the user's pulse board.
    const d = createDashboard('My pulse', '⚡', [pick.tile]);
    setActiveId(d.id);
  };

  // Apply an AI command result: re-read boards from the store, switch to a
  // freshly created board, and refetch any tiles the AI changed.
  const handleAiResult = useCallback(
    (result: DashboardCommandResult) => {
      if (result.kind === 'error') return;
      const boards = listDashboards();
      setDashboards(boards);
      if (result.kind === 'created' && result.dashboardId) {
        setActiveId(result.dashboardId);
        return; // new tiles load via the initial-fetch effect
      }
      if (result.kind === 'updated' && result.changedTileIds?.length) {
        const pool = result.dashboardId ? boards.filter((b) => b.id === result.dashboardId) : boards;
        for (const id of result.changedTileIds) {
          const changed = pool.flatMap((b) => b.tiles).find((t) => t.id === id);
          if (changed) void fetchTile(changed);
        }
      }
    },
    [fetchTile]
  );

  // Drag-drop reorder (desktop).
  const handleDrop = (toIndex: number) => {
    if (active && dragId) reorderTile(active.id, dragId, toIndex);
    setDragId(null);
    setDropIndex(null);
  };

  // Detailed tiles get the full row on md and 2 of 3 columns on xl.
  const spanFor = (density: WidgetDensity) => (density === 'detailed' ? 'md:col-span-2 xl:col-span-2' : 'min-w-0');

  // ------------------------------------------------------------ empty hero ----
  if (dashboards.length === 0) {
    return (
      <div className="h-full w-full overflow-y-auto bg-[var(--ds-canvas)]">
        {/* The AI bar also bootstraps the first board ("study dashboard for ML"). */}
        <AiCommandBar board={null} onResult={handleAiResult} />
        <div className="mx-auto w-full max-w-3xl px-4 py-12 text-center sm:py-16">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#D97757]/10">
            <LayoutDashboard className="h-7 w-7 text-[var(--ds-accent)]" />
          </div>
          <h2 className="mt-4 text-xl font-semibold text-[var(--ds-ink)]">Build your own live dashboards</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-[var(--ds-muted)]">
            Pin live widgets — markets, weather, news, places — into boards that refresh themselves while you work.
          </p>
          <div className="mt-7 grid gap-3 text-left sm:grid-cols-2">
            {DASHBOARD_TEMPLATES.map((t) => (
              <TemplateCard key={t.id} template={t} onUse={() => startTemplate(t)} />
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              const d = createDashboard('My dashboard');
              setActiveId(d.id);
              setAddOpen(true);
            }}
            className="mt-6 rounded-xl bg-[var(--ds-accent)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--ds-accent-hover)]"
          >
            Start blank
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-[var(--ds-canvas)]">
      {/* -------------------------------------------- sticky AI command bar --- */}
      <AiCommandBar board={active ?? null} onResult={handleAiResult} />
      <div className="mx-auto w-full max-w-6xl px-3 py-4 sm:px-6 sm:py-6">
        {/* ------------------------------------------------ switcher header --- */}
        <header className="mb-4 flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {dashboards.map((d) => {
              const isActive = active?.id === d.id;
              if (isActive && renaming) {
                return (
                  <input
                    key={d.id}
                    autoFocus
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={saveRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveRename();
                      if (e.key === 'Escape') setRenaming(false);
                    }}
                    aria-label="Dashboard name"
                    className="h-8 w-40 rounded-full border border-[var(--ds-accent)] bg-[var(--ds-surface)] px-3 text-base font-medium text-[var(--ds-ink)] outline-none sm:text-xs"
                  />
                );
              }
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setActiveId(d.id)}
                  className={`flex h-8 max-w-[180px] items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors ${
                    isActive
                      ? 'border border-[var(--ds-hairline)] bg-[var(--ds-raised)] text-[var(--ds-ink)] shadow-sm'
                      : 'text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
                  }`}
                >
                  {d.icon && <span className="text-sm leading-none">{d.icon}</span>}
                  <span className="truncate">{d.name}</span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={handleNew}
              className="flex h-8 items-center gap-1 rounded-full border border-dashed border-[var(--ds-hairline)] px-3 text-xs font-medium text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
            >
              <Plus className="h-3.5 w-3.5" /> New dashboard
            </button>
          </div>

          {/* Right controls: lock toggle + kebab (rename / delete). */}
          {active && (
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => updateDashboard(active.id, { locked: !locked })}
                aria-pressed={locked}
                title={locked ? 'Unlock: edit layout' : 'Lock: freeze layout (view-only pulse)'}
                className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
                  locked
                    ? 'border-[var(--ds-accent)] bg-[#D97757]/10 text-[var(--ds-ink)]'
                    : 'border-[var(--ds-hairline)] bg-[var(--ds-surface)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
                }`}
              >
                {locked ? <Lock className="h-3.5 w-3.5 text-[var(--ds-accent)]" /> : <LockOpen className="h-3.5 w-3.5" />}
                {locked ? 'Locked' : 'Lock'}
              </button>
              <div className="relative">
              <button
                type="button"
                aria-label="Dashboard options"
                onClick={() => {
                  setMenuOpen((o) => !o);
                  setConfirmDelete(false);
                }}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface)] text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {menuOpen && (
                <>
                  <button
                    type="button"
                    aria-label="Close menu"
                    onClick={() => setMenuOpen(false)}
                    className="fixed inset-0 z-30 cursor-default"
                  />
                  <div className="absolute right-0 top-full z-40 mt-1 w-48 overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] shadow-lg backdrop-blur-sm">
                    <button
                      type="button"
                      onClick={() => {
                        setDraftName(active.name);
                        setRenaming(true);
                        setMenuOpen(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)]"
                    >
                      <Pencil className="h-3.5 w-3.5 text-[var(--ds-muted)]" /> Rename
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      className="flex w-full items-center gap-2 border-t border-[var(--ds-hairline-soft)] px-3 py-2 text-left text-xs text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)]"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-[var(--ds-muted)]" />
                      {confirmDelete ? 'Click again to confirm' : 'Delete dashboard'}
                    </button>
                  </div>
                </>
              )}
              </div>
            </div>
          )}
        </header>

        {/* ------------------------------------------------------ pulse strip --- */}
        {/* Smart picks mined from the user's memory and recent chats (the greeting
            lives in the sticky AI bar). One tap pins a pick as a live tile.
            Hidden while the board is locked. */}
        {active && !locked && smartPicks.length > 0 && (
          <div className="mb-4 rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.05)]">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-[var(--ds-ink)]">
              <Sparkles className="h-4 w-4 text-[var(--ds-accent)]" />
              Your picks today
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {smartPicks.map((pick) => (
                <button
                  key={pick.label}
                  type="button"
                  title={`${pick.reason} — tap to pin`}
                  onClick={() => addPick(pick)}
                  className="inline-flex items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2.5 py-1 text-[11px] font-medium text-[var(--ds-muted)] transition-colors hover:border-[var(--ds-accent)] hover:text-[var(--ds-ink)]"
                >
                  <Plus className="h-3 w-3 text-[var(--ds-accent)]" />
                  {pick.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ----------------------------------------------------- tile grid --- */}
        {active && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {active.tiles.map((tile, i) => (
              <div
                key={tile.id}
                className={`${spanFor(tile.density)} ${dragId === tile.id ? 'opacity-50' : ''} ${
                  dropIndex === i && dragId && dragId !== tile.id ? 'rounded-2xl ring-2 ring-[var(--ds-accent)] ring-offset-2 ring-offset-[var(--ds-canvas)]' : ''
                }`}
                draggable={!locked}
                onDragStart={(e) => {
                  if (locked) return;
                  setDragId(tile.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (locked || !dragId) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (dropIndex !== i) setDropIndex(i);
                }}
                onDragLeave={() => {
                  if (dropIndex === i) setDropIndex(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(i);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropIndex(null);
                }}
              >
                <TileCard
                  tile={tile}
                  state={tileStates[tile.id]}
                  locked={locked}
                  onToggleDensity={() =>
                    updateTile(active.id, tile.id, { density: tile.density === 'compact' ? 'detailed' : 'compact' })
                  }
                  onRefresh={() => void fetchTile(tile)}
                  onRemove={() => removeTile(active.id, tile.id)}
                  onSaveEdit={(args, newLabel) => {
                    updateTile(active.id, tile.id, { args, ...(newLabel ? { label: newLabel } : {}) });
                    // Refetch with the fresh args (state will catch up via the change event).
                    void fetchTile({ ...tile, args });
                  }}
                />
              </div>
            ))}

            {/* Add widget — hidden on a locked board. */}
            {locked ? null : addOpen ? (
              <div className="md:col-span-2 xl:col-span-3">
                <AddWidgetPanel onAdd={handleAddTile} onClose={() => setAddOpen(false)} />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="flex min-h-[128px] w-full flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-[var(--ds-hairline)] bg-[var(--ds-well)] text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
              >
                <Plus className="h-5 w-5" />
                <span className="text-xs font-medium">Add widget</span>
                {active.tiles.length === 0 && (
                  <span className="px-4 text-center text-[10px] text-[var(--ds-muted)]">
                    Pin a live stock, weather, news or places widget
                  </span>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default DashboardsView;
