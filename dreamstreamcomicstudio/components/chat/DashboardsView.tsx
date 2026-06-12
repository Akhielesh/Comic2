import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutDashboard, Loader2, Lock, LockOpen, Maximize2, MessageCircle, Minimize2,
  MoreHorizontal, MoreVertical, Pencil, Plus, RefreshCw, Search, Send, Sparkles, Trash2, X
} from 'lucide-react';
import type { ChatArtifact } from '../../apiTypes';
import { refreshArtifact, sendChatMessage } from '../../services/chatApi';
import { ChatMarkdown } from './ChatMarkdown';
import {
  DASHBOARD_TEMPLATES, addTile, createDashboard, listDashboards,
  onDashboardsChanged, removeDashboard, removeTile, reorderTile, updateDashboard, updateTile,
  type CustomDashboard, type DashboardTemplate, type DashboardTile
} from '../../services/customDashboards';
import { runDashboardCommand, type DashboardCommandResult } from '../../services/dashboardAi';
import { deriveSmartPicks, tileKey, type SmartPick } from '../../services/smartPicks';
import { getChatMemory, listChatSessions } from '../../services/chatStorage';
import { useAuth } from '../../contexts/AuthContext';
import { persistUiState, resolveInitialUiState } from '../../services/viewState';
import { DensityProvider, relativeTime, type WidgetDensity } from './artifacts/kit';
import { renderArtifactNode } from './artifacts/ChatArtifacts';
import {
  AI_CHAT_TILE, TOOL_LABELS, WIDGET_BY_TOOL, WIDGET_CATEGORIES, buildTileFromFields, searchWidgets,
  type WidgetDef
} from './widgetCatalog';

export { AI_CHAT_TILE };

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

// The widget catalog (every refreshable tool, categorized, with field specs)
// lives in ./widgetCatalog — shared by the add panel and the tile editor, and
// coverage-tested against REFRESHABLE_TOOLS.

// ----------------------------------------------------------- mini AI chat tile ---

/** A small assistant box living on the board: ask → answer renders as markdown.
 *  Keeps the last exchange only — it's a pulse-glance tool, not a full thread
 *  (the sidebar's New chat is one click away for that). */
