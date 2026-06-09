import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Search,
  Image as ImageIcon,
  Type as TypeIcon,
  Layers,
  AlertTriangle,
  Check,
  Loader2,
  X,
  Sparkles,
  Scale,
  Wand2,
  Zap,
  ThumbsUp,
  ThumbsDown,
  ShieldCheck,
  ExternalLink,
  MessageSquare,
  SlidersHorizontal,
  ArrowUpDown,
  RotateCcw,
  Code2
} from 'lucide-react';
import {
  fetchModelCatalog,
  fetchModelVerification,
  loadCachedCatalog,
  costLabel,
  providerOrigin,
  sourceLabel,
  type Band,
  type CatalogModel,
  type ModelVerification
} from '../services/modelCatalog';
import {
  setSelectedModel,
  setStageModel,
  getModelSelection,
  MODEL_SELECTION_CHANGED,
  type ModelSlot,
  type ModelSelection
} from '../services/modelSelection';
import { getCapabilities, featureSupport, FEATURE_LABELS, capabilityBadges, QUERY_FACETS, type CapabilityTone } from '../services/modelCapabilities';
import { buildSmartTeam, TASK_PROFILES, pickBestForDomain, type SmartMode, type SmartTask, type SmartTeam } from '../services/smartModelSelection';
import { recordModelFeedback, latestVote, feedbackSummary, MODEL_FEEDBACK_CHANGED, type FeedbackVote } from '../services/modelFeedback';
import { topDomains, domainStrength, DOMAIN_META, FILTERABLE_DOMAINS, type DomainId } from '../services/modelDomains';
import { getModelBenchmarks, BENCHMARK_METRICS, formatScore, type BenchmarkMetricId } from '../services/modelBenchmarks';
import { DomainTags, ModelInsightsPanel } from './models/ModelInsights';
import { CodingLeaderboard } from './models/CodingLeaderboard';
import { InfoDot } from './common/InfoTooltip';
import type { GLOSSARY } from '../services/modelGlossary';
import { describeCost, classBadge } from '../shared/pricing';
import { useAuth } from '../contexts/AuthContext';
import { modelLinks, SOURCE_HOSTING_NOTE } from '../services/modelLinks';
import { getModelVendor, getModelVendorId, availableVendors } from '../services/modelVendors';
import { recommendModels, accuracyElo } from '../services/modelRecommendations';
import type { ModelSource } from '../services/modelCatalog';

interface ModelLibraryProps {
  onBack: () => void;
  /** Launch the AI Chat Platform pre-loaded with this model. */
  onStartChat?: (model: { id: string; name: string; source: 'openrouter' | 'nvidia' }) => void;
}

/** A model can be tried in chat when it outputs text (i.e. not a pure image generator). */
const canChatWith = (model: CatalogModel): boolean => !model.supportsImageOutput;

type FilterKey = 'all' | 'free' | 'image' | 'text' | 'refs' | 'editing' | 'reasoning' | 'openrouter' | 'nvidia';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'free', label: 'Free' },
  { key: 'image', label: 'Image' },
  { key: 'text', label: 'Text' },
  { key: 'refs', label: 'Reference-capable' },
  { key: 'editing', label: 'Image editing' },
  { key: 'reasoning', label: 'Reasoning' },
  { key: 'openrouter', label: 'Source: OpenRouter' },
  { key: 'nvidia', label: 'Source: NVIDIA Build' }
];

const TONE_CLASS: Record<CapabilityTone, string> = {
  free: 'bg-green-500 text-white',
  image: 'bg-brand-blue text-white',
  text: 'bg-slate-100 text-slate-700',
  vision: 'bg-brand-yellow text-black',
  edit: 'bg-fuchsia-600 text-white',
  reason: 'bg-indigo-600 text-white',
  json: 'bg-slate-100 text-slate-700',
  tools: 'bg-slate-100 text-slate-700',
  context: 'bg-slate-100 text-slate-700'
};

const BAND_COLOR: Record<Band, string> = {
  free: 'bg-green-500 text-white',
  low: 'bg-brand-blue text-white',
  medium: 'bg-brand-yellow text-black',
  high: 'bg-brand-red text-white'
};

const MAX_COMPARE = 5;

