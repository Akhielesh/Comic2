import React, { useEffect, useMemo, useState } from 'react';
import { Image as ImageIcon, Type as TypeIcon, Loader2, AlertTriangle, Sparkles, Search, ChevronDown, Check, Lock, Layers } from 'lucide-react';
import { groupModelsBySource, axisDisplay, DIFF_AXIS_LABEL, SOURCE_HOSTING } from '../services/modelGrouping';
import { fetchModelCatalog, SOURCE_LABEL, sourceShortLabel, type CatalogModel, type ModelSource } from '../services/modelCatalog';
import {
  getModelSelection,
  setSelectedModel,
  setStageModel,
  setPreferredSource,
  setLockedSource,
  MODEL_SELECTION_CHANGED,
  type ModelSlot,
  type ModelSourceId
} from '../services/modelSelection';
import { getActiveKey, hasUsableKey } from '../services/apiKeys';
import { getCapabilities, featureSupport } from '../services/modelCapabilities';
import { useModelSourceScope } from '../hooks/useModelSourceScope';
import { PROVIDERS_ORDERED, getProviderDef } from '../shared/providers';
import {
  GLASS, HAIRLINE, SHADOW_SOFT, INK, MUTED, HEADING, TRANSITION, ACCENT_TEXT, ACCENT_SOFT_BG, MENU
} from './chat/studioDesign';

const PANEL = `${GLASS} ${HAIRLINE} ${SHADOW_SOFT} rounded-2xl`;
const SELECT = `${HAIRLINE} rounded-lg px-2 py-1 text-xs bg-[var(--ds-surface-soft)] text-[var(--ds-ink)] outline-none ${TRANSITION}`;
const CHIP = `text-[9px] font-semibold uppercase px-1 py-0.5 rounded ${HAIRLINE} bg-[var(--ds-well)] ${MUTED} shrink-0`;

// Planning stages that need structured (JSON) output.
const STRUCTURED_TEXT_STAGES: { stage: string; label: string }[] = [
  { stage: 'analyze_script', label: 'Script analysis' },
  { stage: 'extract_world', label: 'World extraction' },
  { stage: 'panel_breakdown', label: 'Panel breakdown' },
  { stage: 'continuity_audit', label: 'Continuity audit' }
];

const SourceBadge: React.FC<{ source?: ModelSource }> = ({ source }) => {
  if (!source) return null;
  const def = getProviderDef(source);
  return (
    <span className={`${CHIP} flex items-center gap-1`}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: def?.accent || 'var(--ds-muted)' }} />
      {sourceShortLabel(source)}
    </span>
  );
};

const DownloadOnlyBadge: React.FC = () => (
  <span
    className="text-[9px] font-semibold uppercase px-1 py-0.5 rounded border border-amber-400/50 bg-amber-500/10 text-amber-600 shrink-0"
    title="Listed on NVIDIA Build but download-only — not callable via the hosted API"
  >
    Download-only
  </span>
);

