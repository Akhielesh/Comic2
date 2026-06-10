import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, ArrowUp, Clapperboard, CloudSun, LayoutDashboard, LineChart,
  Map as MapIcon, MapPin, Maximize2, Minimize2, MoreHorizontal, Newspaper,
  Pencil, Plus, RefreshCw, Trash2, X
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  ChatArtifact, MapArtifact, NewsResultsArtifact, PlacesResultsArtifact,
  StockQuoteArtifact, VideoResultsArtifact, WeatherArtifact
} from '../../apiTypes';
import { refreshArtifact } from '../../services/chatApi';
import {
  DASHBOARD_TEMPLATES, addTile, createDashboard, listDashboards, moveTile,
  onDashboardsChanged, removeDashboard, removeTile, updateDashboard, updateTile,
  type CustomDashboard, type DashboardTemplate, type DashboardTile
} from '../../services/customDashboards';
import { DensityProvider, relativeTime, type WidgetDensity } from './artifacts/kit';
import { WeatherStation } from './artifacts/WeatherStation';
import { NewsDigest } from './artifacts/NewsDigest';
import { MarketCard } from './artifacts/MarketCard';
import { PlacesResults } from './artifacts/PlacesResults';
import { MapArtifactCard } from './artifacts/MapArtifactCard';
import { VideoResults } from './artifacts/VideoResults';

// Custom Dashboards — personal, persistent boards of live widget tiles.
//
// Each tile pins one whitelisted live-data tool call (REFRESHABLE_TOOLS); we
// re-execute it via /api/chat/tool-refresh (services/chatApi.refreshArtifact) and
// render the result with the SAME artifact cards the chat uses, in the tile's
// chosen density. No model round-trip — these are pure data tools.

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

const renderArtifactCard = (artifact: ChatArtifact): React.ReactNode => {
  switch (artifact.type) {
    case 'weather':
      return <WeatherStation data={artifact.data as WeatherArtifact} />;
    case 'news_results':
      return <NewsDigest data={artifact.data as NewsResultsArtifact} />;
    case 'stock_quote':
      return <MarketCard data={artifact.data as StockQuoteArtifact} />;
    case 'places_results':
      return <PlacesResults data={artifact.data as PlacesResultsArtifact} />;
    case 'map':
      return <MapArtifactCard data={artifact.data as MapArtifact} />;
    case 'video_results':
      return <VideoResults data={artifact.data as VideoResultsArtifact} />;
    default:
      return null;
  }
};

// ------------------------------------------------------------- tile chrome ----

interface TileState {
  loading: boolean;
  artifact?: ChatArtifact;
  asOf?: string;
  error?: string;
}

const ToolButton: React.FC<{
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ title, onClick, disabled, children }) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    disabled={disabled}
    onClick={onClick}
    className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:pointer-events-none disabled:opacity-35"
  >
    {children}
  </button>
);

const TileCard: React.FC<{
  tile: DashboardTile;
  state?: TileState;
  isFirst: boolean;
  isLast: boolean;
  onMove: (dir: -1 | 1) => void;
  onToggleDensity: () => void;
  onRefresh: () => void;
  onRemove: () => void;
}> = ({ tile, state, isFirst, isLast, onMove, onToggleDensity, onRefresh, onRemove }) => {
  const label = tile.label || TOOL_LABELS[tile.tool] || tile.tool;
  const hasCard = !!state?.artifact;
  return (
    <div className="group/tile relative">
      {/* Slim floating toolbar — appears on hover/focus, always reachable on touch. */}
      <div className="absolute right-2 top-2 z-20 flex items-center gap-0.5 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] p-0.5 opacity-0 shadow-[0_1px_3px_rgba(0,0,0,0.1)] backdrop-blur-sm transition-opacity duration-200 focus-within:opacity-100 group-hover/tile:opacity-100 [@media(pointer:coarse)]:opacity-70">
        <ToolButton title="Move up" onClick={() => onMove(-1)} disabled={isFirst}>
          <ArrowUp className="h-3 w-3" />
        </ToolButton>
        <ToolButton title="Move down" onClick={() => onMove(1)} disabled={isLast}>
          <ArrowDown className="h-3 w-3" />
        </ToolButton>
        <ToolButton
          title={tile.density === 'compact' ? 'Expand: full detail' : 'Collapse: glance view'}
          onClick={onToggleDensity}
        >
          {tile.density === 'compact' ? <Maximize2 className="h-3 w-3" /> : <Minimize2 className="h-3 w-3" />}
        </ToolButton>
        <ToolButton title="Refresh" onClick={onRefresh} disabled={state?.loading}>
          <RefreshCw className={`h-3 w-3 ${state?.loading ? 'animate-spin' : ''}`} />
        </ToolButton>
        <ToolButton title="Remove widget" onClick={onRemove}>
          <Trash2 className="h-3 w-3" />
        </ToolButton>
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

export const DashboardsView: React.FC = () => {
  const [dashboards, setDashboards] = useState<CustomDashboard[]>(() => listDashboards());
  const [activeId, setActiveId] = useState<string | null>(() => listDashboards()[0]?.id ?? null);
  const [tileStates, setTileStates] = useState<Record<string, TileState>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [, setClockTick] = useState(0); // re-render so "Updated Xm ago" stays honest

  const inflight = useRef(new Set<string>());
  const tileStatesRef = useRef(tileStates);
  tileStatesRef.current = tileStates;

  useEffect(() => onDashboardsChanged(() => setDashboards(listDashboards())), []);

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

  // Detailed tiles get the full row on md and 2 of 3 columns on xl.
  const spanFor = (density: WidgetDensity) => (density === 'detailed' ? 'md:col-span-2 xl:col-span-2' : 'min-w-0');

  // ------------------------------------------------------------ empty hero ----
  if (dashboards.length === 0) {
    return (
      <div className="h-full w-full overflow-y-auto bg-[var(--ds-canvas)]">
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

          {/* Kebab: rename / delete the active dashboard. */}
          {active && (
            <div className="relative ml-auto">
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
          )}
        </header>

        {/* ----------------------------------------------------- tile grid --- */}
        {active && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {active.tiles.map((tile, i) => (
              <div key={tile.id} className={spanFor(tile.density)}>
                <TileCard
                  tile={tile}
                  state={tileStates[tile.id]}
                  isFirst={i === 0}
                  isLast={i === active.tiles.length - 1}
                  onMove={(dir) => moveTile(active.id, tile.id, dir)}
                  onToggleDensity={() =>
                    updateTile(active.id, tile.id, { density: tile.density === 'compact' ? 'detailed' : 'compact' })
                  }
                  onRefresh={() => void fetchTile(tile)}
                  onRemove={() => removeTile(active.id, tile.id)}
                />
              </div>
            ))}

            {/* Add widget — a card that expands into the inline picker panel. */}
            {addOpen ? (
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