const AiChatTile: React.FC = () => {
  const [draft, setDraft] = useState('');
  const [exchange, setExchange] = useState<{ q: string; a: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    const q = draft.trim();
    if (!q || busy) return;
    setBusy(true);
    setDraft('');
    setExchange({ q, a: '' });
    try {
      const res = await sendChatMessage({ messages: [{ role: 'user', content: q }] } as never);
      setExchange({ q, a: res.text || '(no response)' });
    } catch (err) {
      setExchange({ q, a: `Couldn't answer: ${(err as Error)?.message || 'request failed'}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-[160px] flex-col rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] shadow-[0_1px_3px_rgba(0,0,0,0.05)]">
      <div className="flex items-center gap-1.5 border-b border-[var(--ds-hairline-soft)] px-3 py-2 text-xs font-semibold text-[var(--ds-ink)]">
        <MessageCircle className="h-3.5 w-3.5 text-[var(--ds-accent)]" /> Ask AI
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {exchange ? (
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold text-[var(--ds-muted)]">{exchange.q}</p>
            {busy ? (
              <div className="flex items-center gap-1.5 text-[11px] text-[var(--ds-muted)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--ds-accent)]" /> Thinking…
              </div>
            ) : (
              <div className="text-[12px] leading-relaxed text-[var(--ds-ink)]">
                <ChatMarkdown text={exchange.a} />
              </div>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-[var(--ds-muted)]">
            Quick questions without leaving the board — “what’s moving the market?”, “rain this weekend in Tokyo?”
          </p>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
        className="flex items-center gap-1.5 border-t border-[var(--ds-hairline-soft)] p-2"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask anything…"
          className="min-w-0 flex-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2.5 py-1.5 text-[12px] text-[var(--ds-ink)] outline-none transition-colors placeholder:text-[var(--ds-muted)] focus:border-[var(--ds-accent)] focus:bg-[var(--ds-raised)]"
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          aria-label="Send"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-accent)] text-white transition-colors hover:bg-[var(--ds-accent-hover)] disabled:opacity-40"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </form>
    </div>
  );
};

/** Which artifact type each tool's refresh is expected to produce. Tools not
 *  listed fall back to the first artifact the refresh returns. */
const EXPECTED_ARTIFACT: Record<string, string> = {
  get_weather: 'weather',
  get_news: 'news_results',
  get_stock: 'stock_quote',
  find_places: 'places_results',
  show_map: 'map',
  video_search: 'video_results',
  get_directions: 'directions'
};

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

/** Mini-form shown inside the tile's ⋯ popover. Catalog-known tools get their
 *  declared fields; anything else gets a validated raw-JSON args editor. */
const TileEditForm: React.FC<{
  tile: DashboardTile;
  onSave: (args: Record<string, unknown>, label?: string) => void;
  onCancel: () => void;
}> = ({ tile, onSave, onCancel }) => {
  const def = WIDGET_BY_TOOL[tile.tool];
  const fields = def && def.fields.length ? def.fields : undefined;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (fields ?? []).map((f) => {
        const v = tile.args[f.key];
        const asText = f.list && Array.isArray(v)
          ? v.map((item) => (item && typeof item === 'object' && 'symbol' in (item as object) ? String((item as { symbol: unknown }).symbol) : String(item))).join(', ')
          : typeof v === 'string' || typeof v === 'number'
            ? String(v)
            : f.default ?? '';
        return [f.key, asText];
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
    if (fields && def) {
      const built = buildTileFromFields(def, values, tile.density);
      if (!built) return;
      onSave(built.args, built.label);
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
            {f.select ? (
              <select
                value={values[f.key] ?? f.default ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                className={inputCls}
              >
                {f.select.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : (
              <input
                autoFocus={i === 0}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                className={inputCls}
              />
            )}
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

const TILE_MIN_H = 160;
const TILE_MAX_H = 1200;

/** Bottom drag handle that resizes a tile's height (drag; double-click resets).
 *  Works alongside the board's drag-to-reorder: pointer capture + cancelled
 *  dragstart keep a resize from ever turning into a tile move. */
const TileResizeHandle: React.FC<{
  height: number | null;
  measure: () => number;
  onLive: (px: number) => void;
  onCommit: (px: number | null) => void;
}> = ({ height, measure, onLive, onCommit }) => {
  const drag = useRef<{ startY: number; startH: number; live: number } | null>(null);
  const [active, setActive] = useState(false);
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize widget (drag; double-click to reset)"
      draggable
      onDragStart={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { startY: e.clientY, startH: height ?? measure(), live: height ?? measure() };
        setActive(true);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const next = Math.min(TILE_MAX_H, Math.max(TILE_MIN_H, drag.current.startH + (e.clientY - drag.current.startY)));
        drag.current.live = next;
        onLive(next);
      }}
      onPointerUp={() => {
        if (!drag.current) return;
        onCommit(drag.current.live);
        drag.current = null;
        setActive(false);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setActive(false);
      }}
      onDoubleClick={() => onCommit(null)}
      className={`mx-auto -mt-0.5 flex h-3.5 w-16 cursor-ns-resize touch-none items-center justify-center opacity-0 transition-opacity duration-200 group-hover/tile:opacity-100 [@media(pointer:coarse)]:opacity-60 ${active ? 'opacity-100' : ''}`}
    >
      <div className={`h-1 w-9 rounded-full transition-colors ${active ? 'bg-[var(--ds-muted)]' : 'bg-[var(--ds-faint)]'}`} />
    </div>
  );
};

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
  /** Persist a user-dragged tile height (null = back to natural). */
  onResize: (px: number | null) => void;
}> = ({ tile, state, locked, onToggleDensity, onRefresh, onRemove, onSaveEdit, onResize }) => {
  // Live height while the resize handle is dragged (commit persists via onResize).
  const [liveHeight, setLiveHeight] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const effectiveHeight = liveHeight ?? tile.heightPx ?? null;
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
          <div
            ref={bodyRef}
            className={effectiveHeight != null ? 'overflow-y-auto overscroll-contain [scrollbar-width:thin]' : undefined}
            style={effectiveHeight != null ? { height: effectiveHeight } : undefined}
          >
            <DensityProvider value={tile.density}>{renderArtifactCard(state!.artifact!)}</DensityProvider>
          </div>
          {!locked && (
            <TileResizeHandle
              height={effectiveHeight}
              measure={() => bodyRef.current?.getBoundingClientRect().height ?? TILE_MIN_H}
              onLive={setLiveHeight}
              onCommit={(px) => {
                setLiveHeight(null);
                onResize(px);
              }}
            />
          )}
          <div className="flex items-center gap-1 px-1 text-[10px] text-[var(--ds-muted)]">
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

/** The full widget gallery: every refreshable live-data widget the platform
 *  has, searchable and grouped by category. Picking one opens a small config
 *  step (presets + the widget's declared fields). */
const AddWidgetPanel: React.FC<{
  onAdd: (tile: Omit<DashboardTile, 'id'>) => void;
  onClose: () => void;
}> = ({ onAdd, onClose }) => {
  const [selected, setSelected] = useState<WidgetDef | null>(null);
  const [term, setTerm] = useState('');
  const [density, setDensity] = useState<WidgetDensity>('detailed');
  const [values, setValues] = useState<Record<string, string>>({});

  const pick = (def: WidgetDef) => {
    setSelected(def);
    setDensity(def.defaultDensity);
    setValues(Object.fromEntries(def.fields.filter((f) => f.default).map((f) => [f.key, f.default!])));
  };

  const matches = useMemo(() => searchWidgets(term), [term]);
  const grouped = useMemo(
    () => WIDGET_CATEGORIES.map((c) => ({ category: c, defs: matches.filter((w) => w.category === c) })).filter((g) => g.defs.length),
    [matches]
  );

  const draft = selected ? buildTileFromFields(selected, values, density) : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (draft) onAdd(draft);
  };

  return (
    <div className="rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      <div className="mb-3 flex items-center gap-2">
        {selected ? (
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="rounded-lg px-2 py-1 text-xs font-medium text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
          >
            ← All widgets
          </button>
        ) : (
          <div className="text-sm font-semibold text-[var(--ds-ink)]">Add a widget</div>
        )}
        {!selected && (
          <div className="relative ml-auto w-44 sm:w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ds-muted)]" />
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search widgets…"
              aria-label="Search widgets"
              className="w-full rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] py-1.5 pl-8 pr-2.5 text-xs text-[var(--ds-ink)] outline-none transition-colors placeholder:text-[var(--ds-muted)] focus:border-[var(--ds-accent)]"
            />
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close add widget panel"
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] ${selected ? 'ml-auto' : ''}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {!selected ? (
        // 1. The gallery: every widget, grouped, scrollable.
        <div className="max-h-[420px] space-y-4 overflow-y-auto overscroll-contain pr-1 [scrollbar-width:thin]">
          {grouped.length === 0 && (
            <p className="py-6 text-center text-xs text-[var(--ds-muted)]">No widgets match “{term}”.</p>
          )}
          {grouped.map(({ category, defs }) => (
            <section key={category}>
              <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ds-muted)]">{category}</h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                {defs.map((def) => {
                  const Icon = def.icon;
                  return (
                    <button
                      key={def.tool}
                      type="button"
                      onClick={() => pick(def)}
                      className="flex items-start gap-2 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 py-2.5 text-left transition-colors hover:border-[var(--ds-accent)] hover:bg-[var(--ds-hover)]"
                    >
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ds-muted)]" />
                      <span className="min-w-0">
                        <span className="block text-xs font-semibold text-[var(--ds-ink)]">{def.label}</span>
                        <span className="block text-[10px] leading-snug text-[var(--ds-muted)] line-clamp-2">{def.blurb}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        // 2. Configure the chosen widget: presets + its declared fields.
        <form onSubmit={submit} className="space-y-3">
          <div className="flex items-center gap-2">
            <selected.icon className="h-4 w-4 shrink-0 text-[var(--ds-accent)]" />
            <span className="text-sm font-semibold text-[var(--ds-ink)]">{selected.label}</span>
            <span className="truncate text-[11px] text-[var(--ds-muted)]">{selected.blurb}</span>
          </div>
          {selected.note && (
            <p className="rounded-lg border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-2.5 py-1.5 text-[11px] text-[var(--ds-muted)]">{selected.note}</p>
          )}

          {selected.presets && selected.presets.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {selected.presets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => onAdd({ tool: selected.tool, args: p.args, label: p.tileLabel ?? p.label, density })}
                  className="inline-flex items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2.5 py-1 text-[11px] font-medium text-[var(--ds-muted)] transition-colors hover:border-[var(--ds-accent)] hover:text-[var(--ds-ink)]"
                >
                  <Plus className="h-3 w-3 text-[var(--ds-accent)]" />
                  {p.label}
                </button>
              ))}
            </div>
          )}

          {selected.fields.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {selected.fields.map((f, i) => (
                <div key={f.key} className={selected.fields.length === 1 ? 'sm:col-span-2' : undefined}>
                  <FieldLabel>{f.label}{f.optional ? '' : ' (required)'}</FieldLabel>
                  {f.select ? (
                    <select
                      value={values[f.key] ?? f.default ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      className={inputCls}
                    >
                      {f.select.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      autoFocus={i === 0}
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                      className={inputCls}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
          {selected.fields.length === 0 && !selected.presets?.length && (
            <p className="text-[11px] text-[var(--ds-muted)]">No configuration needed — it’s live data.</p>
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
  /** Sidebar toggle from the host shell — the dashboards view owns its full
   *  height (no separate title header), so the toggle lives in this bar. */
  leading?: React.ReactNode;
}> = ({ board, onResult, leading }) => {
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
      <div className="mx-auto w-full max-w-6xl px-3 py-2 sm:px-6">
        <form onSubmit={submit} className="flex items-center gap-2">
          {leading}
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

// localStorage key remembering the last-open board across sessions (the URL
// `?board=` param wins for shareable deep links; see resolveInitialBoard).
const ACTIVE_BOARD_STORE = 'ds.dashboards.active.v1';

const resolveInitialBoard = (): string | null => {
  const ids = new Set(listDashboards().map((d) => d.id));
  const isKnown = (v: string): v is string => ids.has(v);
  const remembered = resolveInitialUiState('dashboards.board', 'board', isKnown, '');
  if (remembered) return remembered;
  try {
    const stored = window.localStorage.getItem(ACTIVE_BOARD_STORE);
    if (stored && ids.has(stored)) return stored;
  } catch {
    /* private mode — fall through */
  }
  return listDashboards()[0]?.id ?? null;
};

export const DashboardsView: React.FC<{ sidebarControl?: React.ReactNode }> = ({ sidebarControl }) => {
  const { user } = useAuth();
  const [dashboards, setDashboards] = useState<CustomDashboard[]>(() => listDashboards());
  // Continuity: reloading (or coming back later) reopens the LAST board the
  // user was on, not the first in the list.
  const [activeId, setActiveId] = useState<string | null>(() => resolveInitialBoard());
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
  // Filter for the board switcher (appears once the tab strip gets crowded).
  const [boardFilter, setBoardFilter] = useState('');
  const [boardFilterOpen, setBoardFilterOpen] = useState(false);
  // Scroll the active pill into view when the selection changes (not every render —
  // tile-state re-renders would otherwise fight the user scrolling the strip).
  const activePillRef = useRef<HTMLButtonElement>(null);

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

  useEffect(() => {
    activePillRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  // Persist the open board (URL param + session memory + localStorage).
  useEffect(() => {
    const id = active?.id ?? null;
    persistUiState('dashboards.board', 'board', id);
    try {
      if (id) window.localStorage.setItem(ACTIVE_BOARD_STORE, id);
      else window.localStorage.removeItem(ACTIVE_BOARD_STORE);
    } catch {
      /* private mode — session memory still covers reloads */
    }
  }, [active?.id]);

  const fetchTile = useCallback(async (tile: DashboardTile) => {
    if (tile.tool === AI_CHAT_TILE) return; // the mini chat tile has no live-data fetch
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
        <AiCommandBar board={null} onResult={handleAiResult} leading={sidebarControl} />
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

  const filterTerm = boardFilter.trim().toLowerCase();
  const visibleBoards = filterTerm ? dashboards.filter((d) => d.name.toLowerCase().includes(filterTerm)) : dashboards;
  const manyBoards = dashboards.length > 5;

  return (
    <div className="h-full w-full overflow-y-auto bg-[var(--ds-canvas)]">
      {/* -------------------------------------------- sticky AI command bar --- */}
      <AiCommandBar board={active ?? null} onResult={handleAiResult} leading={sidebarControl} />
      <div className="mx-auto w-full max-w-6xl px-3 py-3 sm:px-6 sm:py-4">
        {/* --------------------------------------------------- switcher row ---
            One slim line that never wraps: the board pills scroll horizontally,
            with a name filter once the strip gets crowded. */}
        <header className="mb-3 flex items-center gap-1.5">
          {manyBoards && (
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => {
                  setBoardFilterOpen((v) => !v);
                  setBoardFilter('');
                }}
                aria-label="Search dashboards"
                aria-expanded={boardFilterOpen}
                className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                  boardFilterOpen ? 'bg-[var(--ds-raised)] text-[var(--ds-ink)] shadow-sm' : 'text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
                }`}
              >
                <Search className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {boardFilterOpen && manyBoards && (
            <input
              autoFocus
              value={boardFilter}
              onChange={(e) => setBoardFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setBoardFilterOpen(false);
                  setBoardFilter('');
                }
                if (e.key === 'Enter' && visibleBoards[0]) {
                  setActiveId(visibleBoards[0].id);
                  setBoardFilterOpen(false);
                  setBoardFilter('');
                }
              }}
              placeholder="Find a dashboard…"
              aria-label="Filter dashboards by name"
              className="h-8 w-36 shrink-0 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface)] px-3 text-xs text-[var(--ds-ink)] outline-none transition-colors placeholder:text-[var(--ds-muted)] focus:border-[var(--ds-accent)]"
            />
          )}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {visibleBoards.map((d) => {
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
                    className="h-8 w-40 shrink-0 rounded-full border border-[var(--ds-accent)] bg-[var(--ds-surface)] px-3 text-base font-medium text-[var(--ds-ink)] outline-none sm:text-xs"
                  />
                );
              }
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setActiveId(d.id)}
                  ref={isActive ? activePillRef : undefined}
                  className={`flex h-8 max-w-[180px] shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors ${
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
            {filterTerm && visibleBoards.length === 0 && (
              <span className="shrink-0 px-2 text-[11px] text-[var(--ds-muted)]">No boards match “{boardFilter}”.</span>
            )}
            <button
              type="button"
              onClick={handleNew}
              className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-dashed border-[var(--ds-hairline)] px-3 text-xs font-medium text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
            >
              <Plus className="h-3.5 w-3.5" /> New
            </button>
          </div>

          {/* Right controls: lock toggle + kebab (rename / delete). */}
          {active && (
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
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
                className={`transition-all duration-200 ease-out ${spanFor(tile.density)} ${
                  dragId === tile.id ? 'scale-[0.98] opacity-50' : ''
                } ${
                  dropIndex === i && dragId && dragId !== tile.id
                    ? 'translate-y-0.5 rounded-2xl ring-2 ring-[var(--ds-accent)] ring-offset-2 ring-offset-[var(--ds-canvas)]'
                    : ''
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
                {tile.tool === AI_CHAT_TILE ? (
                  <div className="group/tile relative">
                    {!locked && (
                      <div className="absolute right-2 top-2 z-20 flex items-center gap-0.5 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] p-0.5 opacity-0 shadow-[0_1px_3px_rgba(0,0,0,0.1)] backdrop-blur-sm transition-opacity duration-200 focus-within:opacity-100 group-hover/tile:opacity-100 [@media(pointer:coarse)]:opacity-70">
                        <button
                          title="Remove widget"
                          onClick={() => removeTile(active.id, tile.id)}
                          className="rounded-md p-1 text-[var(--ds-muted)] transition-colors duration-200 hover:bg-[var(--ds-hover)] hover:text-rose-600"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                    <AiChatTile />
                  </div>
                ) : (
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
                  onResize={(px) => updateTile(active.id, tile.id, { heightPx: px ?? undefined })}
                />
                )}
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
