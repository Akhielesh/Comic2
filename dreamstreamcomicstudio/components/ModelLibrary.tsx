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
  Plus,
  Wand2,
  Zap,
  ThumbsUp,
  ThumbsDown
} from 'lucide-react';
import {
  fetchModelCatalog,
  costLabel,
  providerOrigin,
  type Band,
  type CatalogModel
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
import { buildSmartTeam, TASK_PROFILES, type SmartMode, type SmartTask, type SmartTeam } from '../services/smartModelSelection';
import { recordModelFeedback, latestVote, MODEL_FEEDBACK_CHANGED, type FeedbackVote } from '../services/modelFeedback';

interface ModelLibraryProps {
  onBack: () => void;
}

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

const matchesFilter = (model: CatalogModel, filter: FilterKey, query: string): boolean => {
  const caps = getCapabilities(model);
  if (filter === 'free' && !model.isFree) return false;
  if (filter === 'image' && !model.supportsImageOutput) return false;
  if (filter === 'text' && model.supportsImageOutput) return false;
  if (filter === 'refs' && !model.supportsImageInput) return false;
  if (filter === 'editing' && !caps.imageEditing) return false;
  if (filter === 'reasoning' && !caps.reasoning) return false;
  if (filter === 'openrouter' && model.source !== 'openrouter') return false;
  if (filter === 'nvidia' && model.source !== 'nvidia') return false;

  // Smart search: each token is either a semantic facet ("free", "image", "vision",
  // "reasoning", "editing", "nvidia"…) or a plain substring. ALL tokens must match — so
  // typing "free image" auto-narrows to free image models without touching the chips.
  const tokens = query.trim().toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (tokens.length) {
    const capLabels = capabilityBadges(model).map((b) => b.label).join(' ');
    const haystack = [
      model.id, model.name, model.description, model.source,
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

// 👍/👎 a model to teach Smart auto-pick. Dislike optionally asks why (never forced).
const FeedbackButtons: React.FC<{ modelId: string; task?: string }> = ({ modelId, task }) => {
  const [vote, setVote] = useState<FeedbackVote | null>(() => latestVote(modelId));
  const cast = (v: FeedbackVote) => (e: React.MouseEvent) => {
    e.stopPropagation();
    const note = v === 'dislike'
      ? (window.prompt('Optional — what was off about this model? (leave blank to skip)') || undefined)
      : undefined;
    recordModelFeedback(modelId, v, { note, task });
    setVote(v);
  };
  return (
    <div className="flex items-center gap-1" title="Teach Smart auto-pick">
      <button onClick={cast('like')} className={`p-1 rounded border-2 border-black ${vote === 'like' ? 'bg-green-500 text-white' : 'bg-white hover:bg-green-100'}`} aria-label="Like this model"><ThumbsUp className="w-3 h-3" /></button>
      <button onClick={cast('dislike')} className={`p-1 rounded border-2 border-black ${vote === 'dislike' ? 'bg-brand-red text-white' : 'bg-white hover:bg-red-100'}`} aria-label="Dislike this model"><ThumbsDown className="w-3 h-3" /></button>
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
}> = ({ model, selection, compared, onOpen, onUse, onToggleCompare }) => (
  <div
    onClick={onOpen}
    className="cursor-pointer text-left bg-white border-2 border-black rounded-lg p-4 shadow-comic hover:shadow-comic-hover hover:translate-x-[2px] hover:translate-y-[2px] transition-all flex flex-col gap-3"
  >
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase text-slate-500">{providerOrigin(model)}</div>
        <div className="font-bold leading-tight truncate">{model.name}</div>
      </div>
      <Badge className={BAND_COLOR[model.costBand]}>{costLabel(model)}</Badge>
    </div>

    <div className="flex flex-wrap gap-1">
      {capabilityBadges(model).map((b) => <Badge key={b.label} className={TONE_CLASS[b.tone]}>{b.label}</Badge>)}
    </div>

    {model.editorialNote && <p className="text-xs text-slate-600 line-clamp-2">{model.editorialNote}</p>}

    <div className="mt-auto flex items-center justify-between gap-2 pt-2 border-t border-dashed border-slate-200">
      <UseModelControl model={model} selection={selection} onUse={onUse} />
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

const DetailModal: React.FC<{ model: CatalogModel; selection: ModelSelection; onClose: () => void; onUse: (slot: ModelSlot) => void }> = ({ model, selection, onClose, onUse }) => (
  <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
    <div className="bg-white border-4 border-black rounded-xl shadow-comic max-w-2xl w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
      <div className="sticky top-0 bg-white border-b-2 border-black px-5 py-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase text-slate-500">{providerOrigin(model)}</div>
          <h2 className="text-xl font-display leading-tight">{model.name}</h2>
          <code className="text-[11px] text-slate-500 break-all">{model.id}</code>
        </div>
        <button onClick={onClose} className="border-2 border-black rounded p-1 hover:bg-brand-yellow shrink-0"><X className="w-4 h-4" /></button>
      </div>

      <div className="p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge className={BAND_COLOR[model.costBand]}>{costLabel(model)}</Badge>
          {model.isFree && <Badge className="bg-green-500 text-white">Free</Badge>}
          {model.supportsImageOutput && <Badge className="bg-brand-blue text-white">Text→Image</Badge>}
          {getCapabilities(model).imageInput && !model.supportsImageOutput && <Badge className="bg-brand-yellow text-black">Image→Text (vision)</Badge>}
          {model.supportsImageInput && model.supportsImageOutput && <Badge className="bg-brand-yellow text-black">Reference images</Badge>}
          {getCapabilities(model).imageEditing && <Badge className="bg-fuchsia-600 text-white">Image editing</Badge>}
          {getCapabilities(model).reasoning && <Badge className="bg-indigo-600 text-white">Reasoning</Badge>}
          {model.supportsJsonOutput && <Badge className="bg-slate-100 text-slate-700">Structured JSON</Badge>}
          {typeof model.contextLength === 'number' && <Badge className="bg-slate-100 text-slate-700">{Math.round(model.contextLength / 1000)}K ctx</Badge>}
          <span className="ml-auto"><UseModelControl model={model} selection={selection} onUse={onUse} /></span>
        </div>

        {model.editorialNote && (
          <div className="bg-brand-yellow/30 border-2 border-black rounded-lg p-3 text-sm flex gap-2">
            <Sparkles className="w-4 h-4 shrink-0 mt-0.5" /><span>{model.editorialNote}</span>
          </div>
        )}
        {model.description && <p className="text-sm text-slate-600">{model.description}</p>}

        <div className="grid sm:grid-cols-3 gap-3 text-[11px]">
          <div className="border-2 border-black rounded-lg p-2"><div className="text-slate-400 uppercase font-bold">Input tokens</div><div className="font-mono">{perMillion(model.pricing.promptPerToken)}</div></div>
          <div className="border-2 border-black rounded-lg p-2"><div className="text-slate-400 uppercase font-bold">Output tokens</div><div className="font-mono">{perMillion(model.pricing.completionPerToken)}</div></div>
          <div className="border-2 border-black rounded-lg p-2"><div className="text-slate-400 uppercase font-bold">Per image</div><div className="font-mono">{model.pricing.imagePerImage > 0 ? `$${model.pricing.imagePerImage.toFixed(3)}` : '—'}</div></div>
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

const CompareModal: React.FC<{ models: CatalogModel[]; selection: ModelSelection; onClose: () => void; onUse: (model: CatalogModel, slot: ModelSlot) => void }> = ({ models, selection, onClose, onUse }) => {
  const rows: { label: string; render: (m: CatalogModel) => React.ReactNode }[] = [
    { label: 'Cost', render: (m) => <Badge className={BAND_COLOR[m.costBand]}>{costLabel(m)}</Badge> },
    { label: 'Free', render: (m) => (m.isFree ? '✅' : '—') },
    { label: 'Output', render: (m) => (m.supportsImageOutput ? 'Image' : 'Text') },
    { label: 'Reference images', render: (m) => (m.supportsImageInput ? '✅' : '—') },
    { label: 'Image editing', render: (m) => (getCapabilities(m).imageEditing ? '✅' : '—') },
    { label: 'Reasoning', render: (m) => (getCapabilities(m).reasoning ? '✅' : '—') },
    { label: 'Structured JSON', render: (m) => (m.supportsJsonOutput ? '✅' : '—') },
    { label: 'Context', render: (m) => (m.contextLength ? `${Math.round(m.contextLength / 1000)}K` : '—') },
    { label: 'Input $/Mtok', render: (m) => perMillion(m.pricing.promptPerToken) },
    { label: 'Output $/Mtok', render: (m) => perMillion(m.pricing.completionPerToken) },
    { label: 'Per image', render: (m) => (m.pricing.imagePerImage > 0 ? `$${m.pricing.imagePerImage.toFixed(3)}` : '—') },
    { label: 'Roles', render: (m) => m.roles.join(', ') || '—' },
    { label: 'Best for', render: (m) => (m.possibilities[0] || '—') },
    { label: 'Watch out', render: (m) => (m.drawbacks[0] || 'None noted') }
  ];
  return (
    <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white border-4 border-black rounded-xl shadow-comic max-w-5xl w-full max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b-2 border-black px-5 py-4 flex items-center justify-between">
          <h2 className="text-xl font-display flex items-center gap-2"><Scale className="w-5 h-5" /> Compare {models.length} models</h2>
          <button onClick={onClose} className="border-2 border-black rounded p-1 hover:bg-brand-yellow"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="text-left p-2 sticky left-0 bg-white" />
                {models.map((m) => (
                  <th key={m.id} className="p-2 align-top text-left min-w-[10rem]">
                    <div className="font-bold leading-tight">{m.name}</div>
                    <div className="text-[10px] text-slate-400 font-mono break-all">{m.id}</div>
                    <div className="mt-1"><UseModelControl model={m} selection={selection} onUse={(slot) => onUse(m, slot)} /></div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-t border-slate-200">
                  <td className="p-2 font-bold text-slate-500 uppercase text-[10px] sticky left-0 bg-white whitespace-nowrap">{row.label}</td>
                  {models.map((m) => <td key={m.id} className="p-2 align-top">{row.render(m)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export const ModelLibrary: React.FC<ModelLibraryProps> = ({ onBack }) => {
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [degraded, setDegraded] = useState(false);
  const [degradedMessage, setDegradedMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CatalogModel | null>(null);
  const [selection, setSelection] = useState<ModelSelection>(() => getModelSelection());
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [showCompare, setShowCompare] = useState(false);
  const [smartTeam, setSmartTeam] = useState<SmartTeam | null>(null);

  useEffect(() => {
    const onChange = () => setSelection(getModelSelection());
    window.addEventListener(MODEL_SELECTION_CHANGED, onChange);
    return () => window.removeEventListener(MODEL_SELECTION_CHANGED, onChange);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchModelCatalog()
      .then((res) => {
        if (!active) return;
        setModels(res.models);
        setDegraded(res.degraded);
        setDegradedMessage(res.message);
      })
      .catch((e) => { if (active) setError(e?.message || 'Failed to load the model catalog.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const visible = useMemo(() => models.filter((model) => matchesFilter(model, filter, query)), [models, filter, query]);
  const compareModels = useMemo(() => compareIds.map((id) => models.find((m) => m.id === id)).filter((m): m is CatalogModel => !!m), [compareIds, models]);

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
          Every model is live from OpenRouter and annotated for comics — what each is good for, what's
          possible, the honest drawbacks, and real pricing. Pick models with <span className="font-bold">Use this model</span>,
          or select up to {MAX_COMPARE} to compare.
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

        {/* Controls */}
        <div className="mt-6 flex flex-col md:flex-row md:items-center gap-3">
          <div className="flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button key={f.key} onClick={() => setFilter(f.key)} className={`text-xs font-bold uppercase px-3 py-1.5 rounded border-2 border-black transition-colors ${filter === f.key ? 'bg-brand-blue text-white' : 'bg-white hover:bg-brand-yellow/60'}`}>{f.label}</button>
            ))}
          </div>
          <div className="md:ml-auto relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models…" className="pl-9 pr-3 py-2 border-2 border-black rounded-lg text-sm w-full md:w-64 focus:outline-none focus:bg-brand-yellow/10" />
          </div>
        </div>

        {degraded && (
          <div className="mt-4 bg-amber-100 border-2 border-black rounded-lg p-3 text-sm flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>Live catalog unavailable{degradedMessage ? ` (${degradedMessage})` : ''}. Add an <code>OpenRouter</code> key (Settings → API Configuration) or set <code>OPENROUTER_API_KEY</code> on the server to load the full, live model list.</span>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 className="w-8 h-8 animate-spin" /></div>
        ) : error ? (
          <div className="mt-8 bg-red-100 border-2 border-black rounded-lg p-4 text-sm">{error}</div>
        ) : visible.length === 0 ? (
          <div className="mt-8 text-center text-slate-500 py-16">No models match your filters.</div>
        ) : (
          <>
            <div className="mt-4 text-xs font-bold uppercase text-slate-500">{visible.length} models</div>
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
                />
              ))}
            </div>
          </>
        )}
      </div>

      {selected && <DetailModal model={selected} selection={selection} onClose={() => setSelected(null)} onUse={(slot) => useModel(selected, slot)} />}
      {showCompare && compareModels.length > 0 && <CompareModal models={compareModels} selection={selection} onClose={() => setShowCompare(false)} onUse={useModel} />}

      {/* Compare tray */}
      {compareIds.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t-4 border-black shadow-comic">
          <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between gap-3">
            <div className="text-sm font-bold flex items-center gap-2"><Scale className="w-4 h-4" /> {compareIds.length}/{MAX_COMPARE} selected to compare</div>
            <div className="flex items-center gap-2">
              <button onClick={() => setCompareIds([])} className="text-xs font-bold px-3 py-1.5 rounded border-2 border-black bg-white hover:bg-slate-100">Clear</button>
              <button onClick={() => setShowCompare(true)} disabled={compareIds.length < 2} className="text-xs font-bold px-3 py-1.5 rounded border-2 border-black bg-brand-blue text-white disabled:opacity-50 flex items-center gap-1"><Plus className="w-3 h-3" /> Compare</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
