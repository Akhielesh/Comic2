import React, { useEffect, useMemo, useState } from 'react';
import { Search, X, Loader2, Check, Sparkles, Globe, Eye, Brain, AlertTriangle, EyeOff, Wand2, Zap, Gauge, Key, ExternalLink } from 'lucide-react';
import { ModalPortal } from '../modals/ModalPortal';
import {
  fetchModelCatalog,
  sourceLabel,
  sourceShortLabel,
  providerOrigin,
  costLabel,
  type CatalogModel,
  type ModelSource
} from '../../services/modelCatalog';
import { getCapabilities } from '../../services/modelCapabilities';
import { searchModels } from '../../services/modelSearch';
import { isProviderEnabled } from '../../services/sourceGovernance';
import { isModelSourceUsable } from '../../services/apiKeys';
import { getProviderDef, PROVIDERS_ORDERED } from '../../shared/providers';
import { ProviderLogo, hasProviderLogo } from '../providerLogos';
import { fetchModelSpeed, speedTier, speedLabel, isTimeoutProneFreeModel, type ModelSpeed } from '../../services/modelSpeed';
import {
  GLASS_STRONG, HAIRLINE, MUTED, INK, HEADING, TRANSITION, SHADOW_SOFT,
  CONTROL_BTN, ACCENT_BG, ACCENT_BG_HOVER, ACCENT_TEXT, ACCENT_SOFT_BG, HOVER_LIFT
} from './studioDesign';

// Whether a model can actually be used right now: platform-served providers (OpenRouter,
// NVIDIA, Gemini) work on the platform key/allowance; the direct BYOK providers need the
// user's own key. Returns the reason so the card can show "Add a key" with a link.
const keyGate = (source: string): { ok: true } | { ok: false; needsKey: true } =>
  isModelSourceUsable(source) ? { ok: true } : { ok: false, needsKey: true };