const CapBadges: React.FC<{ model?: CatalogModel }> = ({ model }) => {
  if (!model) return null;
  const c = getCapabilities(model);
  const tags: string[] = [];
  if (c.isFree) tags.push('Free');
  if (c.imageEditing) tags.push('Editing');
  if (c.multiImageRefs) tags.push('Character refs');
  else if (c.imageInput) tags.push('Refs');
  if (c.structuredJson) tags.push('JSON');
  if (c.longContext) tags.push('Long ctx');
  if (c.isPremium) tags.push('Premium');
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {tags.map((t) => <span key={t} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${HAIRLINE} bg-[var(--ds-well)] ${MUTED}`}>{t}</span>)}
    </div>
  );
};

const Slot: React.FC<{
  slot: ModelSlot;
  icon: React.ReactNode;
  label: string;
  models: CatalogModel[];
  selectedId: string | null;
}> = ({ slot, icon, label, models, selectedId }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = models.find((m) => m.id === selectedId) || null;

  const filtered = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (!tokens.length) return models;
    return models.filter((m) => {
      const haystack = `${m.id} ${m.name} ${m.source} ${SOURCE_LABEL[m.source] || ''} ${m.isFree ? 'free' : ''}`.toLowerCase();
      return tokens.every((t) => haystack.includes(t));
    });
  }, [models, query]);

  const groups = useMemo(() => groupModelsBySource(filtered), [filtered]);

  const choose = (model: CatalogModel | null) => {
    setSelectedModel(slot, model ? model.id : null, model ? 'specific' : 'default', model?.source ?? null);
    setOpen(false);
    setQuery('');
  };

  const rowClass = (id: string) =>
    `w-full text-left px-2 py-1.5 text-sm hover:bg-[var(--ds-hover)] border-b border-[var(--ds-hairline)] flex items-center gap-1.5 flex-wrap ${TRANSITION} ${id === selectedId ? ACCENT_SOFT_BG : ''}`;

  return (
    <div className={`${HAIRLINE} rounded-xl p-3 bg-[var(--ds-surface-soft)]`}>
      <div className={`flex items-center gap-2 text-sm font-semibold mb-2 ${INK}`}>{icon} {label}</div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center justify-between gap-2 ${HAIRLINE} rounded-lg px-2 py-1.5 text-sm bg-[var(--ds-surface)] text-left ${TRANSITION}`}
      >
        <span className="truncate flex items-center gap-1.5">
          {selected ? (
            <>
              <SourceBadge source={selected.source} />
              <span className={`truncate ${INK}`}>{selected.name}</span>
              {selected.isFree && <span className="text-[10px] font-semibold text-green-600">· free</span>}
            </>
          ) : (
            <span className={MUTED}>Auto — best model, free-first (recommended)</span>
          )}
        </span>
        <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${MUTED} ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className={`mt-2 ${MENU} overflow-hidden`}>
          <div className="relative border-b border-[var(--ds-hairline)]">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--ds-muted)]" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${label.toLowerCase()} models or source…`}
              className="w-full pl-7 pr-2 py-1.5 text-sm bg-transparent focus:outline-none text-[var(--ds-ink)]"
            />
          </div>
          <div className="max-h-60 overflow-y-auto">
            <button
              type="button"
              onClick={() => choose(null)}
              className={`w-full text-left px-2 py-1.5 text-sm hover:bg-[var(--ds-hover)] border-b border-[var(--ds-hairline)] ${TRANSITION} ${selectedId ? '' : `${ACCENT_SOFT_BG} font-semibold`}`}
            >
              Auto — best model, free-first
            </button>
            {groups.length === 0 ? (
              <div className={`px-2 py-3 text-xs ${MUTED}`}>No models match “{query}”.</div>
            ) : (
              groups.map((g) => {
                if (g.variants.length === 1) {
                  const m = g.variants[0];
                  const dl = m.apiCallable === false;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => choose(m)}
                      disabled={dl}
                      title={dl ? 'Download-only on NVIDIA — not callable via the hosted API' : SOURCE_HOSTING[m.source]}
                      className={`${rowClass(m.id)} ${dl ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <SourceBadge source={m.source} />
                      <span className={`truncate flex-1 min-w-0 ${INK}`}>{m.name}</span>
                      {dl && <DownloadOnlyBadge />}
                      {m.isFree && !dl && <span className="text-[10px] font-semibold text-green-600">free</span>}
                      {m.id === selectedId && <Check className={`w-3.5 h-3.5 ${ACCENT_TEXT} shrink-0`} />}
                    </button>
                  );
                }
                return (
                  <div key={g.key} className="border-b border-[var(--ds-hairline)] bg-[var(--ds-well)]">
                    <div className="px-2 pt-1.5 pb-0.5 flex items-center gap-1.5">
                      <Layers className="w-3 h-3 text-[var(--ds-muted)] shrink-0" />
                      <span className={`font-semibold text-[12px] truncate flex-1 min-w-0 ${INK}`}>{g.name}</span>
                      <span className={CHIP}>
                        {g.variants.length} {g.multiSource ? 'sources' : 'variants'} · {g.identical ? 'identical' : 'differ'}
                      </span>
                    </div>
                    {g.identical ? (
                      <div className={`px-2 pb-1 text-[10px] ${MUTED}`}>Same specs — just pick a source (hosting differs).</div>
                    ) : (
                      <div className={`px-2 pb-1 text-[10px] ${MUTED}`}>Differs by: {g.differences.map((d) => DIFF_AXIS_LABEL[d]).join(', ')}</div>
                    )}
                    {g.variants.map((m) => {
                      const dl = m.apiCallable === false;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => choose(m)}
                          disabled={dl}
                          title={dl ? 'Download-only on NVIDIA — not callable via the hosted API' : SOURCE_HOSTING[m.source]}
                          className={`${rowClass(m.id)} pl-6 ${dl ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                          <SourceBadge source={m.source} />
                          <span className={`font-semibold shrink-0 ${INK}`}>{sourceShortLabel(m.source)}</span>
                          {dl && <DownloadOnlyBadge />}
                          {m.isFree && !dl && <span className="text-[10px] font-semibold text-green-600">free</span>}
                          {g.differences.map((axis) => (
                            <span key={axis} className={`text-[9px] px-1 py-0.5 rounded ${HAIRLINE} bg-[var(--ds-surface)] ${MUTED}`}>
                              {axisDisplay(m, axis)}
                            </span>
                          ))}
                          {m.id === selectedId && <Check className={`w-3.5 h-3.5 ${ACCENT_TEXT} shrink-0 ml-auto`} />}
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {selected ? (
        <CapBadges model={selected} />
      ) : (
        <div className={`text-[11px] ${MUTED} mt-1`}>Auto-selected (prefers free when available).</div>
      )}
      {selected && slot === 'image' && !getCapabilities(selected).multiImageRefs && (
        <div className="text-[11px] text-amber-600 mt-1 flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
          {featureSupport(getCapabilities(selected), 'character-consistency').reason}
        </div>
      )}
      {selected && slot === 'text' && !getCapabilities(selected).structuredJson && (
        <div className="text-[11px] text-amber-600 mt-1 flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
          No structured-output mode — planning steps (script, world, panels, audit) will use a JSON-capable model instead.
        </div>
      )}
    </div>
  );
};

export const ModelSelectionPanel: React.FC = () => {
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [degraded, setDegraded] = useState(false);
  const [sel, setSel] = useState(getModelSelection());
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    let active = true;
    fetchModelCatalog()
      .then((res) => { if (active) { setCatalog(res.models); setDegraded(res.degraded); } })
      .catch(() => { if (active) setDegraded(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const h = () => setSel(getModelSelection());
    window.addEventListener(MODEL_SELECTION_CHANGED, h);
    return () => window.removeEventListener(MODEL_SELECTION_CHANGED, h);
  }, []);

  const sourceScope = useModelSourceScope();
  const locked = (sel.lockedSource ?? null) as ModelSourceId | null;
  const inScope = (m: CatalogModel) => sourceScope.active.includes(m.source) && (!locked || m.source === locked);
  const imageModels = useMemo(() => catalog.filter((m) => m.supportsImageOutput && inScope(m)), [catalog, locked, sourceScope]);
  const textModels = useMemo(() => catalog.filter((m) => !m.supportsImageOutput && inScope(m)), [catalog, locked, sourceScope]);
  const sourceAvailable = (s: ModelSourceId) => sourceScope.active.includes(s);
  const sourceUnavailableNote = (s: ModelSourceId): string => {
    if (sourceScope.active.includes(s)) return '';
    return sourceScope.hidden.includes(s) ? ' — no key connected' : ' — off in Settings';
  };

  // Every source that appears in the catalog, in registry order — the source options that
  // can be locked/preferred (so the new providers are selectable, not just OR/NVIDIA).
  const sourcesInCatalog = useMemo(() => {
    const present = new Set(catalog.map((m) => m.source));
    return PROVIDERS_ORDERED.filter((d) => present.has(d.id));
  }, [catalog]);

  const noConnectedKey = sourceScope.reason === 'enabled' || sourceScope.active.every((s) => !hasUsableKey(s));

  const textModelObj = useMemo(() => catalog.find((m) => m.id === sel.textModel) || null, [catalog, sel.textModel]);
  const imageModelObj = useMemo(() => catalog.find((m) => m.id === sel.imageModel) || null, [catalog, sel.imageModel]);

  return (
    <div className={`${PANEL} p-4 space-y-3`}>
      <div>
        <h4 className={`${HEADING} text-base flex items-center gap-2`}><Sparkles className={`w-4 h-4 ${ACCENT_TEXT}`} /> Default models</h4>
        <p className={`text-[11px] ${MUTED}`}>Search and pick the image and text models, or leave on Auto. Each model shows its provider — the source you pick is the one billed and used.</p>
        {sourceScope.reason === 'connected' && (
          <p className={`text-[11px] ${MUTED} mt-1`}>
            Scoped to your connected source{sourceScope.active.length > 1 ? 's' : ''}:{' '}
            <span className={`font-semibold ${INK}`}>{sourceScope.active.map((s) => sourceShortLabel(s)).join(' + ')}</span>
            {sourceScope.hidden.length > 0 && <> — {sourceScope.hidden.map((s) => sourceShortLabel(s)).join(' + ')} is hidden until you add a key</>}
            {sourceScope.active.length > 1 && <>. The same model on several sources asks you to pick one</>}.
          </p>
        )}
        {sourceScope.reason === 'none' && (
          <p className="text-[11px] text-red-600 font-semibold mt-1 flex items-start gap-1">
            <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
            All model sources are off in Settings → Providers, so there are no models to pick.
          </p>
        )}
      </div>

      {/* Hard source lock — restrict the whole library AND all routing to one source. */}
      <div className={`${HAIRLINE} rounded-xl p-2.5 ${locked ? ACCENT_SOFT_BG : 'bg-[var(--ds-surface-soft)]'}`}>
        <label className={`flex items-center gap-2 text-xs font-semibold ${INK}`}>
          <Lock className="w-3.5 h-3.5 shrink-0" />
          Lock to one provider
          <select
            value={locked || ''}
            onChange={(e) => setLockedSource((e.target.value || null) as ModelSourceId | null)}
            className={`ml-auto ${SELECT} font-normal`}
          >
            <option value="">Off — use any active source</option>
            {sourcesInCatalog.map((d) => (
              <option key={d.id} value={d.id} disabled={!sourceAvailable(d.id)}>{d.label} only{sourceUnavailableNote(d.id)}</option>
            ))}
          </select>
        </label>
        {locked && (
          <p className={`text-[11px] ${MUTED} mt-1.5`}>
            Only <span className={`font-semibold ${INK}`}>{SOURCE_LABEL[locked]}</span> models are shown and used — every image,
            text, and per-stage call routes to {SOURCE_LABEL[locked]} with no fallback.
            {!hasUsableKey(locked) && !getProviderDef(locked)?.platformServed && ` Add a ${SOURCE_LABEL[locked]} key above to generate.`}
          </p>
        )}
      </div>

      {noConnectedKey && (
        <div className={`text-[11px] bg-amber-500/10 ${HAIRLINE} rounded-xl p-2 flex gap-1.5 ${INK}`}>
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-500" />
          Add a provider key above to use these models for generation. Platform-served providers (OpenRouter, NVIDIA, Gemini) also work on the shared allowance.
        </div>
      )}

      {!loading && !degraded && (
        <div className={`${HAIRLINE} rounded-xl bg-[var(--ds-surface-soft)] p-2.5 text-xs space-y-1.5`}>
          <div className={`text-[10px] font-semibold uppercase ${MUTED}`}>Active generation sources</div>
          {[
            { slot: 'text' as const, label: 'Text', model: textModelObj, source: sel.textSource ?? sel.preferredTextSource },
            { slot: 'image' as const, label: 'Image', model: imageModelObj, source: sel.imageSource ?? sel.preferredImageSource }
          ].map(({ slot, label, model, source }) => {
            const src = (source || null) as ModelSource | null;
            const pinned = !!model;
            const key = src ? getActiveKey(src) : null;
            return (
              <div key={slot} className="flex items-center gap-1.5 flex-wrap">
                <span className={`font-semibold w-12 shrink-0 ${INK}`}>{label}</span>
                {!src ? (
                  <span className={MUTED}>Auto — server picks (free-first)</span>
                ) : (
                  <>
                    <SourceBadge source={src} />
                    <span className={`truncate max-w-[11rem] ${INK}`}>{pinned ? model!.name : 'Auto (default source)'}</span>
                    {!sourceAvailable(src as ModelSourceId) ? (
                      <span className="text-amber-600 font-semibold flex items-center gap-0.5">
                        <AlertTriangle className="w-3 h-3" /> {SOURCE_LABEL[src]}{sourceUnavailableNote(src as ModelSourceId)} — pick another model or fix it in Settings
                      </span>
                    ) : key ? (
                      <span className="text-green-600 font-semibold flex items-center gap-0.5"><Check className="w-3 h-3" /> {key.label}</span>
                    ) : getProviderDef(src)?.platformServed ? (
                      <span className={`${MUTED} flex items-center gap-0.5`}>platform-served</span>
                    ) : (
                      <span className="text-amber-600 font-semibold flex items-center gap-0.5">
                        <AlertTriangle className="w-3 h-3" /> No {SOURCE_LABEL[src]} key — add one above
                      </span>
                    )}
                  </>
                )}
              </div>
            );
          })}

          <div className="pt-1.5 mt-0.5 border-t border-dashed border-[var(--ds-hairline)]">
            <div className={`text-[10px] font-semibold uppercase ${MUTED} mb-1`}>
              Preferred default source <span className="font-normal normal-case opacity-70">
                {locked ? `— overridden while locked to ${SOURCE_LABEL[locked]}` : '— used for Auto, when no model is pinned'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {([
                { slot: 'text' as ModelSlot, label: 'Text', value: sel.preferredTextSource },
                { slot: 'image' as ModelSlot, label: 'Image', value: sel.preferredImageSource }
              ]).map(({ slot, label, value }) => (
                <label key={slot} className={`flex flex-col gap-0.5 ${locked ? 'opacity-50' : ''}`}>
                  <span className={`font-semibold ${INK}`}>{label}</span>
                  <select
                    value={locked ? '' : (value || '')}
                    disabled={!!locked}
                    onChange={(e) => setPreferredSource(slot, (e.target.value || null) as ModelSource | null)}
                    className={`${SELECT} disabled:opacity-60`}
                  >
                    <option value="">Auto (server default)</option>
                    {sourcesInCatalog.map((d) => (
                      <option key={d.id} value={d.id} disabled={!sourceAvailable(d.id)}>{d.short}{sourceUnavailableNote(d.id)}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className={`flex items-center gap-2 ${MUTED} text-sm py-4`}><Loader2 className="w-4 h-4 animate-spin" /> Loading live model catalog…</div>
      ) : degraded ? (
        <div className={`text-[11px] bg-amber-500/10 ${HAIRLINE} rounded-xl p-2 ${INK}`}>Live catalog unavailable — Auto will be used. Add an OpenRouter key or set OPENROUTER_API_KEY.</div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          <Slot slot="image" icon={<ImageIcon className="w-4 h-4" />} label="Image" models={imageModels} selectedId={sel.imageModel} />
          <Slot slot="text" icon={<TypeIcon className="w-4 h-4" />} label="Text" models={textModels} selectedId={sel.textModel} />
        </div>
      )}

      {!loading && !degraded && textModels.length > 0 && (
        <div className="border-t border-[var(--ds-hairline)] pt-2">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className={`text-[11px] font-semibold uppercase tracking-wide ${MUTED} hover:text-[var(--ds-ink)] ${TRANSITION}`}
          >
            {showAdvanced ? '▾' : '▸'} Advanced — per-stage text model
          </button>
          {showAdvanced && (
            <div className="mt-2 space-y-2">
              <p className={`text-[11px] ${MUTED}`}>
                Override the text model for specific planning steps. These steps need structured (JSON)
                output — models without it are flagged, and the server falls back to a capable model.
              </p>
              {STRUCTURED_TEXT_STAGES.map(({ stage, label }) => {
                const current = sel.byStage?.[stage] || '';
                const selectedModel = textModels.find((m) => m.id === current);
                const lacksJson = !!selectedModel && !getCapabilities(selectedModel).structuredJson;
                return (
                  <div key={stage} className="flex flex-col gap-1">
                    <label className={`text-[11px] font-semibold ${INK}`}>{label}</label>
                    <select
                      value={current}
                      onChange={(e) => {
                        const id = e.target.value || null;
                        const model = id ? textModels.find((m) => m.id === id) : null;
                        setStageModel(stage, id, model?.source ?? null);
                      }}
                      className={`w-full ${SELECT}`}
                    >
                      <option value="">Use Text model above</option>
                      {textModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          [{sourceShortLabel(m.source)}] {m.name}{m.isFree ? ' · free' : ''}{getCapabilities(m).structuredJson ? '' : ' · no JSON'}
                        </option>
                      ))}
                    </select>
                    {lacksJson && (
                      <div className="text-[11px] text-amber-600 flex items-start gap-1">
                        <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                        No structured-output mode — the server will use a JSON-capable model instead.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
