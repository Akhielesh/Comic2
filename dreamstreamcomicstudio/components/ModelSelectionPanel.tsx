import React, { useEffect, useMemo, useState } from 'react';
import { Image as ImageIcon, Type as TypeIcon, Loader2, AlertTriangle, Sparkles, Search, ChevronDown, Check, Lock } from 'lucide-react';
import { fetchModelCatalog, SOURCE_LABEL, type CatalogModel, type ModelSource } from '../services/modelCatalog';
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
import { getActiveKey } from '../services/apiKeys';
import { getCapabilities, featureSupport } from '../services/modelCapabilities';

// Planning stages that need structured (JSON) output. Surfaced under "Advanced" so a
// user can pin a specific model per stage; models without JSON are flagged (the server
// still gates + falls back, but this prevents a surprising downgrade).
const STRUCTURED_TEXT_STAGES: { stage: string; label: string }[] = [
  { stage: 'analyze_script', label: 'Script analysis' },
  { stage: 'extract_world', label: 'World extraction' },
  { stage: 'panel_breakdown', label: 'Panel breakdown' },
  { stage: 'continuity_audit', label: 'Continuity audit' }
];

const SourceBadge: React.FC<{ source?: ModelSource }> = ({ source }) =>
  source ? (
    <span className="text-[9px] font-bold uppercase px-1 py-0.5 rounded border border-black bg-slate-100 text-slate-600 shrink-0">
      {SOURCE_LABEL[source] || source}
    </span>
  ) : null;

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
      {tags.map((t) => (
        <span key={t} className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border border-black bg-slate-100">{t}</span>
      ))}
    </div>
  );
};