const Badge: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border border-black ${className}`}>{children}</span>
);

const slotOf = (model: CatalogModel): ModelSlot => (model.supportsImageOutput ? 'image' : 'text');

const perMillion = (perToken: number) => (perToken > 0 ? `$${(perToken * 1_000_000).toFixed(2)}/M` : '—');

// Plain-language, multi-dimensional cost line for a model. Routes through shared/pricing
// so client + server use the exact same wording and never collapse to "free/paid".
const costStatement = (model: CatalogModel): string =>
  describeCost({
    modelId: model.id,
    pricing: model.pricing,
    supportsImageOutput: model.supportsImageOutput
  });

const COST_CLASS_COLOR: Record<string, string> = {
  free_verified: 'bg-green-500 text-white',
  zero_priced_token_billed: 'bg-amber-500 text-black',
  per_image_only: 'bg-brand-blue text-white',
  paid: 'bg-slate-200 text-slate-700'
};
const COST_CLASS_LABEL: Record<string, string> = {
  free_verified: 'Free',
  zero_priced_token_billed: 'Token-billed (NOT free)',
  per_image_only: 'Per image',
  paid: 'Paid'
};
// Cost classes that have a glossary explanation (the surprising ones worth a hover).
const COST_CLASS_GLOSSARY: Record<string, keyof typeof GLOSSARY> = {
  free_verified: 'free_verified',
  zero_priced_token_billed: 'token_billed'
};

// Each active filter chip must match (AND), so you can combine e.g. Free + Image + Reasoning.
const FILTER_PREDICATES: Record<Exclude<FilterKey, 'all'>, (m: CatalogModel, c: ReturnType<typeof getCapabilities>) => boolean> = {
  free: (m) => m.isFree,
  image: (m) => m.supportsImageOutput,
  text: (m) => !m.supportsImageOutput,
  refs: (m) => m.supportsImageInput,
  editing: (_m, c) => c.imageEditing,
  reasoning: (_m, c) => c.reasoning,
  openrouter: (m) => m.source === 'openrouter',
  nvidia: (m) => m.source === 'nvidia'
};

const matchesFilter = (model: CatalogModel, filters: Set<FilterKey>, domains: Set<DomainId>, vendors: Set<string>, query: string): boolean => {
  const caps = getCapabilities(model);
  for (const f of filters) {
    if (f === 'all') continue;
    const predicate = FILTER_PREDICATES[f];
    if (predicate && !predicate(model, caps)) return false;
  }

  // Vendor filters (OR among themselves, ANDs with everything else): keep models whose maker is
  // one of the selected vendors — so "Anthropic" + "OpenAI" shows both, narrowed by the rest.
  if (vendors.size > 0 && !vendors.has(getModelVendorId(model))) return false;

  // Domain filters (benchmark-backed): a model must be at least "Capable" (≥55) in each selected
  // domain. ANDs with everything else, so "Coding" + "Free" finds free models that can actually code.
  for (const d of domains) {
    if (domainStrength(model, d) < 55) return false;
  }

  // Smart search: each token is either a semantic facet ("free", "image", "vision",
  // "reasoning", "editing", "nvidia"…) or a plain substring. ALL tokens must match — so
  // typing "free image" auto-narrows to free image models without touching the chips.
  const tokens = query.trim().toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (tokens.length) {
    const capLabels = capabilityBadges(model).map((b) => b.label).join(' ');
    const vendor = getModelVendor(model);
    const haystack = [
      model.id, model.name, model.description, model.source, vendor.label, vendor.id,
      model.roles?.join(' '), model.possibilities?.join(' '), model.drawbacks?.join(' '),
      model.editorialNote, capLabels
    ].filter(Boolean).join(' ').toLowerCase();
    for (const tok of tokens) {
      const facet = QUERY_FACETS.find((f) => f.keys.includes(tok));
      if (facet) {
        if (!facet.test(caps, model)) return false;
      } else if (!haystack.includes(tok)) {
        return false;
      }
    }
  }
  return true;
};

// ── Sorting ──────────────────────────────────────────────────────────────────
type SortKey = 'relevance' | 'context_desc' | 'context_asc' | 'newest' | 'cheapest' | 'benchmark' | 'name';
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'relevance', label: 'Best match' },
  { key: 'benchmark', label: 'Top benchmark (Arena Elo)' },
  { key: 'context_desc', label: 'Context: high → low' },
  { key: 'context_asc', label: 'Context: low → high' },
  { key: 'newest', label: 'Newest first' },
  { key: 'cheapest', label: 'Cheapest first' },
  { key: 'name', label: 'Name (A–Z)' }
];

const arenaElo = (m: CatalogModel): number => getModelBenchmarks(m.id)?.scores.arena_elo ?? 0;
// Cheapest yardstick: per-image price for image models, per-output-token for text; free sorts first.
const priceOf = (m: CatalogModel): number =>
  m.supportsImageOutput ? (m.pricing.imagePerImage || Number.POSITIVE_INFINITY) : (m.pricing.completionPerToken || Number.POSITIVE_INFINITY);

const sortModels = (list: CatalogModel[], sortBy: SortKey): CatalogModel[] => {
  if (sortBy === 'relevance') return list;
  const out = [...list];
  switch (sortBy) {
    case 'context_desc': out.sort((a, b) => (b.contextLength || 0) - (a.contextLength || 0)); break;
    case 'context_asc': out.sort((a, b) => (a.contextLength || 0) - (b.contextLength || 0)); break;
    case 'newest': out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); break;
    case 'cheapest': out.sort((a, b) => priceOf(a) - priceOf(b)); break;
    case 'benchmark': out.sort((a, b) => arenaElo(b) - arenaElo(a)); break;
    case 'name': out.sort((a, b) => a.name.localeCompare(b.name)); break;
  }
  return out;
};

const UseModelControl: React.FC<{ model: CatalogModel; selection: ModelSelection; onUse: (slot: ModelSlot) => void }> = ({ model, selection, onUse }) => {
  const [confirming, setConfirming] = useState(false);
  const slot = slotOf(model);
  const isSelected = (slot === 'image' ? selection.imageModel : selection.textModel) === model.id;

  if (isSelected) {
    return <span className="text-[11px] font-bold text-green-700 flex items-center gap-1"><Check className="w-3.5 h-3.5" /> In use ({slot})</span>;
  }
  if (confirming) {
    return (
      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <span className="text-[11px] text-slate-600">Use for {slot}?</span>
        <button onClick={() => { onUse(slot); setConfirming(false); }} className="text-[11px] font-bold px-2 py-0.5 rounded border-2 border-black bg-brand-blue text-white">Confirm</button>
        <button onClick={() => setConfirming(false)} className="text-[11px] font-bold px-2 py-0.5 rounded border-2 border-black bg-white">Cancel</button>
      </div>
    );
  }
  return (
    <button onClick={(e) => { e.stopPropagation(); setConfirming(true); }} className="text-[11px] font-bold px-2 py-0.5 rounded border-2 border-black bg-white hover:bg-brand-yellow">
      Use this model
    </button>
  );
};

// 👍/👎 a model to teach Smart auto-pick. Always optional; dislike may ask why (never forced).
// Shows running counts so feedback feels like it accumulates into something — and the data is kept
// in an analysis-ready shape (see modelFeedback.exportFeedback) for future cross-session insight.
const FeedbackButtons: React.FC<{ modelId: string; task?: string; showCounts?: boolean }> = ({ modelId, task, showCounts }) => {
  const [vote, setVote] = useState<FeedbackVote | null>(() => latestVote(modelId));
  const [summary, setSummary] = useState(() => feedbackSummary(modelId));
  const cast = (v: FeedbackVote) => (e: React.MouseEvent) => {
    e.stopPropagation();
    const note = v === 'dislike'
      ? (window.prompt('Optional — what was off about this model? (leave blank to skip)') || undefined)
      : undefined;
    recordModelFeedback(modelId, v, { note, task });
    setVote(v);
    setSummary(feedbackSummary(modelId));
  };
  return (
    <div className="flex items-center gap-1" title="Optional — teach Smart auto-pick what works for you">
      <button onClick={cast('like')} className={`flex items-center gap-0.5 p-1 rounded border-2 border-black ${vote === 'like' ? 'bg-green-500 text-white' : 'bg-white hover:bg-green-100'}`} aria-label="Like this model">
        <ThumbsUp className="w-3 h-3" />{showCounts && summary.likes > 0 && <span className="text-[10px] font-bold">{summary.likes}</span>}
      </button>
      <button onClick={cast('dislike')} className={`flex items-center gap-0.5 p-1 rounded border-2 border-black ${vote === 'dislike' ? 'bg-brand-red text-white' : 'bg-white hover:bg-red-100'}`} aria-label="Dislike this model">
        <ThumbsDown className="w-3 h-3" />{showCounts && summary.dislikes > 0 && <span className="text-[10px] font-bold">{summary.dislikes}</span>}
      </button>
    </div>
  );
};

const ModelCard: React.FC<{
  model: CatalogModel;
  selection: ModelSelection;
  compared: boolean;
  onOpen: () => void;
  onUse: (slot: ModelSlot) => void;
  onToggleCompare: () => void;
  onStartChat?: (model: { id: string; name: string; source: 'openrouter' | 'nvidia' }) => void;
}> = ({ model, selection, compared, onOpen, onUse, onToggleCompare, onStartChat }) => (
  <div
    onClick={onOpen}
    className="cursor-pointer text-left bg-white border-2 border-black rounded-lg p-4 shadow-comic hover:shadow-comic-hover hover:translate-x-[2px] hover:translate-y-[2px] transition-all flex flex-col gap-3"
  >
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border border-black ${getModelVendor(model).color}`}>{getModelVendor(model).label}</span>
          <span className="text-[10px] font-bold uppercase text-slate-500">{sourceLabel(providerOrigin(model))}</span>
        </div>
        <div className="font-bold leading-tight truncate">{model.name}</div>
      </div>
      <Badge className={COST_CLASS_COLOR[model.costClass]}>{COST_CLASS_LABEL[model.costClass] ?? classBadge(model.costClass)}</Badge>
    </div>

    <div className="flex flex-wrap gap-1">
      {model.apiCallable === false && (
        <Badge className="bg-amber-100 text-amber-800 border-amber-400" >Download-only</Badge>
      )}
      {capabilityBadges(model).map((b) => <Badge key={b.label} className={TONE_CLASS[b.tone]}>{b.label}</Badge>)}
    </div>

    {/* What it's actually good at — benchmark-backed domain tags. */}
    <DomainTags model={model} />

    <p className="text-[11px] text-slate-700 leading-snug" title="Cost varies per axis (input tokens, output tokens, per-image, per-request).">{costStatement(model)}</p>

    {model.editorialNote && <p className="text-xs text-slate-600 line-clamp-2">{model.editorialNote}</p>}

    <div className="mt-auto flex items-center justify-between gap-2 pt-2 border-t border-dashed border-slate-200">
      <div className="flex items-center gap-1.5">
        <UseModelControl model={model} selection={selection} onUse={onUse} />
        {onStartChat && canChatWith(model) && model.apiCallable !== false && (
          <button
            onClick={(e) => { e.stopPropagation(); onStartChat({ id: model.id, name: model.name, source: providerOrigin(model) as 'openrouter' | 'nvidia' }); }}
            className="text-[11px] font-bold px-2 py-0.5 rounded border-2 border-black bg-brand-blue text-white hover:bg-blue-600 flex items-center gap-1"
            title="Try this model in the AI Chat Platform"
          >
            <MessageSquare className="w-3 h-3" /> Chat
          </button>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <FeedbackButtons modelId={model.id} />
        <button
          onClick={(e) => { e.stopPropagation(); onToggleCompare(); }}
          className={`text-[11px] font-bold px-2 py-0.5 rounded border-2 border-black flex items-center gap-1 ${compared ? 'bg-brand-blue text-white' : 'bg-white hover:bg-brand-yellow'}`}
          title="Add to comparison"
        >
          <Scale className="w-3 h-3" /> {compared ? 'Comparing' : 'Compare'}
        </button>
      </div>
    </div>
  </div>
);

const DetailModal: React.FC<{ model: CatalogModel; selection: ModelSelection; onClose: () => void; onUse: (slot: ModelSlot) => void; onStartChat?: (model: { id: string; name: string; source: 'openrouter' | 'nvidia' }) => void }> = ({ model, selection, onClose, onUse, onStartChat }) => (
  <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
    <div className="bg-white border-4 border-black rounded-xl shadow-comic max-w-2xl w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
      <div className="sticky top-0 z-10 bg-white rounded-t-lg border-b-2 border-black px-5 py-4 flex items-start justify-between gap-3 shadow-[0_2px_0_0_rgba(0,0,0,0.06)]">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase text-slate-500">{sourceLabel(providerOrigin(model))}</div>
          <h2 className="text-xl font-display leading-tight truncate">{model.name}</h2>
          <code className="text-[11px] text-slate-500 break-all">{model.id}</code>
        </div>
        <button onClick={onClose} className="border-2 border-black rounded p-1 hover:bg-brand-yellow shrink-0" aria-label="Close"><X className="w-4 h-4" /></button>
      </div>

      <div className="p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-0.5">
            <Badge className={COST_CLASS_COLOR[model.costClass]}>{COST_CLASS_LABEL[model.costClass] ?? classBadge(model.costClass)}</Badge>
            {COST_CLASS_GLOSSARY[model.costClass] && <InfoDot term={COST_CLASS_GLOSSARY[model.costClass]} />}
          </span>
          {model.supportsImageOutput && <Badge className="bg-brand-blue text-white">Text→Image</Badge>}
          {getCapabilities(model).imageInput && !model.supportsImageOutput && <Badge className="bg-brand-yellow text-black">Image→Text (vision)</Badge>}
          {model.supportsImageInput && model.supportsImageOutput && <Badge className="bg-brand-yellow text-black">Reference images</Badge>}
          {getCapabilities(model).imageEditing && <Badge className="bg-fuchsia-600 text-white">Image editing</Badge>}
          {getCapabilities(model).reasoning && <span className="inline-flex items-center gap-0.5"><Badge className="bg-indigo-600 text-white">Reasoning</Badge><InfoDot term="reasoning" /></span>}
          {model.supportsJsonOutput && <span className="inline-flex items-center gap-0.5"><Badge className="bg-slate-100 text-slate-700">Structured JSON</Badge><InfoDot term="structured_json" /></span>}
          {typeof model.contextLength === 'number' && <span className="inline-flex items-center gap-0.5"><Badge className="bg-slate-100 text-slate-700">{Math.round(model.contextLength / 1000)}K ctx</Badge><InfoDot term="context_length" /></span>}
          <span className="ml-auto flex items-center gap-2">
            <FeedbackButtons modelId={model.id} showCounts />
            {onStartChat && canChatWith(model) && (
              <button
                onClick={() => onStartChat({ id: model.id, name: model.name, source: providerOrigin(model) as 'openrouter' | 'nvidia' })}
                className="text-[11px] font-bold px-2.5 py-1 rounded border-2 border-black bg-brand-blue text-white hover:bg-blue-600 flex items-center gap-1"
              >
                <MessageSquare className="w-3.5 h-3.5" /> Chat with this model
              </button>
            )}
            <UseModelControl model={model} selection={selection} onUse={onUse} />
          </span>
        </div>

        {/* What it's good at + the numbers behind it. */}
        <DomainTags model={model} limit={6} threshold={45} />
        <ModelInsightsPanel model={model} />

        {model.editorialNote && (
          <div className="bg-brand-yellow/30 border-2 border-black rounded-lg p-3 text-sm flex gap-2">
            <Sparkles className="w-4 h-4 shrink-0 mt-0.5" /><span>{model.editorialNote}</span>
          </div>
        )}
        {model.description && <p className="text-sm text-slate-600">{model.description}</p>}

        <div className="border-2 border-black rounded-lg p-3 space-y-1.5">
          <div className="text-[10px] uppercase font-bold text-slate-500">Where it's hosted &amp; sourced</div>
          <p className="text-[12px] text-slate-600">{SOURCE_HOSTING_NOTE[model.source as ModelSource]}</p>
          <div className="flex flex-wrap gap-2 pt-0.5">
            {modelLinks(model).map((link) => (
              <a key={link.url} href={link.url} target="_blank" rel="noreferrer"
                 className="text-[11px] font-bold text-brand-blue underline flex items-center gap-1">
                {link.label} <ExternalLink className="w-3 h-3" />
              </a>
            ))}
          </div>
        </div>

        <div className="grid sm:grid-cols-4 gap-3 text-[11px]">
          <div className="border-2 border-black rounded-lg p-2"><div className="text-slate-400 uppercase font-bold">Input tokens</div><div className="font-mono">{perMillion(model.pricing.promptPerToken)}</div></div>
          <div className="border-2 border-black rounded-lg p-2"><div className="text-slate-400 uppercase font-bold">Output tokens</div><div className="font-mono">{perMillion(model.pricing.completionPerToken)}</div></div>
          <div className="border-2 border-black rounded-lg p-2"><div className="text-slate-400 uppercase font-bold">Per image</div><div className="font-mono">{model.pricing.imagePerImage > 0 ? `$${model.pricing.imagePerImage.toFixed(3)}` : '—'}</div></div>
          <div className="border-2 border-black rounded-lg p-2"><div className="text-slate-400 uppercase font-bold">Per request</div><div className="font-mono">{model.pricing.requestFlat > 0 ? `$${model.pricing.requestFlat.toFixed(4)}` : '—'}</div></div>
        </div>
        <div className="bg-slate-50 border-2 border-black rounded-lg p-3 text-[12px] text-slate-700 leading-snug">
          <div className="text-[10px] uppercase font-bold text-slate-500 mb-1">Cost (each axis is independent)</div>
          {costStatement(model)}
        </div>

        <div>
          <h3 className="text-xs font-bold uppercase mb-2">Studio features</h3>
          <div className="grid sm:grid-cols-2 gap-1.5">
            {FEATURE_LABELS.map(({ feature, label }) => {
              const sup = featureSupport(getCapabilities(model), feature);
              return (
                <div key={feature} className={`text-xs flex items-start gap-1.5 ${sup.supported ? 'text-slate-700' : 'text-slate-400'}`} title={sup.reason || ''}>
                  {sup.supported ? <Check className="w-3.5 h-3.5 text-green-600 shrink-0 mt-0.5" /> : <X className="w-3.5 h-3.5 text-slate-300 shrink-0 mt-0.5" />}
                  <span>{label}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <h3 className="text-xs font-bold uppercase mb-2 flex items-center gap-1"><Check className="w-4 h-4 text-green-600" /> What's possible</h3>
            <ul className="space-y-1.5">
              {model.possibilities.length ? model.possibilities.map((item, i) => (
                <li key={i} className="text-xs text-slate-700 flex gap-1.5"><Check className="w-3.5 h-3.5 text-green-600 shrink-0 mt-0.5" />{item}</li>
              )) : <li className="text-xs text-slate-400">—</li>}
            </ul>
          </div>
          <div>
            <h3 className="text-xs font-bold uppercase mb-2 flex items-center gap-1"><AlertTriangle className="w-4 h-4 text-amber-600" /> Drawbacks</h3>
            <ul className="space-y-1.5">
              {model.drawbacks.length ? model.drawbacks.map((item, i) => (
                <li key={i} className="text-xs text-slate-700 flex gap-1.5"><AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />{item}</li>
              )) : <li className="text-xs text-slate-400">None noted</li>}
            </ul>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 pt-2 border-t-2 border-dashed border-slate-200">
          <span className="text-[10px] font-bold uppercase text-slate-500 mr-1 flex items-center gap-1"><Layers className="w-3 h-3" /> Roles:</span>
          {model.roles.map((role) => <Badge key={role} className="bg-slate-100 text-slate-700">{role}</Badge>)}
        </div>
      </div>
    </div>
  </div>
);

// Benchmark order shown in the compare table.
const COMPARE_BENCH_ORDER: BenchmarkMetricId[] = ['arena_elo', 'mmlu', 'gpqa', 'humaneval', 'swebench', 'math'];
const benchCell = (m: CatalogModel, metric: BenchmarkMetricId): React.ReactNode => {
  const v = getModelBenchmarks(m.id)?.scores[metric];
  return v != null ? <span className="font-mono">{formatScore(metric, v)}</span> : <span className="text-slate-300">—</span>;
};

type CompareRow = { label: string; info?: keyof typeof GLOSSARY; render: (m: CatalogModel) => React.ReactNode };

const CompareModal: React.FC<{ models: CatalogModel[]; selection: ModelSelection; onClose: () => void; onUse: (model: CatalogModel, slot: ModelSlot) => void }> = ({ models, selection, onClose, onUse }) => {
  const inUse = (m: CatalogModel) => selection.textModel === m.id || selection.imageModel === m.id;

  const sections: { title: string; rows: CompareRow[] }[] = [
    {
      title: 'Overview',
      rows: [
        { label: 'Cost', render: (m) => <Badge className={BAND_COLOR[m.costBand]}>{costLabel(m)}</Badge> },
        { label: 'Output', render: (m) => (m.supportsImageOutput ? 'Image' : 'Text') },
        { label: 'Context', info: 'context_length', render: (m) => (m.contextLength ? `${Math.round(m.contextLength / 1000)}K` : '—') },
        { label: 'Best at', render: (m) => { const d = topDomains(m, 3, 55); return d.length ? d.map((x) => DOMAIN_META[x.id].label).join(', ') : <span className="text-slate-300">—</span>; } }
      ]
    },
    {
      title: 'Benchmarks',
      rows: COMPARE_BENCH_ORDER.map((metric) => ({
        label: BENCHMARK_METRICS[metric].label,
        info: BENCHMARK_METRICS[metric].glossary,
        render: (m: CatalogModel) => benchCell(m, metric)
      }))
    },
    {
      title: 'Capabilities',
      rows: [
        { label: 'Reference images', render: (m) => (m.supportsImageInput ? <Check className="w-4 h-4 text-green-600" /> : <span className="text-slate-300">—</span>) },
        { label: 'Image editing', render: (m) => (getCapabilities(m).imageEditing ? <Check className="w-4 h-4 text-green-600" /> : <span className="text-slate-300">—</span>) },
        { label: 'Reasoning', info: 'reasoning', render: (m) => (getCapabilities(m).reasoning ? <Check className="w-4 h-4 text-green-600" /> : <span className="text-slate-300">—</span>) },
        { label: 'Structured JSON', info: 'structured_json', render: (m) => (m.supportsJsonOutput ? <Check className="w-4 h-4 text-green-600" /> : <span className="text-slate-300">—</span>) }
      ]
    },
    {
      title: 'Pricing',
      rows: [
        { label: 'Input / 1M tok', info: 'token', render: (m) => perMillion(m.pricing.promptPerToken) },
        { label: 'Output / 1M tok', info: 'token', render: (m) => perMillion(m.pricing.completionPerToken) },
        { label: 'Per image', render: (m) => (m.pricing.imagePerImage > 0 ? `$${m.pricing.imagePerImage.toFixed(3)}` : <span className="text-slate-300">—</span>) }
      ]
    },
    {
      title: 'In practice',
      rows: [
        { label: 'Best for', render: (m) => (m.possibilities[0] || <span className="text-slate-300">—</span>) },
        { label: 'Watch out', render: (m) => (m.drawbacks[0] || <span className="text-slate-400">None noted</span>) }
      ]
    }
  ];

  return (
    <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white border-4 border-black rounded-xl shadow-comic max-w-5xl w-full max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-white border-b-2 border-black px-5 py-4 flex items-center justify-between">
          <h2 className="text-xl font-display flex items-center gap-2"><Scale className="w-5 h-5" /> Comparing {models.length} models</h2>
          <button onClick={onClose} className="border-2 border-black rounded p-1 hover:bg-brand-yellow"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="text-left p-2 sticky left-0 z-10 bg-white" />
                {models.map((m) => (
                  <th key={m.id} className={`p-2 align-top text-left min-w-[11rem] border-b-2 border-black ${inUse(m) ? 'bg-brand-yellow/30' : ''}`}>
                    <div className="text-[10px] font-bold uppercase text-slate-500">{sourceLabel(providerOrigin(m))}</div>
                    <div className="font-bold leading-tight">{m.name}</div>
                    <div className="text-[10px] text-slate-400 font-mono break-all">{m.id}</div>
                    {inUse(m) && <div className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-bold text-green-700"><Check className="w-3 h-3" /> In use</div>}
                    <div className="mt-1"><UseModelControl model={m} selection={selection} onUse={(slot) => onUse(m, slot)} /></div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sections.map((section) => (
                <React.Fragment key={section.title}>
                  <tr>
                    <td colSpan={models.length + 1} className="sticky left-0 bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-500 border-y border-slate-200">{section.title}</td>
                  </tr>
                  {section.rows.map((row) => (
                    <tr key={section.title + row.label} className="border-t border-slate-100">
                      <td className="p-2 font-bold text-slate-600 text-[11px] sticky left-0 bg-white whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">{row.label}{row.info && <InfoDot term={row.info} />}</span>
                      </td>
                      {models.map((m) => <td key={m.id} className={`p-2 align-top ${inUse(m) ? 'bg-brand-yellow/10' : ''}`}>{row.render(m)}</td>)}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

// User-facing trust signal: shows that the catalog (and the Free/paid labels) are
// reconciled against each source's LIVE API, not guessed. Backed by /api/models/verify.
const VerifiedStrip: React.FC = () => {
  const { user } = useAuth();
  const [data, setData] = useState<ModelVerification | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    // SECURITY: the verify strip exposes per-key connection status + live spend ("$X used").
    // Only fetch/show it for an authenticated user — never to a logged-out/anonymous session.
    if (!user) return;
    let active = true;
    fetchModelVerification()
      .then((r) => { if (active) setData(r); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [user]);

  if (!user || failed) return null;
  if (!data) {
    return (
      <div className="mt-4 border-2 border-black rounded-xl bg-slate-50 p-3 text-xs flex items-center gap-2 text-slate-500">
        <Loader2 className="w-4 h-4 animate-spin" /> Verifying catalog against live sources…
      </div>
    );
  }

  const when = data.catalog.fetchedAt ? new Date(data.catalog.fetchedAt).toLocaleString() : 'just now';
  const or = data.sources.openrouter;
  const nvidia = data.sources.nvidia;
  const credits = or.credits;
  const key = or.liveKey;
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const keyLimit = num(key?.limit);
  const keyUsage = num(key?.usage) ?? 0;
  const keyRemaining = num(key?.limit_remaining);

  return (
    <div className="mt-4 border-2 border-black rounded-xl bg-green-50 p-3 shadow-comic text-xs space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-bold flex items-center gap-1.5 text-green-800"><ShieldCheck className="w-4 h-4" /> Verified live</span>
        <span><span className="text-slate-500">Catalog:</span> <b>{data.catalog.total}</b> models · <span className="font-bold text-green-800">{data.catalog.freeCount} free</span></span>
        <span className="text-slate-400 ml-auto">checked {when}</span>
      </div>

      <div className="grid sm:grid-cols-2 gap-2">
        {/* OpenRouter — account credits AND the per-key cap are shown separately, since they differ. */}
        <div className="bg-white border-2 border-black rounded-lg p-2.5">
          <div className="flex items-center justify-between">
            <span className="font-bold">OpenRouter</span>
            <span className={or.connected ? 'text-green-700 font-bold' : 'text-slate-400'}>{or.connected ? `connected · ${or.modelCount} models` : 'not connected'}</span>
          </div>
          {or.connected && (
            <div className="mt-1.5 space-y-1 text-[11px]">
              {credits ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500 flex items-center gap-1">Account credits <InfoDot content={{ title: 'Account credits', body: 'Your OpenRouter account-wide balance (GET /credits), shared across every key on the account.' }} /></span>
                  <span className="font-mono font-bold text-green-800">{usd(credits.remaining)} <span className="font-normal text-slate-400">left of {usd(credits.total)}</span></span>
                </div>
              ) : null}
              {key ? (
                keyLimit != null ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500 flex items-center gap-1">This key’s cap <InfoDot content={{ title: 'Per-key limit', body: 'A spend cap set on THIS specific API key in OpenRouter. It can be higher or lower than your account credits — whichever runs out first stops you.' }} /></span>
                    <span className="font-mono">{usd(keyUsage)} used{keyRemaining != null ? ` · ${usd(keyRemaining)} left` : ''} <span className="text-slate-400">of {usd(keyLimit)}</span></span>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500 flex items-center gap-1">This key’s cap <InfoDot content={{ title: 'Per-key limit', body: 'No per-key spend cap is set, so this key draws on your full account credits.' }} /></span>
                    <span className="font-mono text-slate-400">no cap — uses account credits</span>
                  </div>
                )
              ) : null}
              {key?.rate_limit && (key.rate_limit.requests != null || key.rate_limit.interval != null) && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500 flex items-center gap-1">Rate limit <InfoDot content={{ title: 'Rate limit', body: 'How many requests this key may make per time window before OpenRouter throttles it.' }} /></span>
                  <span className="font-mono">{key.rate_limit.requests ?? '—'} req / {key.rate_limit.interval ?? '—'}</span>
                </div>
              )}
              {key?.is_free_tier && <div className="text-amber-600 font-bold">Free-tier key</div>}
            </div>
          )}
        </div>

        {/* NVIDIA */}
        <div className="bg-white border-2 border-black rounded-lg p-2.5">
          <div className="flex items-center justify-between">
            <span className="font-bold">NVIDIA Build</span>
            <span className={nvidia.connected ? 'text-green-700 font-bold' : 'text-slate-400'}>{nvidia.connected ? `connected · ${nvidia.modelCount} models` : 'not connected'}</span>
          </div>
          {nvidia.connected && nvidia.note && <div className="mt-1.5 text-[11px] text-slate-500 leading-snug">{nvidia.note}</div>}
        </div>
      </div>

      <div className="text-slate-500">Free/paid, credits and limits are reconciled against each source’s live API — not guessed.</div>
    </div>
  );
};

export const ModelLibrary: React.FC<ModelLibraryProps> = ({ onBack, onStartChat }) => {
  // Paint instantly from the last-good catalog (localStorage) while we refresh in the background,
  // so the page is never a blank spinner — even on a slow/cold backend.
  const cachedInitial = useMemo(() => loadCachedCatalog(), []);
  const [models, setModels] = useState<CatalogModel[]>(cachedInitial?.models ?? []);
  const [loading, setLoading] = useState(!cachedInitial);
  const [refreshing, setRefreshing] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [degradedMessage, setDegradedMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Set<FilterKey>>(new Set());
  const [domainFilters, setDomainFilters] = useState<Set<DomainId>>(new Set());
  const [vendorFilters, setVendorFilters] = useState<Set<string>>(new Set());
  const [minContextK, setMinContextK] = useState(0); // context-length slider, in thousands of tokens
  const [sortBy, setSortBy] = useState<SortKey>('relevance');
  const [showFilters, setShowFilters] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CatalogModel | null>(null);
  const [selection, setSelection] = useState<ModelSelection>(() => getModelSelection());
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [showCompare, setShowCompare] = useState(false);
  const [smartTeam, setSmartTeam] = useState<SmartTeam | null>(null);
  const [view, setView] = useState<'library' | 'leaderboard'>('library');
  const [domainPick, setDomainPick] = useState<{ domain: DomainId; best: ReturnType<typeof pickBestForDomain>; mode: SmartMode } | null>(null);

  useEffect(() => {
    const onChange = () => setSelection(getModelSelection());
    window.addEventListener(MODEL_SELECTION_CHANGED, onChange);
    return () => window.removeEventListener(MODEL_SELECTION_CHANGED, onChange);
  }, []);

  const [reloadKey, setReloadKey] = useState(0);
  const retry = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let active = true;
    const hadModels = models.length > 0;
    if (hadModels) setRefreshing(true); else setLoading(true);
    setError(null);
    fetchModelCatalog()
      .then((res) => {
        if (!active) return;
        setModels(res.models);
        setDegraded(res.degraded);
        setDegradedMessage(res.message);
      })
      .catch((e) => {
        if (!active) return;
        // Keep showing cached models if we have them; only hard-error when there's nothing to show.
        if (!hadModels) setError(e?.message || 'Failed to load the model catalog.');
        else { setDegraded(true); setDegradedMessage('Showing the last cached list — couldn’t reach the live catalog.'); }
      })
      .finally(() => { if (active) { setLoading(false); setRefreshing(false); } });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  const visible = useMemo(() => {
    let list = models.filter((model) => matchesFilter(model, filters, domainFilters, vendorFilters, query));
    if (minContextK > 0) list = list.filter((m) => (m.contextLength || 0) >= minContextK * 1000);
    return sortModels(list, sortBy);
  }, [models, filters, domainFilters, vendorFilters, query, minContextK, sortBy]);
  const compareModels = useMemo(() => compareIds.map((id) => models.find((m) => m.id === id)).filter((m): m is CatalogModel => !!m), [compareIds, models]);
  const vendorOptions = useMemo(() => availableVendors(models), [models]);
  const picks = useMemo(() => recommendModels(models, 2), [models]);

  const activeFilterCount = filters.size + domainFilters.size + vendorFilters.size + (minContextK > 0 ? 1 : 0);
  const resetFilters = () => { setFilters(new Set()); setDomainFilters(new Set()); setVendorFilters(new Set()); setMinContextK(0); };

  const useModel = (model: CatalogModel, slot: ModelSlot) => setSelectedModel(slot, model.id, 'specific', model.source);

  // Smart auto-pick: score every model (all sources) per stage and assign the best team.
  const applySmartTeam = (mode: SmartMode) => {
    const team = buildSmartTeam(models, mode);
    if (team.text) setSelectedModel('text', team.text.model.id, 'specific', team.text.model.source);
    if (team.image) setSelectedModel('image', team.image.model.id, 'specific', team.image.model.source);
    (Object.keys(TASK_PROFILES) as SmartTask[]).forEach((task) => {
      const profile = TASK_PROFILES[task];
      const pick = team.perTask[task];
      if (profile.kind === 'text' && profile.stage && pick) {
        setStageModel(profile.stage, pick.model.id, pick.model.source);
      }
    });
    setSmartTeam(team);
  };

  // Domain-aware single pick: "what's the best model for coding / science / …" across all sources.
  const runDomainPick = (domain: DomainId, mode: SmartMode) => setDomainPick({ domain, best: pickBestForDomain(models, domain, mode), mode });

  const toggleCompare = (id: string) =>
    setCompareIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= MAX_COMPARE ? prev : [...prev, id]));

  const selectedImage = models.find((m) => m.id === selection.imageModel);
  const selectedText = models.find((m) => m.id === selection.textModel);

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <button onClick={onBack} className="flex items-center gap-1 text-sm font-bold hover:underline mb-4"><ArrowLeft className="w-4 h-4" /> Back</button>

        <h1 className="text-4xl font-display">Model Library</h1>
        <p className="text-slate-600 max-w-2xl mt-1">
          Every model is live from your sources, tagged by what it's actually good at — <span className="font-bold">coding, science, math, reasoning, writing</span> and more — with
          real benchmark numbers, honest drawbacks and pricing. Hover any term to learn what it means.
          Pick with <span className="font-bold">Use this model</span>, or compare up to {MAX_COMPARE}.
        </p>

        {/* Current selection */}
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 border-2 border-black rounded-lg px-2 py-1 bg-white">
            <ImageIcon className="w-3.5 h-3.5" /> Image: <span className="font-bold">{selectedImage?.name || (selection.imageModel || 'Auto')}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 border-2 border-black rounded-lg px-2 py-1 bg-white">
            <TypeIcon className="w-3.5 h-3.5" /> Text: <span className="font-bold">{selectedText?.name || (selection.textModel || 'Auto')}</span>
          </span>
        </div>

        <VerifiedStrip />

        {/* View: curated Library vs the technical coding leaderboard (OpenRouter-style ranking). */}
        <div className="mt-4 inline-flex rounded-xl border-2 border-black overflow-hidden">
          <button onClick={() => setView('library')} className={`px-4 py-2 text-sm font-bold ${view === 'library' ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}>Library</button>
          <button onClick={() => setView('leaderboard')} className={`px-4 py-2 text-sm font-bold border-l-2 border-black inline-flex items-center gap-1.5 ${view === 'leaderboard' ? 'bg-emerald-600 text-white' : 'bg-white hover:bg-slate-100'}`}><Code2 className="w-4 h-4" /> Coding leaderboard</button>
        </div>

        {view === 'leaderboard' ? (
          <CodingLeaderboard models={models} onStartChat={onStartChat} />
        ) : (
        <>
        {/* Smart auto-pick — the app's own reasoning picks the best model per stage. */}
        <div className="mt-4 bg-gradient-to-r from-brand-blue/10 to-brand-yellow/10 border-2 border-black rounded-xl p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="font-display text-lg flex items-center gap-2"><Wand2 className="w-5 h-5 text-brand-blue" /> Let the app pick</div>
            <p className="text-xs text-slate-600 flex-1 min-w-[220px]">
              Scores every model across all your sources for each stage — capabilities, drawbacks, and your 👍/👎 — and assigns the best team. It keeps improving as you give feedback.
            </p>
            <button onClick={() => applySmartTeam('best')} disabled={loading || models.length === 0} className="px-3 py-2 rounded-lg border-2 border-black bg-brand-blue text-white font-bold text-sm hover:translate-x-[1px] hover:translate-y-[1px] transition-transform disabled:opacity-50 flex items-center gap-1"><Wand2 className="w-4 h-4" /> Auto-pick best</button>
            <button onClick={() => applySmartTeam('free')} disabled={loading || models.length === 0} className="px-3 py-2 rounded-lg border-2 border-black bg-green-600 text-white font-bold text-sm hover:translate-x-[1px] hover:translate-y-[1px] transition-transform disabled:opacity-50 flex items-center gap-1"><Zap className="w-4 h-4" /> Best free (any source)</button>
          </div>
          {smartTeam && (
            <div className="mt-3 pt-3 border-t border-black/10 text-xs space-y-2">
              <div className="font-bold uppercase text-slate-500">{smartTeam.mode === 'free' ? 'Best free team applied' : 'Best team applied'}</div>
              <div className="grid sm:grid-cols-2 gap-2">
                <div className="bg-white border-2 border-black rounded p-2">
                  <div className="font-bold flex items-center gap-1"><TypeIcon className="w-3 h-3" /> Text: {smartTeam.text ? smartTeam.text.model.name : 'none eligible'}</div>
                  {smartTeam.text && <div className="text-slate-500">{smartTeam.text.reasons.join(' · ')}</div>}
                </div>
                <div className="bg-white border-2 border-black rounded p-2">
                  <div className="font-bold flex items-center gap-1"><ImageIcon className="w-3 h-3" /> Image: {smartTeam.image ? smartTeam.image.model.name : 'none eligible'}</div>
                  {smartTeam.image
                    ? <div className="text-slate-500">{smartTeam.image.reasons.join(' · ')}</div>
                    : <div className="text-brand-red">No {smartTeam.mode === 'free' ? 'free ' : ''}image model found in your sources — add an image-capable key.</div>}
                </div>
              </div>
              <details>
                <summary className="cursor-pointer font-bold text-slate-500">Per-stage picks</summary>
                <div className="mt-1 grid sm:grid-cols-2 gap-x-4 gap-y-0.5">
                  {(Object.keys(TASK_PROFILES) as SmartTask[]).map((t) => {
                    const pick = smartTeam.perTask[t];
                    return (
                      <div key={t} className="flex justify-between gap-2">
                        <span className="text-slate-400">{TASK_PROFILES[t].label}</span>
                        <span className="font-mono truncate">{pick ? pick.model.name : '—'}</span>
                      </div>
                    );
                  })}
                </div>
              </details>
            </div>
          )}
        </div>

        {/* Domain-aware single pick — "best model for a specific job", across all your sources. */}
        <div className="mt-4 border-2 border-black rounded-xl p-4 bg-white">
          <div className="flex flex-wrap items-center gap-2">
            <div className="font-display text-lg flex items-center gap-2"><Sparkles className="w-5 h-5 text-brand-blue" /> Best model for…</div>
            <p className="text-xs text-slate-600 flex-1 min-w-[200px]">Ranked by real benchmarks in that domain — not a guess. Pick a job and we'll name the strongest model (and the strongest free one).</p>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {(['coding', 'science', 'math', 'reasoning', 'writing'] as DomainId[]).map((d) => (
              <button key={d} onClick={() => runDomainPick(d, 'best')} disabled={loading || models.length === 0}
                className={`text-xs font-bold px-3 py-1.5 rounded border-2 border-black disabled:opacity-50 ${domainPick?.domain === d ? `${DOMAIN_META[d].tone}` : 'bg-white hover:bg-brand-yellow/60'}`}>
                {DOMAIN_META[d].label}
              </button>
            ))}
          </div>
          {domainPick && (
            <div className="mt-3 pt-3 border-t border-black/10 text-xs">
              {domainPick.best ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-bold uppercase text-slate-500">Best for {DOMAIN_META[domainPick.domain].label}:</span>
                  <button onClick={() => setSelected(domainPick.best!.model)} className="font-bold underline">{domainPick.best.model.name}</button>
                  <span className="text-slate-500">{domainPick.best.reasons.join(' · ')}</span>
                  <button onClick={() => useModel(domainPick.best!.model, slotOf(domainPick.best!.model))} className="ml-auto text-[11px] font-bold px-2 py-0.5 rounded border-2 border-black bg-brand-blue text-white">Use it</button>
                  {(() => { const free = pickBestForDomain(models, domainPick.domain, 'free'); return free && free.model.id !== domainPick.best!.model.id
                    ? <span className="basis-full text-slate-500">Best <span className="font-bold text-green-700">free</span>: <button onClick={() => setSelected(free.model)} className="font-bold underline">{free.model.name}</button> ({free.strength}/100)</span>
                    : null; })()}
                </div>
              ) : (
                <span className="text-brand-red">No model with benchmark data for {DOMAIN_META[domainPick.domain].label} in your sources yet.</span>
              )}
            </div>
          )}
        </div>

        {/* Search · Sort · Filters toggle */}
        <div className="mt-6 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models, capabilities, domains…" className="pl-9 pr-3 py-2 border-2 border-black rounded-lg text-sm w-full focus:outline-none focus:bg-brand-yellow/10" />
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 border-2 border-black rounded-lg px-2.5 py-2 bg-white text-sm font-bold cursor-pointer">
              <ArrowUpDown className="w-4 h-4 text-slate-500" />
              <span className="sr-only">Sort by</span>
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortKey)} className="bg-transparent focus:outline-none cursor-pointer pr-1">
                {SORT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </label>
            <button
              onClick={() => setShowFilters((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border-2 border-black text-sm font-bold transition-colors ${showFilters || activeFilterCount > 0 ? 'bg-brand-blue text-white' : 'bg-white hover:bg-brand-yellow/60'}`}
            >
              <SlidersHorizontal className="w-4 h-4" /> Filters
              {activeFilterCount > 0 && <span className="ml-0.5 rounded-full bg-white text-brand-blue text-[10px] font-bold w-4 h-4 flex items-center justify-center border border-black">{activeFilterCount}</span>}
            </button>
          </div>
        </div>

        {/* Collapsible filter panel */}
        {showFilters && (
          <div className="mt-3 border-2 border-black rounded-xl bg-white p-4 shadow-comic space-y-4">
            <div>
              <div className="text-[10px] font-bold uppercase text-slate-500 mb-1.5">Type &amp; capabilities</div>
              <div className="flex flex-wrap gap-2">
                {FILTERS.map((f) => {
                  const active = f.key === 'all' ? filters.size === 0 : filters.has(f.key);
                  const toggle = () => setFilters((prev) => {
                    if (f.key === 'all') return new Set<FilterKey>();
                    const next = new Set(prev);
                    if (next.has(f.key)) next.delete(f.key); else next.add(f.key);
                    return next;
                  });
                  return (
                    <button key={f.key} onClick={toggle} className={`text-[11px] font-bold uppercase px-2.5 py-1 rounded border-2 border-black transition-colors ${active ? 'bg-brand-blue text-white' : 'bg-white hover:bg-brand-yellow/60'}`}>{f.label}</button>
                  );
                })}
              </div>
            </div>

            {vendorOptions.length > 0 && (
              <div>
                <div className="text-[10px] font-bold uppercase text-slate-500 mb-1.5">Provider / maker</div>
                <div className="flex flex-wrap gap-2">
                  {vendorOptions.map(({ vendor, count }) => {
                    const active = vendorFilters.has(vendor.id);
                    const toggle = () => setVendorFilters((prev) => {
                      const next = new Set(prev);
                      next.has(vendor.id) ? next.delete(vendor.id) : next.add(vendor.id);
                      return next;
                    });
                    return (
                      <button
                        key={vendor.id}
                        onClick={toggle}
                        className={`text-[11px] font-bold px-2.5 py-1 rounded border-2 border-black transition-colors flex items-center gap-1.5 ${active ? vendor.color : 'bg-white hover:bg-slate-100'}`}
                      >
                        {vendor.label}
                        <span className={`text-[9px] font-mono rounded-full px-1 ${active ? 'bg-white/25' : 'bg-slate-200 text-slate-600'}`}>{count}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div>
              <div className="text-[10px] font-bold uppercase text-slate-500 mb-1.5 flex items-center gap-1">
                Good at (benchmark-backed) <InfoDot content={{ title: 'Domain filters', body: 'Keeps models that are at least "Capable" (benchmark strength ≥ 55/100) in this area. ANDs with the rest — e.g. Coding + Free.' }} />
              </div>
              <div className="flex flex-wrap gap-2">
                {FILTERABLE_DOMAINS.map((d) => {
                  const active = domainFilters.has(d);
                  const meta = DOMAIN_META[d];
                  return (
                    <button
                      key={d}
                      onClick={() => setDomainFilters((prev) => { const next = new Set(prev); next.has(d) ? next.delete(d) : next.add(d); return next; })}
                      className={`text-[11px] font-bold px-2.5 py-1 rounded border-2 border-black transition-colors ${active ? meta.tone : 'bg-white hover:bg-slate-100'}`}
                    >
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="text-[10px] font-bold uppercase text-slate-500 mb-1.5 flex items-center gap-1">
                Minimum context window <InfoDot term="context_length" />
                <span className="ml-auto font-mono text-[11px] font-bold text-slate-700">{minContextK === 0 ? 'Any' : `≥ ${minContextK}K`}</span>
              </div>
              <input type="range" min={0} max={1000} step={4} value={minContextK} onChange={(e) => setMinContextK(Number(e.target.value))} className="w-full accent-brand-blue cursor-pointer" />
              <div className="flex justify-between text-[9px] font-bold text-slate-400"><span>Any</span><span>200K</span><span>500K</span><span>1M+</span></div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-dashed border-slate-200">
              <span className="text-[11px] font-bold text-slate-500">{visible.length} match{visible.length === 1 ? '' : 'es'}</span>
              <button onClick={resetFilters} disabled={activeFilterCount === 0} className="text-[11px] font-bold px-2.5 py-1 rounded border-2 border-black bg-white hover:bg-slate-100 disabled:opacity-40 flex items-center gap-1"><RotateCcw className="w-3 h-3" /> Reset filters</button>
            </div>
          </div>
        )}

        {degraded && (
          <div className="mt-4 bg-amber-100 border-2 border-black rounded-lg p-3 text-sm flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>Live catalog unavailable{degradedMessage ? ` (${degradedMessage})` : ''}. Add an <code>OpenRouter</code> key (Settings → API Configuration) or set <code>OPENROUTER_API_KEY</code> on the server to load the full, live model list.</span>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 className="w-8 h-8 animate-spin" /></div>
        ) : error ? (
          <div className="mt-8 bg-red-100 border-2 border-black rounded-lg p-4 text-sm flex flex-col sm:flex-row sm:items-center gap-3">
            <AlertTriangle className="w-5 h-5 shrink-0" />
            <span className="flex-1">Couldn’t load the model catalog: {error}. The server may be waking up — try again in a moment.</span>
            <button onClick={retry} className="self-start font-bold px-3 py-1.5 rounded border-2 border-black bg-white hover:bg-brand-yellow flex items-center gap-1">
              <Loader2 className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} /> Retry
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="mt-8 text-center text-slate-500 py-16">No models match your filters.</div>
        ) : (
          <>
            {activeFilterCount === 0 && !query.trim() && picks.bestValue.length > 0 && (
              <div className="mt-4 border-2 border-black rounded-xl bg-brand-yellow/15 p-4 shadow-comic">
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles className="w-4 h-4" />
                  <span className="font-display text-lg">Top picks — best accuracy for the price</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {picks.bestValue.map((m, i) => (
                    <button key={m.id} onClick={() => setSelected(m)} className="text-left bg-white border-2 border-black rounded-lg p-3 hover:shadow-comic-hover hover:translate-x-[1px] hover:translate-y-[1px] transition-all">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-[9px] font-bold uppercase px-1 py-0.5 rounded bg-brand-blue text-white">#{i + 1} value</span>
                        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border border-black ${getModelVendor(m).color}`}>{getModelVendor(m).label}</span>
                      </div>
                      <div className="font-bold text-sm leading-tight truncate">{m.name}</div>
                      <div className="text-[11px] text-slate-600 mt-1 flex items-center gap-2 flex-wrap">
                        <span title="Arena Elo (LMArena)">★ {accuracyElo(m)} Elo</span>
                        <span>·</span>
                        <span>{costLabel(m)}</span>
                      </div>
                    </button>
                  ))}
                  {picks.topImage && (
                    <button onClick={() => setSelected(picks.topImage!)} className="text-left bg-white border-2 border-black rounded-lg p-3 hover:shadow-comic-hover hover:translate-x-[1px] hover:translate-y-[1px] transition-all">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-[9px] font-bold uppercase px-1 py-0.5 rounded bg-fuchsia-600 text-white">Top image</span>
                        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border border-black ${getModelVendor(picks.topImage).color}`}>{getModelVendor(picks.topImage).label}</span>
                      </div>
                      <div className="font-bold text-sm leading-tight truncate">{picks.topImage.name}</div>
                      <div className="text-[11px] text-slate-600 mt-1">{costLabel(picks.topImage)}{picks.topImage.supportsImageInput ? ' · reference-capable' : ''}</div>
                    </button>
                  )}
                </div>
                <div className="text-[10px] text-slate-500 mt-2">Ranked by Arena-Elo accuracy per dollar of output. Free models can rate-limit; verify pricing at the source.</div>
              </div>
            )}
            <div className="mt-4 text-xs font-bold uppercase text-slate-500 flex items-center gap-2">
              {visible.length} models
              {refreshing && <span className="flex items-center gap-1 text-slate-400 normal-case font-normal"><Loader2 className="w-3 h-3 animate-spin" /> refreshing…</span>}
            </div>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {visible.map((model) => (
                <ModelCard
                  key={model.id}
                  model={model}
                  selection={selection}
                  compared={compareIds.includes(model.id)}
                  onOpen={() => setSelected(model)}
                  onUse={(slot) => useModel(model, slot)}
                  onToggleCompare={() => toggleCompare(model.id)}
                  onStartChat={onStartChat}
                />
              ))}
            </div>
          </>
        )}
        </>
        )}
      </div>

      {selected && <DetailModal model={selected} selection={selection} onClose={() => setSelected(null)} onUse={(slot) => useModel(selected, slot)} onStartChat={onStartChat} />}
      {showCompare && compareModels.length > 0 && <CompareModal models={compareModels} selection={selection} onClose={() => setShowCompare(false)} onUse={useModel} />}

      {/* Compare tray — shows the actual models picked (as removable chips), not just a count. */}
      {compareIds.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t-4 border-black shadow-comic">
          <div className="max-w-7xl mx-auto px-6 py-3 flex items-center gap-3">
            <div className="text-sm font-bold flex items-center gap-1.5 shrink-0">
              <Scale className="w-4 h-4" /> Compare <span className="font-normal text-slate-400">{compareIds.length}/{MAX_COMPARE}</span>
            </div>
            <div className="flex items-center gap-1.5 flex-1 overflow-x-auto py-0.5">
              {compareModels.map((m) => (
                <span key={m.id} className="flex items-center gap-1 shrink-0 text-[11px] font-bold border-2 border-black rounded-full pl-2 pr-1 py-0.5 bg-brand-yellow/40 max-w-[14rem]">
                  <span className="truncate">{m.name}</span>
                  <button onClick={() => toggleCompare(m.id)} className="rounded-full hover:bg-black/10 p-0.5 shrink-0" aria-label={`Remove ${m.name} from comparison`}><X className="w-3 h-3" /></button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => setCompareIds([])} className="text-xs font-bold px-3 py-1.5 rounded border-2 border-black bg-white hover:bg-slate-100">Clear</button>
              <button onClick={() => setShowCompare(true)} disabled={compareIds.length < 2} className="text-xs font-bold px-3 py-1.5 rounded border-2 border-black bg-brand-blue text-white disabled:opacity-50 flex items-center gap-1"><Scale className="w-3 h-3" /> Compare {compareIds.length}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
