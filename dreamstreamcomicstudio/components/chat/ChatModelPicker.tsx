import React, { useEffect, useMemo, useState } from 'react';
import { Search, X, Loader2, Check, Sparkles, Globe, Eye, Brain, AlertTriangle, EyeOff, Wand2, Zap, Gauge } from 'lucide-react';
import { ModalPortal } from '../modals/ModalPortal';
import {
  fetchModelCatalog,
  sourceLabel,
  providerOrigin,
  costLabel,
  type CatalogModel
} from '../../services/modelCatalog';
import { getCapabilities } from '../../services/modelCapabilities';
import { searchModels } from '../../services/modelSearch';
import { isProviderEnabled } from '../../services/sourceGovernance';
import { fetchModelSpeed, speedTier, speedLabel, isTimeoutProneFreeModel, type ModelSpeed } from '../../services/modelSpeed';

// Measured-latency badge (from real chat telemetry) so slow models are obvious before
// you pick one — the durable fix for getting stuck on a 60-250s free model.
const SpeedBadge: React.FC<{ speed?: ModelSpeed }> = ({ speed }) => {
  if (!speed) return null;
  const tier = speedTier(speed.p50Ms);
  const cls = tier === 'fast' ? 'bg-green-200' : tier === 'ok' ? 'bg-slate-100' : 'bg-red-200';
  const Icon = tier === 'slow' ? Gauge : Zap;
  return (
    <span
      className={`text-[10px] font-bold px-1.5 py-0.5 rounded border-2 border-black flex items-center gap-0.5 ${cls}`}
      title={`Typical response time, measured from ${speed.samples} recent chats${tier === 'slow' ? ' — this model is slow' : ''}`}
    >
      <Icon className="w-2.5 h-2.5" /> {speedLabel(speed.p50Ms)}
    </span>
  );
};

type LockSource = 'openrouter' | 'nvidia' | null;

interface ChatModelPickerProps {
  selectedModelId: string | null;
  /** True when the current conversation already has messages (switching mid-chat). */
  hasMessages?: boolean;
  /** True when the conversation contains image attachments (needs a vision model). */
  conversationHasImages?: boolean;
  autoMode?: boolean;
  lockedSource?: LockSource;
  onSelect: (model: CatalogModel) => void;
  onSelectAuto: (lockedSource: LockSource) => void;
  onClose: () => void;
}

type Facet = 'all' | 'free' | 'reasoning' | 'vision' | 'web';

const FACETS: { key: Facet; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'free', label: 'Free' },
  { key: 'reasoning', label: 'Reasoning' },
  { key: 'vision', label: 'Vision' },
  { key: 'web', label: 'Web-capable' }
];

const CapabilityChips: React.FC<{ model: CatalogModel; speed?: ModelSpeed }> = ({ model, speed }) => {
  const caps = getCapabilities(model);
  // No measured speed yet AND it's a very large free model → warn it may time out. This is the
  // gap the SpeedBadge can't cover: a model that always times out leaves no latency samples.
  const timeoutProne = !speed && isTimeoutProneFreeModel(model.id, caps.isFree);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <SpeedBadge speed={speed} />
      {timeoutProne && (
        <span
          className="text-[10px] font-bold px-1.5 py-0.5 rounded border-2 border-black bg-red-200 flex items-center gap-0.5"
          title="Very large free model — it often queues on the free tier and can time out. Prefer a smaller/faster model, or use Auto."
        >
          <Gauge className="w-2.5 h-2.5" /> May time out
        </span>
      )}
      {caps.isFree && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border-2 border-black bg-green-200">Free</span>}
      {caps.reasoning && (
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border-2 border-black bg-indigo-200 flex items-center gap-0.5"><Brain className="w-2.5 h-2.5" /> Reason</span>
      )}
      {caps.imageInput && (
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border-2 border-black bg-amber-200 flex items-center gap-0.5"><Eye className="w-2.5 h-2.5" /> Vision</span>
      )}
      {model.source === 'openrouter' && (
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border-2 border-black bg-sky-200 flex items-center gap-0.5"><Globe className="w-2.5 h-2.5" /> Web</span>
      )}
      {typeof model.contextLength === 'number' && model.contextLength > 0 && (
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border-2 border-black bg-slate-100">{Math.round(model.contextLength / 1000)}K ctx</span>
      )}
    </div>
  );
};

