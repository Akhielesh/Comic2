import React, { useMemo, useState } from 'react';
import { Search, X, Eye, Braces, Copy, Check, ExternalLink, Loader2, Zap, PanelsTopLeft, Sparkles, Layers } from 'lucide-react';
import { GALLERY_DEMOS } from './ComponentGallery';
import { DENSITY_AWARE_TYPES, renderArtifactNode } from './artifacts/ChatArtifacts';
import { DensityProvider, type WidgetDensity } from './artifacts/kit';
import { REFRESHABLE_TOOLS, type ChatArtifact } from '../../apiTypes';
import { TOOL_CATALOG, type ToolMeta } from '../../toolCatalog';
import { WIDGET_CATALOG, type WidgetDef } from './widgetCatalog';
import { ARTIFACT_TOOLS, MODEL_AUTHORED, deriveTags, KIND_LABEL, EXAMPLE_PROMPT, type WidgetKind } from './widgetStudioMeta';
import { refreshArtifact } from '../../services/chatApi';
import { CANVAS_BG, GLASS, HEADING, MUTED, TRANSITION } from './studioDesign';

// Widget Studio — a 21st.dev-style catalog of every rich-output component, mapped to
// the live tool / API / MCP that feeds it. Searchable + categorized + tagged, with a
// Preview ⇄ Spec toggle: the live component on one side, and on the other its data
// schema (real JSON), connection point, provider/auth/rate-limit, capabilities and an
// example invocation — the surface for benchmarking, standardizing and refining widgets.

/** One data source that can feed a visual. */
interface Source {
  tool: string;
  meta?: ToolMeta;
}

interface StudioEntry {
  id: string;
  title: string;
  type?: string;
  category: string;
  node: React.ReactNode;
  data: unknown;
  /** Every tool/API that can feed this visual (primary first). */
  sources: Source[];
  tool?: string; // primary
  toolMeta?: ToolMeta; // primary
  widgetDef?: WidgetDef;
  refreshable: boolean;
  densityAware: boolean;
  multiSource: boolean;
  kind: WidgetKind;
  tags: string[];
}

const ENTRIES: StudioEntry[] = GALLERY_DEMOS.map((d, i) => {
  const type = d.type;
  const data = React.isValidElement(d.node) ? (d.node.props as { data?: unknown }).data : undefined;
  const toolNames = type ? ARTIFACT_TOOLS[type] ?? [] : [];
  const sources: Source[] = toolNames.map((tool) => ({ tool, meta: TOOL_CATALOG.find((t) => t.name === tool) }));
  const tool = sources[0]?.tool;
  const toolMeta = sources[0]?.meta;
  const widgetDef = tool ? WIDGET_CATALOG.find((w) => w.tool === tool) : undefined;
  const refreshable = toolNames.some((t) => (REFRESHABLE_TOOLS as readonly string[]).includes(t));
  const densityAware = !!type && DENSITY_AWARE_TYPES.has(type);
  const multiSource = toolNames.length > 1;
  const kind: WidgetKind = type && MODEL_AUTHORED.has(type) ? 'model-authored' : ((toolMeta?.kind as WidgetKind) ?? (type ? 'builtin' : 'static'));
  const tags = deriveTags({ category: d.category, kind, refreshable, densityAware, multiSource, toolMeta, title: d.title });
  return { id: `${type ?? 'misc'}-${i}`, title: d.title, type, category: d.category ?? 'Other', node: d.node, data, sources, tool, toolMeta, widgetDef, refreshable, densityAware, multiSource, kind, tags };
});

const CATEGORIES = ['All', ...[...new Set(ENTRIES.map((e) => e.category))]];
const CATEGORY_COUNT: Record<string, number> = ENTRIES.reduce<Record<string, number>>((acc, e) => {
  acc.All = (acc.All ?? 0) + 1;
  acc[e.category] = (acc[e.category] ?? 0) + 1;
  return acc;
}, {});