// Measured-latency badge (from real chat telemetry) so slow models are obvious before
// you pick one — the durable fix for getting stuck on a 60-250s free model.
const SpeedBadge: React.FC<{ speed?: ModelSpeed }> = ({ speed }) => {
  if (!speed) return null;
  const tier = speedTier(speed.p50Ms);
  const cls = tier === 'fast' ? 'bg-green-500/10 text-green-600' : tier === 'ok' ? 'bg-[var(--ds-well-strong)] text-[var(--ds-muted)]' : 'bg-red-500/10 text-red-600';
  const Icon = tier === 'slow' ? Gauge : Zap;
  return (
    <span
      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${HAIRLINE} flex items-center gap-0.5 ${cls}`}
      title={`Typical response time, measured from ${speed.samples} recent chats${tier === 'slow' ? ' — this model is slow' : ''}`}
    >
      <Icon className="w-2.5 h-2.5" /> {speedLabel(speed.p50Ms)}
    </span>
  );
};

type LockSource = ModelSource | null;

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
  const timeoutProne = !speed && isTimeoutProneFreeModel(model.id, caps.isFree);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <SpeedBadge speed={speed} />
      {timeoutProne && (
        <span
          className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${HAIRLINE} bg-red-500/10 text-red-600 flex items-center gap-0.5`}
          title="Very large free model — it often queues on the free tier and can time out. Prefer a smaller/faster model, or use Auto."
        >
          <Gauge className="w-2.5 h-2.5" /> May time out
        </span>
      )}
      {caps.isFree && <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${HAIRLINE} bg-green-500/10 text-green-600`}>Free</span>}
      {caps.reasoning && (
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${HAIRLINE} bg-indigo-500/10 text-indigo-500 flex items-center gap-0.5`}><Brain className="w-2.5 h-2.5" /> Reason</span>
      )}
      {caps.imageInput && (
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${HAIRLINE} bg-amber-500/10 text-amber-600 flex items-center gap-0.5`}><Eye className="w-2.5 h-2.5" /> Vision</span>
      )}
      {model.source === 'openrouter' && (
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${HAIRLINE} bg-sky-500/10 text-sky-600 flex items-center gap-0.5`}><Globe className="w-2.5 h-2.5" /> Web</span>
      )}
      {typeof model.contextLength === 'number' && model.contextLength > 0 && (
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${HAIRLINE} bg-[var(--ds-well-strong)] text-[var(--ds-muted)]`}>{Math.round(model.contextLength / 1000)}K ctx</span>
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
  const [providerFilter, setProviderFilter] = useState<ModelSource | 'all'>('all');
  const [speed, setSpeed] = useState<Record<string, ModelSpeed>>({});
  useEffect(() => { let on = true; fetchModelSpeed().then((s) => { if (on) setSpeed(s); }); return () => { on = false; }; }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
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
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  // The providers that actually have models in the catalog, in registry order — used for
  // the provider filter row. A model whose source is turned off in Settings is excluded.
  const providersPresent = useMemo(() => {
    const present = new Set(models.map((m) => m.source).filter(isProviderEnabled));
    return PROVIDERS_ORDERED.filter((d) => present.has(d.id));
  }, [models]);

  const filtered = useMemo(() => {
    return searchModels(models, query).filter((model) => {
      // Governance: a source turned off in Settings is hidden entirely.
      if (!isProviderEnabled(model.source)) return false;
      if (providerFilter !== 'all' && model.source !== providerFilter) return false;
      const caps = getCapabilities(model);
      if (facet === 'free' && !caps.isFree) return false;
      if (facet === 'reasoning' && !caps.reasoning) return false;
      if (facet === 'vision' && !caps.imageInput) return false;
      if (facet === 'web' && model.source !== 'openrouter') return false;
      return true;
    });
  }, [models, query, facet, providerFilter]);

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[70] bg-black/30 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
        <div
          className={`${GLASS_STRONG} ${HAIRLINE} ${SHADOW_SOFT} rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--ds-hairline)] rounded-t-2xl">
            <h2 className={`${HEADING} text-xl flex items-center gap-2`}><Sparkles className={`w-5 h-5 ${ACCENT_TEXT}`} /> Choose a model</h2>
            <button onClick={onClose} className={`${CONTROL_BTN} p-1`}><X className="w-4 h-4" /></button>
          </div>

          <div className="p-4 border-b border-[var(--ds-hairline)] space-y-3">
            <div className={`flex items-center gap-2 ${HAIRLINE} rounded-xl px-3 py-2 bg-[var(--ds-surface-soft)]`}>
              <Search className="w-4 h-4 text-[var(--ds-muted)]" />
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
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${TRANSITION} ${facet === f.key ? `${ACCENT_BG} ${ACCENT_BG_HOVER} text-white border border-transparent` : `${HAIRLINE} bg-[var(--ds-surface-soft)] ${MUTED} hover:bg-[var(--ds-hover)]`}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            {/* Provider filter — pick a provider to see only its models (or All). */}
            {providersPresent.length > 1 && (
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)] mr-0.5">Provider</span>
                <button
                  onClick={() => setProviderFilter('all')}
                  className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${TRANSITION} ${providerFilter === 'all' ? `${ACCENT_BG} text-white border border-transparent` : `${HAIRLINE} bg-[var(--ds-surface-soft)] ${MUTED} hover:bg-[var(--ds-hover)]`}`}
                >
                  All
                </button>
                {providersPresent.map((d) => {
                  const connected = keyGate(d.id).ok;
                  return (
                    <button
                      key={d.id}
                      onClick={() => setProviderFilter(d.id)}
                      title={connected ? undefined : `No ${d.label} key — add one to use these models`}
                      className={`text-[11px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1 ${TRANSITION} ${providerFilter === d.id ? `${ACCENT_BG} text-white border border-transparent` : `${HAIRLINE} bg-[var(--ds-surface-soft)] ${MUTED} hover:bg-[var(--ds-hover)]`}`}
                    >
                      {hasProviderLogo(d.id)
                        ? <ProviderLogo provider={d.id} className="w-3 h-3" style={providerFilter === d.id ? undefined : { color: d.accent }} />
                        : <span className="w-1.5 h-1.5 rounded-full" style={{ background: providerFilter === d.id ? '#fff' : d.accent }} />}
                      {d.short}
                      {!connected && <Key className="w-2.5 h-2.5 opacity-70" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {hasMessages && (
            <div className="mx-4 mt-3 -mb-1 flex items-start gap-2 text-[11px] bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 mt-0.5" />
              <span>
                <span className="font-bold">Switching model mid-chat.</span> The new model picks up this same conversation, but tone, style and capabilities can change — and reasoning/web/vision options adjust to what it supports.
                {conversationHasImages && ' Models without vision are disabled here because this chat contains images they can’t read.'}
              </span>
            </div>
          )}

          {/* Auto mode */}
          <div className={`mx-4 mt-3 ${HAIRLINE} rounded-2xl p-3 ${autoMode ? ACCENT_SOFT_BG : 'bg-[var(--ds-surface-soft)]'}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Wand2 className={`w-4 h-4 shrink-0 ${ACCENT_TEXT}`} />
                <div className="min-w-0">
                  <div className={`font-semibold text-sm flex items-center gap-1.5 ${INK}`}>Auto {autoMode && <Check className={`w-3.5 h-3.5 ${ACCENT_TEXT}`} />}</div>
                  <div className={`text-[11px] ${MUTED}`}>Best model + tools chosen per message.</div>
                </div>
              </div>
            </div>
            {/* Lock-source choices: only sources that are enabled AND usable right now (platform
                or a key on file) can be a lock target. With a single one there's nothing to lock. */}
            {(() => {
              const lockable = PROVIDERS_ORDERED.filter((d) => isProviderEnabled(d.id) && keyGate(d.id).ok);
              if (lockable.length < 2) return null;
              const options: { key: LockSource; label: string }[] = [
                { key: null, label: 'Any' },
                ...lockable.map((d) => ({ key: d.id as LockSource, label: d.short }))
              ];
              return (
                <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Lock source:</span>
                  {options.map((opt) => {
                    const active = autoMode && (lockedSource ?? null) === opt.key;
                    return (
                      <button
                        key={String(opt.key)}
                        onClick={() => onSelectAuto(opt.key)}
                        className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${TRANSITION} ${active ? `${ACCENT_BG} ${ACCENT_BG_HOVER} text-white border border-transparent` : `${HAIRLINE} bg-[var(--ds-surface-soft)] ${MUTED} hover:bg-[var(--ds-hover)]`}`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              );
            })()}
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {loading ? (
              <div className="flex items-center justify-center py-16 text-[var(--ds-muted)]"><Loader2 className="w-6 h-6 animate-spin" /></div>
            ) : (
              <>
                {error && <p className="text-xs text-red-600 font-semibold mb-3">{error}</p>}
                {filtered.length === 0 ? (
                  <p className={`text-sm ${MUTED} text-center py-10`}>No models match your search.</p>
                ) : (
                  <div className="grid gap-2">
                    {filtered.map((model) => {
                      const isSelected = model.id === selectedModelId;
                      const visionIncompatible = Boolean(conversationHasImages) && !getCapabilities(model).imageInput;
                      const gate = keyGate(model.source);
                      const needsKey = !gate.ok;
                      const def = getProviderDef(model.source);
                      const incompatible = visionIncompatible || needsKey;
                      return (
                        <button
                          key={`${model.source}:${model.id}`}
                          onClick={() => !incompatible && onSelect(model)}
                          disabled={incompatible}
                          className={`text-left rounded-xl p-3 transition-all duration-200 ${
                            incompatible
                              ? `${HAIRLINE} bg-[var(--ds-well-strong)] opacity-60 cursor-not-allowed`
                              : isSelected
                                ? `border border-[#D97757]/40 ${ACCENT_SOFT_BG} ${SHADOW_SOFT}`
                                : `${HAIRLINE} bg-[var(--ds-surface-soft)] ${SHADOW_SOFT} hover:bg-[var(--ds-raised)] ${HOVER_LIFT}`
                          }`}
                          title={needsKey ? `Add a ${sourceLabel(model.source)} key in Settings → API Configuration to use this model` : visionIncompatible ? 'This model can’t read the images already in this chat' : undefined}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)] flex items-center gap-1">
                                {hasProviderLogo(model.source)
                                  ? <ProviderLogo provider={model.source} className="w-3 h-3" style={{ color: def?.accent }} />
                                  : <span className="w-1.5 h-1.5 rounded-full" style={{ background: def?.accent || 'var(--ds-muted)' }} />}
                                {sourceShortLabel(providerOrigin(model))}
                              </div>
                              <div className={`font-semibold leading-tight truncate flex items-center gap-1.5 ${INK}`}>
                                {isSelected && <Check className={`w-4 h-4 ${ACCENT_TEXT} shrink-0`} />}
                                {model.name}
                              </div>
                            </div>
                            <span className={`text-[11px] font-semibold ${MUTED} shrink-0`}>{costLabel(model)}</span>
                          </div>
                          <div className="mt-2">
                            <CapabilityChips model={model} speed={speed[model.id]} />
                          </div>
                          {model.description && (
                            <p className={`text-[11px] ${MUTED} mt-1.5 line-clamp-2`}>{model.description}</p>
                          )}
                          {needsKey ? (
                            <p className={`text-[11px] font-semibold mt-1.5 flex items-center gap-1 ${ACCENT_TEXT}`}>
                              <Key className="w-3 h-3" /> Add a {sourceLabel(model.source)} key to use this
                              {def?.keysUrl && (
                                <a
                                  href={def.keysUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="inline-flex items-center gap-0.5 underline hover:no-underline"
                                >
                                  Get key <ExternalLink className="w-2.5 h-2.5" />
                                </a>
                              )}
                            </p>
                          ) : visionIncompatible && (
                            <p className="text-[11px] font-semibold text-red-600 mt-1.5 flex items-center gap-1"><EyeOff className="w-3 h-3" /> No vision — can’t read this chat’s images</p>
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