export const ChatModelPicker: React.FC<ChatModelPickerProps> = ({ selectedModelId, hasMessages, conversationHasImages, autoMode, lockedSource, onSelect, onSelectAuto, onClose }) => {
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [facet, setFacet] = useState<Facet>('all');
  const [speed, setSpeed] = useState<Record<string, ModelSpeed>>({});
  // Measured per-model latency (best-effort) so the picker can flag slow models.
  useEffect(() => { let on = true; fetchModelSpeed().then((s) => { if (on) setSpeed(s); }); return () => { on = false; }; }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    // Text-capable models only (exclude pure image generators from the chat picker).
    fetchModelCatalog({ modality: 'text' })
      .then((res) => {
        if (!active) return;
        setModels(res.models || []);
        setError(res.degraded ? res.message || 'Catalog is degraded — showing what we could load.' : null);
      })
      .catch((err) => {
        if (!active) return;
        setError(err?.message || 'Failed to load the model catalog.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const filtered = useMemo(() => {
    // Ranked, typo-tolerant search (aliases like "claude" → Anthropic work too),
    // then the facet chips narrow the ranked list.
    return searchModels(models, query).filter((model) => {
      const caps = getCapabilities(model);
      if (facet === 'free' && !caps.isFree) return false;
      if (facet === 'reasoning' && !caps.reasoning) return false;
      if (facet === 'vision' && !caps.imageInput) return false;
      if (facet === 'web' && model.source !== 'openrouter') return false;
      return true;
    });
  }, [models, query, facet]);

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
        <div
          className="bg-white border-4 border-black rounded-2xl shadow-comic w-full max-w-2xl max-h-[85vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-5 py-3 border-b-4 border-black bg-brand-blue text-white rounded-t-xl">
            <h2 className="font-display text-xl flex items-center gap-2"><Sparkles className="w-5 h-5" /> Choose a model</h2>
            <button onClick={onClose} className="border-2 border-black rounded p-1 bg-white text-black hover:bg-brand-yellow"><X className="w-4 h-4" /></button>
          </div>

          <div className="p-4 border-b-2 border-black space-y-3">
            <div className="flex items-center gap-2 border-2 border-black rounded-lg px-3 py-2 bg-white">
              <Search className="w-4 h-4 text-slate-500" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models (name, id, capability)…"
                className="flex-1 outline-none text-sm font-sans bg-transparent"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {FACETS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFacet(f.key)}
                  className={`text-[11px] font-bold px-2.5 py-1 rounded-full border-2 border-black ${facet === f.key ? 'bg-brand-yellow' : 'bg-white hover:bg-slate-100'}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {hasMessages && (
            <div className="mx-4 mt-3 -mb-1 flex items-start gap-2 text-[11px] bg-amber-50 border-2 border-black rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 mt-0.5" />
              <span>
                <span className="font-bold">Switching model mid-chat.</span> The new model picks up this same conversation, but tone, style and capabilities can change — and reasoning/web/vision options adjust to what it supports.
                {conversationHasImages && ' Models without vision are disabled here because this chat contains images they can’t read.'}
              </span>
            </div>
          )}

          {/* Auto mode */}
          <div className="mx-4 mt-3 border-2 border-black rounded-lg p-3 bg-indigo-50">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Wand2 className="w-4 h-4 shrink-0" />
                <div className="min-w-0">
                  <div className="font-bold text-sm flex items-center gap-1.5">Auto {autoMode && <Check className="w-3.5 h-3.5 text-green-600" />}</div>
                  <div className="text-[11px] text-slate-600">Best model + tools chosen per message.</div>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              <span className="text-[10px] font-bold uppercase text-slate-500">Lock source:</span>
              {([
                { key: null, label: 'Any' },
                { key: 'openrouter', label: 'OpenRouter' },
                { key: 'nvidia', label: 'NVIDIA' }
              ] as { key: LockSource; label: string }[]).map((opt) => {
                const active = autoMode && (lockedSource ?? null) === opt.key;
                return (
                  <button
                    key={String(opt.key)}
                    onClick={() => onSelectAuto(opt.key)}
                    className={`text-[11px] font-bold px-2 py-0.5 rounded-full border-2 border-black ${active ? 'bg-indigo-300' : 'bg-white hover:bg-slate-100'}`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {loading ? (
              <div className="flex items-center justify-center py-16 text-slate-500"><Loader2 className="w-6 h-6 animate-spin" /></div>
            ) : (
              <>
                {error && <p className="text-xs text-brand-red font-bold mb-3">{error}</p>}
                {filtered.length === 0 ? (
                  <p className="text-sm text-slate-500 text-center py-10">No models match your search.</p>
                ) : (
                  <div className="grid gap-2">
                    {filtered.map((model) => {
                      const isSelected = model.id === selectedModelId;
                      const visionIncompatible = Boolean(conversationHasImages) && !getCapabilities(model).imageInput;
                      const sourceOff = !isProviderEnabled(model.source);
                      const incompatible = visionIncompatible || sourceOff;
                      return (
                        <button
                          key={`${model.source}:${model.id}`}
                          onClick={() => !incompatible && onSelect(model)}
                          disabled={incompatible}
                          className={`text-left border-2 border-black rounded-lg p-3 transition-all ${
                            incompatible
                              ? 'bg-slate-100 opacity-60 cursor-not-allowed'
                              : isSelected
                                ? 'bg-brand-yellow/40 shadow-comic-hover'
                                : 'bg-white shadow-comic hover:bg-slate-50 hover:translate-x-[1px] hover:translate-y-[1px]'
                          }`}
                          title={sourceOff ? `${sourceLabel(providerOrigin(model))} is turned off in Settings → API Configuration` : visionIncompatible ? 'This model can’t read the images already in this chat' : undefined}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-[10px] font-bold uppercase text-slate-500">{sourceLabel(providerOrigin(model))}</div>
                              <div className="font-bold leading-tight truncate flex items-center gap-1.5">
                                {isSelected && <Check className="w-4 h-4 text-green-600 shrink-0" />}
                                {model.name}
                              </div>
                            </div>
                            <span className="text-[11px] font-bold text-slate-600 shrink-0">{costLabel(model)}</span>
                          </div>
                          <div className="mt-2">
                            <CapabilityChips model={model} speed={speed[model.id]} />
                          </div>
                          {model.description && (
                            <p className="text-[11px] text-slate-600 mt-1.5 line-clamp-2">{model.description}</p>
                          )}
                          {sourceOff ? (
                            <p className="text-[11px] font-bold text-slate-500 mt-1.5 flex items-center gap-1"><EyeOff className="w-3 h-3" /> {sourceLabel(providerOrigin(model))} is turned off in Settings</p>
                          ) : visionIncompatible && (
                            <p className="text-[11px] font-bold text-brand-red mt-1.5 flex items-center gap-1"><EyeOff className="w-3 h-3" /> No vision — can’t read this chat’s images</p>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </ModalPortal>
  );
};