const KIND_BADGE: Record<WidgetKind, string> = {
  api: 'text-emerald-600 bg-emerald-500/10 border-emerald-500/25',
  mcp: 'text-violet-600 bg-violet-500/10 border-violet-500/25',
  builtin: 'text-sky-600 bg-sky-500/10 border-sky-500/25',
  'model-authored': 'text-amber-600 bg-amber-500/10 border-amber-500/25',
  static: 'text-[var(--ds-muted)] bg-[var(--ds-well-strong)] border-[var(--ds-hairline)]'
};

// Per-kind accent color for the list rail (dot + left bar) — quick visual scanning.
const KIND_DOT: Record<WidgetKind, string> = {
  api: 'bg-emerald-500',
  mcp: 'bg-violet-500',
  builtin: 'bg-sky-500',
  'model-authored': 'bg-amber-500',
  static: 'bg-[var(--ds-faint)]'
};

const cleanTitle = (t: string): string => t.replace(/\s*\(.*\)\s*$/, '').trim();

const safeJson = (data: unknown): string => {
  if (data === undefined) return '';
  try {
    const s = JSON.stringify(data, null, 2);
    return s.length > 8000 ? `${s.slice(0, 8000)}\n… (truncated)` : s;
  } catch {
    return '/* payload is not serializable */';
  }
};