/**
 * A searchable, source-aware model picker.
 *
 * Replaces the old native <select> (which had no search and — critically — never
 * recorded the model's *source*). When you pick a model we persist its source
 * alongside the id via setSelectedModel(), so usage attribution, the header pill,
 * and server routing all reflect the source actually in use (e.g. NVIDIA stays
 * NVIDIA instead of silently defaulting to OpenRouter).
 */
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

  const choose = (model: CatalogModel | null) => {
    setSelectedModel(slot, model ? model.id : null, model ? 'specific' : 'default', model?.source ?? null);
    setOpen(false);
    setQuery('');
  };

  return (
    <div className="border-2 border-black rounded-lg p-3 bg-white">
      <div className="flex items-center gap-2 text-sm font-bold mb-2">{icon} {label}</div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 border-2 border-black rounded px-2 py-1.5 text-sm bg-white text-left"
      >
        <span className="truncate flex items-center gap-1.5">
          {selected ? (
            <>
              <SourceBadge source={selected.source} />
              <span className="truncate">{selected.name}</span>
              {selected.isFree && <span className="text-[10px] font-bold text-green-700">· free</span>}
            </>
          ) : (
            <span className="text-slate-600">Auto — best model, free-first (recommended)</span>
          )}
        </span>
        <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="mt-2 border-2 border-black rounded-lg overflow-hidden shadow-comic">
          <div className="relative border-b-2 border-black">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${label.toLowerCase()} models or source…`}
              className="w-full pl-7 pr-2 py-1.5 text-sm focus:outline-none"
            />
          </div>
          <div className="max-h-60 overflow-y-auto">
            <button
              type="button"
              onClick={() => choose(null)}
              className={`w-full text-left px-2 py-1.5 text-sm hover:bg-brand-yellow/20 border-b border-slate-100 ${selectedId ? '' : 'bg-brand-blue/10 font-bold'}`}
            >
              Auto — best model, free-first
            </button>
            {filtered.length === 0 ? (
              <div className="px-2 py-3 text-xs text-slate-400">No models match “{query}”.</div>
            ) : (
              filtered.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => choose(m)}
                  className={`w-full text-left px-2 py-1.5 text-sm hover:bg-brand-yellow/20 border-b border-slate-100 flex items-center gap-1.5 ${m.id === selectedId ? 'bg-brand-blue/10' : ''}`}
                >
                  <SourceBadge source={m.source} />
                  <span className="truncate flex-1">{m.name}</span>
                  {m.isFree && <span className="text-[10px] font-bold text-green-700">free</span>}
                  {m.id === selectedId && <Check className="w-3.5 h-3.5 text-brand-blue shrink-0" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {selected ? (
        <CapBadges model={selected} />
      ) : (
        <div className="text-[11px] text-slate-500 mt-1">Auto-selected (prefers free when available).</div>
      )}
      {selected && slot === 'image' && !getCapabilities(selected).multiImageRefs && (
        <div className="text-[11px] text-amber-700 mt-1 flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
          {featureSupport(getCapabilities(selected), 'character-consistency').reason}
        </div>
      )}
      {selected && slot === 'text' && !getCapabilities(selected).structuredJson && (
        <div className="text-[11px] text-amber-700 mt-1 flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
          No structured-output mode — planning steps (script, world, panels, audit) will use a JSON-capable model instead.
        </div>
      )}
    </div>
  );
};

/**
 * Default / Free / Specific model selection for image and text, driven by the live
 * model catalog (OpenRouter + any connected NVIDIA key). Reflected everywhere via
 * modelSelection (pill, editor, checklist).
 */
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

  // A hard lock restricts the entire library (and all routing) to one source.
  const locked = (sel.lockedSource ?? null) as ModelSourceId | null;
  const inScope = (m: CatalogModel) => !locked || m.source === locked;
  const imageModels = useMemo(() => catalog.filter((m) => m.supportsImageOutput && inScope(m)), [catalog, locked]);
  const textModels = useMemo(() => catalog.filter((m) => !m.supportsImageOutput && inScope(m)), [catalog, locked]);
  const hasOpenRouter = !!getActiveKey('openrouter');
  const hasNvidia = !!getActiveKey('nvidia');

  const textModelObj = useMemo(() => catalog.find((m) => m.id === sel.textModel) || null, [catalog, sel.textModel]);
  const imageModelObj = useMemo(() => catalog.find((m) => m.id === sel.imageModel) || null, [catalog, sel.imageModel]);

  return (
    <div className="bg-white border-2 border-black rounded-xl shadow-comic p-4 space-y-3">
      <div>
        <h4 className="font-display text-lg flex items-center gap-2"><Sparkles className="w-4 h-4" /> Models</h4>
        <p className="text-[11px] text-slate-500">Search and pick the image and text models, or leave on Auto. Each model shows its source (OpenRouter / NVIDIA) — the source you pick is the one billed and used.</p>
      </div>

      {/* Hard source lock — restrict the whole library AND all routing to one source. */}
      <div className={`border-2 rounded-lg p-2.5 ${locked ? 'border-black bg-brand-blue/10' : 'border-slate-300 bg-white'}`}>
        <label className="flex items-center gap-2 text-xs font-bold">
          <Lock className="w-3.5 h-3.5 shrink-0" />
          Lock to one source
          <select
            value={locked || ''}
            onChange={(e) => setLockedSource((e.target.value || null) as ModelSourceId | null)}
            className="ml-auto border-2 border-black rounded px-2 py-1 bg-white font-normal"
          >
            <option value="">Off — use any source</option>
            <option value="nvidia">NVIDIA Build only{hasNvidia ? '' : ' — no key'}</option>
            <option value="openrouter">OpenRouter only{hasOpenRouter ? '' : ' — no key'}</option>
          </select>
        </label>
        {locked && (
          <p className="text-[11px] text-slate-600 mt-1.5">
            Only <span className="font-bold">{SOURCE_LABEL[locked]}</span> models are shown and used — every image,
            text, and per-stage call routes to {SOURCE_LABEL[locked]} with no fallback to other providers.
            {locked === 'nvidia' && !hasNvidia && ' Add an NVIDIA key above to generate.'}
            {locked === 'openrouter' && !hasOpenRouter && ' Add an OpenRouter key above to generate.'}
          </p>
        )}
      </div>

      {!hasOpenRouter && !hasNvidia && (
        <div className="text-[11px] bg-amber-100 border-2 border-black rounded-lg p-2 flex gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          Add an OpenRouter or NVIDIA key above to use these models for generation.
        </div>
      )}

      {!loading && !degraded && (
        <div className="border-2 border-black rounded-lg bg-slate-50 p-2.5 text-xs space-y-1.5">
          <div className="text-[10px] font-bold uppercase text-slate-500">Active generation sources</div>
          {[
            { slot: 'text' as const, label: 'Text', model: textModelObj, source: sel.textSource ?? sel.preferredTextSource },
            { slot: 'image' as const, label: 'Image', model: imageModelObj, source: sel.imageSource ?? sel.preferredImageSource }
          ].map(({ slot, label, model, source }) => {
            const src = (source || null) as ModelSource | null;
            const pinned = !!model;
            const key = src ? getActiveKey(src) : null;
            return (
              <div key={slot} className="flex items-center gap-1.5 flex-wrap">
                <span className="font-bold w-12 shrink-0">{label}</span>
                {!src ? (
                  <span className="text-slate-500">Auto — server picks (free-first)</span>
                ) : (
                  <>
                    <SourceBadge source={src} />
                    <span className="truncate max-w-[11rem]">{pinned ? model!.name : 'Auto (default source)'}</span>
                    {key ? (
                      <span className="text-green-700 font-bold flex items-center gap-0.5"><Check className="w-3 h-3" /> {key.label}</span>
                    ) : (
                      <span className="text-amber-700 font-bold flex items-center gap-0.5">
                        <AlertTriangle className="w-3 h-3" /> No {SOURCE_LABEL[src]} key — add one above
                      </span>
                    )}
                  </>
                )}
              </div>
            );
          })}

          <div className="pt-1.5 mt-0.5 border-t border-dashed border-slate-300">
            <div className="text-[10px] font-bold uppercase text-slate-500 mb-1">
              Preferred default source <span className="font-normal normal-case text-slate-400">
                {locked ? `— overridden while locked to ${SOURCE_LABEL[locked]}` : '— used for Auto, when no model is pinned'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {([
                { slot: 'text' as ModelSlot, label: 'Text', value: sel.preferredTextSource },
                { slot: 'image' as ModelSlot, label: 'Image', value: sel.preferredImageSource }
              ]).map(({ slot, label, value }) => (
                <label key={slot} className={`flex flex-col gap-0.5 ${locked ? 'opacity-50' : ''}`}>
                  <span className="font-bold">{label}</span>
                  <select
                    value={locked ? '' : (value || '')}
                    disabled={!!locked}
                    onChange={(e) => setPreferredSource(slot, (e.target.value || null) as ModelSource | null)}
                    className="border-2 border-black rounded px-2 py-1 bg-white disabled:bg-slate-100"
                  >
                    <option value="">Auto (server default)</option>
                    <option value="openrouter">OpenRouter{hasOpenRouter ? '' : ' — no key'}</option>
                    <option value="nvidia">NVIDIA{hasNvidia ? '' : ' — no key'}</option>
                  </select>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-slate-400 text-sm py-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading live model catalog…</div>
      ) : degraded ? (
        <div className="text-[11px] bg-amber-100 border-2 border-black rounded-lg p-2">Live catalog unavailable — Auto will be used. Add an OpenRouter key or set OPENROUTER_API_KEY.</div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          <Slot slot="image" icon={<ImageIcon className="w-4 h-4" />} label="Image" models={imageModels} selectedId={sel.imageModel} />
          <Slot slot="text" icon={<TypeIcon className="w-4 h-4" />} label="Text" models={textModels} selectedId={sel.textModel} />
        </div>
      )}

      {!loading && !degraded && textModels.length > 0 && (
        <div className="border-t-2 border-black/10 pt-2">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="text-[11px] font-bold uppercase tracking-wide text-slate-600 hover:text-black"
          >
            {showAdvanced ? '▾' : '▸'} Advanced — per-stage text model
          </button>
          {showAdvanced && (
            <div className="mt-2 space-y-2">
              <p className="text-[11px] text-slate-500">
                Override the text model for specific planning steps. These steps need structured (JSON)
                output — models without it are flagged, and the server falls back to a capable model.
              </p>
              {STRUCTURED_TEXT_STAGES.map(({ stage, label }) => {
                const current = sel.byStage?.[stage] || '';
                const selectedModel = textModels.find((m) => m.id === current);
                const lacksJson = !!selectedModel && !getCapabilities(selectedModel).structuredJson;
                return (
                  <div key={stage} className="flex flex-col gap-1">
                    <label className="text-[11px] font-bold">{label}</label>
                    <select
                      value={current}
                      onChange={(e) => {
                        const id = e.target.value || null;
                        const model = id ? textModels.find((m) => m.id === id) : null;
                        setStageModel(stage, id, model?.source ?? null);
                      }}
                      className="w-full border-2 border-black rounded px-2 py-1 text-xs bg-white"
                    >
                      <option value="">Use Text model above</option>
                      {textModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          [{SOURCE_LABEL[m.source] || m.source}] {m.name}{m.isFree ? ' · free' : ''}{getCapabilities(m).structuredJson ? '' : ' · no JSON'}
                        </option>
                      ))}
                    </select>
                    {lacksJson && (
                      <div className="text-[11px] text-amber-700 flex items-start gap-1">
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