const Badge: React.FC<{ kind: WidgetKind }> = ({ kind }) => (
  <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-bold ${KIND_BADGE[kind]}`}>{KIND_LABEL[kind]}</span>
);

const SpecRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) =>
  children ? (
    <div className="flex items-baseline justify-between gap-4 border-b border-[var(--ds-hairline-soft)] py-1.5 last:border-b-0">
      <dt className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{label}</dt>
      <dd className="min-w-0 text-right text-xs text-[var(--ds-ink)]">{children}</dd>
    </div>
  ) : null;

export interface GalleryStudioProps {
  sidebarControl?: React.ReactNode;
  /** Seed a new chat with an example prompt that produces the selected widget. */
  onTry?: (prompt: string) => void;
}

export const GalleryStudio: React.FC<GalleryStudioProps> = ({ sidebarControl, onTry }) => {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('All');
  const [selectedId, setSelectedId] = useState(ENTRIES[0]?.id ?? '');
  const [tab, setTab] = useState<'preview' | 'spec'>('preview');
  const [density, setDensity] = useState<WidgetDensity>('detailed');
  const [copied, setCopied] = useState(false);
  const [live, setLive] = useState<{ id: string; loading: boolean; node?: React.ReactNode; error?: string } | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ENTRIES.filter((e) => {
      if (cat !== 'All' && e.category !== cat) return false;
      if (!q) return true;
      const hay = [e.title, e.type, e.category, ...e.tags, ...e.sources.map((s) => s.tool), ...e.sources.map((s) => s.meta?.provider)].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [query, cat]);

  const selected = filtered.find((e) => e.id === selectedId) ?? filtered[0];

  // When browsing "All", group the list into category sections (sticky sub-headers)
  // so a long catalog stays navigable; a filtered category renders flat.
  const grouped = useMemo<[string, StudioEntry[]][] | null>(() => {
    if (cat !== 'All') return null;
    const map = new Map<string, StudioEntry[]>();
    for (const e of filtered) (map.get(e.category) ?? map.set(e.category, []).get(e.category)!).push(e);
    return [...map.entries()];
  }, [filtered, cat]);

  const loadLive = async () => {
    if (!selected?.tool) return;
    const args = selected.widgetDef?.presets?.[0]?.args ?? {};
    setLive({ id: selected.id, loading: true });
    try {
      const result = await refreshArtifact(selected.tool, args as Record<string, unknown>);
      const art = (result.artifacts as ChatArtifact[]).find((a) => a.type === selected.type) ?? (result.artifacts as ChatArtifact[])[0];
      if (!art) throw new Error('No data returned');
      setLive({ id: selected.id, loading: false, node: renderArtifactNode(art) });
    } catch (err) {
      setLive({ id: selected.id, loading: false, error: (err as Error)?.message || 'Live fetch failed' });
    }
  };

  const copyJson = () => {
    if (!selected) return;
    void navigator.clipboard?.writeText(safeJson(selected.data));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const liveForSelected = live && selected && live.id === selected.id ? live : null;

  // One catalog row — kind-colored rail + dot, title, multi-source mark, category·tool.
  const renderItem = (e: StudioEntry) => {
    const active = selected?.id === e.id;
    return (
      <button
        key={e.id}
        onClick={() => {
          setSelectedId(e.id);
          setTab('preview');
        }}
        title={KIND_LABEL[e.kind]}
        className={`group/item relative mb-0.5 flex w-full items-start gap-2.5 rounded-xl py-2 pl-3 pr-2.5 text-left ${TRANSITION} ${
          active ? 'bg-[#D97757]/10' : 'hover:bg-[var(--ds-hover)]'
        }`}
      >
        {/* kind accent rail */}
        <span
          className={`absolute inset-y-1.5 left-0 w-0.5 rounded-full ${KIND_DOT[e.kind]} ${
            active ? 'opacity-100' : 'opacity-0 group-hover/item:opacity-60'
          }`}
        />
        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${KIND_DOT[e.kind]}`} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--ds-ink)]">{cleanTitle(e.title)}</span>
            {e.multiSource && <Layers className="h-3 w-3 shrink-0 text-[var(--ds-muted)]" />}
          </span>
          <span className="mt-0.5 flex items-center gap-1 text-[10px] text-[var(--ds-muted)]">
            <span className="shrink-0">{e.category}</span>
            {e.tool && <span className="opacity-40">·</span>}
            {e.tool && <code className="min-w-0 truncate font-mono">{e.tool}</code>}
          </span>
        </span>
      </button>
    );
  };

  return (
    <div className={`flex h-full w-full flex-col overflow-hidden ${CANVAS_BG}`}>
      {/* Header — sidebar toggle, title, search, category chips. */}
      <div className={`relative z-20 border-b border-[var(--ds-hairline)] ${GLASS} px-3 py-2.5 sm:px-4`}>
        <div className="flex items-center gap-2 sm:gap-3">
          {sidebarControl}
          <PanelsTopLeft className="hidden h-4 w-4 shrink-0 text-[var(--ds-accent)] sm:block" />
          <span className={`text-sm ${HEADING}`}>Gallery</span>
          <span className="text-[11px] text-[var(--ds-muted)]">{filtered.length} of {ENTRIES.length} widgets</span>
          <div className="relative ml-auto w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ds-muted)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search widgets, tools, tags…"
              className="w-full rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] py-1.5 pl-8 pr-7 text-[13px] text-[var(--ds-ink)] outline-none placeholder:text-[var(--ds-muted)] focus:border-[#D97757]/40"
            />
            {query && (
              <button onClick={() => setQuery('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--ds-muted)] hover:text-[var(--ds-ink)]" aria-label="Clear search">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${TRANSITION} ${
                cat === c ? 'border-transparent bg-[var(--ds-accent)] text-white' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
              }`}
            >
              {c} <span className={cat === c ? 'opacity-80' : 'opacity-60'}>{CATEGORY_COUNT[c] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Body — master list + detail. */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* List */}
        <div className="shrink-0 overflow-y-auto border-b border-[var(--ds-hairline)] p-2 md:max-h-none md:w-72 md:border-b-0 md:border-r" style={{ maxHeight: '38vh' }}>
          {filtered.length === 0 && <p className="px-2 py-6 text-center text-xs text-[var(--ds-muted)]">No widgets match “{query}”.</p>}
          {grouped
            ? grouped.map(([category, items]) => (
                <div key={category} className="mb-1">
                  <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-[var(--ds-canvas)] px-3 pb-1 pt-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--ds-muted)]">
                    <span className="truncate">{category}</span>
                    <span className="rounded-full bg-[var(--ds-well-strong)] px-1.5 py-px text-[9px] font-semibold tabular-nums text-[var(--ds-muted)]">{items.length}</span>
                  </div>
                  {items.map(renderItem)}
                </div>
              ))
            : filtered.map(renderItem)}
        </div>

        {/* Detail */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {selected ? (
            <div className="mx-auto w-full max-w-4xl p-3 sm:p-5">
              {/* Title row */}
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold tracking-tight text-[var(--ds-ink)]">{cleanTitle(selected.title)}</h2>
                <Badge kind={selected.kind} />
                {selected.type && <code className="rounded bg-[var(--ds-well-strong)] px-1.5 py-0.5 text-[11px] text-[var(--ds-muted)]">{selected.type}</code>}
                {onTry && selected.kind !== 'static' && (
                  <button
                    onClick={() => onTry((selected.type && EXAMPLE_PROMPT[selected.type]) || `Show me a ${cleanTitle(selected.title).toLowerCase()}`)}
                    className="ml-auto inline-flex items-center gap-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]"
                    title="Seed a new chat with a prompt that produces this widget (live data)"
                  >
                    <Sparkles className="h-3.5 w-3.5 text-[var(--ds-accent)]" /> Open in chat
                  </button>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {selected.tags.map((t) => (
                  <span key={t} className="rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2 py-0.5 text-[10px] font-medium text-[var(--ds-muted)]">{t}</span>
                ))}
              </div>

              {/* Preview ⇄ Spec toggle */}
              <div className="mt-3 flex items-center gap-2">
                <div className="inline-flex rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well-strong)] p-0.5 text-[11px] font-semibold">
                  {([['preview', Eye, 'Preview'], ['spec', Braces, 'Spec']] as const).map(([id, Icon, label]) => (
                    <button
                      key={id}
                      onClick={() => setTab(id)}
                      className={`flex items-center gap-1 rounded-md px-2.5 py-1 ${TRANSITION} ${
                        tab === id ? 'bg-[var(--ds-raised)] text-[var(--ds-ink)] shadow-[0_1px_2px_rgba(0,0,0,0.12)]' : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" /> {label}
                    </button>
                  ))}
                </div>
                {tab === 'preview' && selected.densityAware && (
                  <div className="inline-flex rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well-strong)] p-0.5 text-[11px] font-semibold">
                    {(['compact', 'detailed'] as const).map((d) => (
                      <button
                        key={d}
                        onClick={() => setDensity(d)}
                        className={`rounded-md px-2 py-1 capitalize ${TRANSITION} ${density === d ? 'bg-[var(--ds-raised)] text-[var(--ds-ink)]' : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'}`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                )}
                {tab === 'preview' && selected.refreshable && (
                  <button
                    onClick={loadLive}
                    disabled={liveForSelected?.loading}
                    className="ml-auto inline-flex items-center gap-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] disabled:opacity-50"
                    title="Fetch real live data from this widget's tool"
                  >
                    {liveForSelected?.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5 text-[var(--ds-accent)]" />}
                    Load live data
                  </button>
                )}
              </div>

              {/* Panel */}
              {tab === 'preview' ? (
                <div className="mt-3 rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-canvas)] p-3 sm:p-5">
                  {liveForSelected?.error && (
                    <p className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600">
                      Live fetch failed ({liveForSelected.error}) — showing the sample. Live providers may need API keys configured on the server.
                    </p>
                  )}
                  <div className="mx-auto max-w-xl">
                    <DensityProvider value={selected.densityAware ? density : 'detailed'}>
                      {liveForSelected?.node ?? selected.node}
                    </DensityProvider>
                  </div>
                </div>
              ) : (
                <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {/* Connection / technical spec */}
                  <div className="rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] p-3">
                    <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[var(--ds-muted)]">Connection & spec</div>
                    <dl>
                      <SpecRow label="Artifact type"><code className="font-mono">{selected.type ?? '—'}</code></SpecRow>
                      <SpecRow label="Primary source"><code className="font-mono">{selected.tool ?? (selected.kind === 'model-authored' ? 'model-authored' : '—')}</code></SpecRow>
                      <SpecRow label="Kind">{KIND_LABEL[selected.kind]}</SpecRow>
                      <SpecRow label="Provider">{selected.toolMeta?.provider}</SpecRow>
                      <SpecRow label="Auth">{selected.toolMeta?.auth}{selected.toolMeta?.authEnv ? ` · ${selected.toolMeta.authEnv}` : ''}</SpecRow>
                      <SpecRow label="Rate limit">{selected.toolMeta?.rateLimit}</SpecRow>
                      <SpecRow label="License">{selected.toolMeta?.license}</SpecRow>
                      <SpecRow label="Live refresh">{selected.refreshable ? 'Yes (pinnable · auto-refresh)' : 'No (snapshot)'}</SpecRow>
                      <SpecRow label="Density">{selected.densityAware ? 'Compact + detailed' : 'Single (clamped compact)'}</SpecRow>
                      <SpecRow label="Category">{selected.category}</SpecRow>
                      <SpecRow label="Docs">
                        {selected.toolMeta?.docsUrl && (
                          <a href={selected.toolMeta.docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-[var(--ds-accent)] hover:underline">
                            {new URL(selected.toolMeta.docsUrl).hostname} <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </SpecRow>
                    </dl>
                    {/* Data sources — a visual is decoupled from any one source; these are
                        all the tools/APIs that can feed it (and render_* accept anything). */}
                    {selected.sources.length > 0 && (
                      <div className="mt-2">
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">
                          Data sources{selected.sources.length > 1 ? ` (${selected.sources.length})` : ''}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {selected.sources.map((s) => (
                            <span key={s.tool} title={s.meta?.provider} className="inline-flex items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2 py-0.5 text-[10px]">
                              <code className="font-mono text-[var(--ds-ink)]">{s.tool}</code>
                              {s.meta?.provider && <span className="text-[var(--ds-muted)]">· {s.meta.provider}</span>}
                            </span>
                          ))}
                        </div>
                        {selected.multiSource && (
                          <p className="mt-1 text-[10px] text-[var(--ds-muted)]">This visual is general-purpose — the same component renders data from any of these.</p>
                        )}
                      </div>
                    )}
                    {selected.toolMeta?.dataShape && (
                      <p className="mt-2 text-[11px] leading-snug text-[var(--ds-muted)]">
                        <span className="font-semibold text-[var(--ds-ink)]">Data shape: </span>
                        {selected.toolMeta.dataShape}
                      </p>
                    )}
                    {/* Example invocation / prompt */}
                    <div className="mt-2 text-[11px] leading-snug text-[var(--ds-muted)]">
                      <span className="font-semibold text-[var(--ds-ink)]">Example call: </span>
                      {selected.kind === 'model-authored' ? (
                        <>composed directly by the model (no data tool).</>
                      ) : selected.tool ? (
                        <code className="font-mono text-[var(--ds-ink)]">
                          {selected.tool}({selected.widgetDef?.presets?.[0]?.args ? JSON.stringify(selected.widgetDef.presets[0].args) : '…'})
                        </code>
                      ) : (
                        '—'
                      )}
                    </div>
                  </div>

                  {/* JSON payload */}
                  <div className="rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] p-3">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ds-muted)]">Data payload (JSON)</span>
                      {selected.data !== undefined && (
                        <button onClick={copyJson} className="inline-flex items-center gap-1 rounded-md border border-[var(--ds-hairline)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--ds-muted)] hover:text-[var(--ds-ink)]">
                          {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />} {copied ? 'Copied' : 'Copy'}
                        </button>
                      )}
                    </div>
                    {selected.data !== undefined ? (
                      <pre className="max-h-[420px] overflow-auto rounded-lg bg-[var(--ds-well-strong)] p-2.5 text-[11px] leading-snug text-[var(--ds-ink)]">
                        <code className="font-mono">{safeJson(selected.data)}</code>
                      </pre>
                    ) : (
                      <p className="rounded-lg bg-[var(--ds-well-strong)] p-2.5 text-[11px] text-[var(--ds-muted)]">
                        Composite / model-rendered widget — no single data payload (it assembles other artifacts or is composed live).
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-[var(--ds-muted)]">Select a widget.</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default GalleryStudio;
