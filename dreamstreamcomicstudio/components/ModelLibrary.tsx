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
  Sparkles
} from 'lucide-react';
import {
  fetchModelCatalog,
  costLabel,
  providerOrigin,
  type Band,
  type CatalogModel
} from '../services/modelCatalog';

interface ModelLibraryProps {
  onBack: () => void;
}

type FilterKey = 'all' | 'free' | 'image' | 'text' | 'refs';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'free', label: 'Free' },
  { key: 'image', label: 'Image' },
  { key: 'text', label: 'Text' },
  { key: 'refs', label: 'Reference-capable' }
];

const BAND_COLOR: Record<Band, string> = {
  free: 'bg-green-500 text-white',
  low: 'bg-brand-blue text-white',
  medium: 'bg-brand-yellow text-black',
  high: 'bg-brand-red text-white'
};

const Badge: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border border-black ${className}`}>{children}</span>
);

const matchesFilter = (model: CatalogModel, filter: FilterKey, query: string): boolean => {
  if (filter === 'free' && !model.isFree) return false;
  if (filter === 'image' && !model.supportsImageOutput) return false;
  if (filter === 'text' && model.supportsImageOutput) return false;
  if (filter === 'refs' && !model.supportsImageInput) return false;
  const q = query.trim().toLowerCase();
  if (q) {
    const haystack = `${model.id} ${model.name} ${model.description || ''}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
};

const ModelCard: React.FC<{ model: CatalogModel; onOpen: () => void }> = ({ model, onOpen }) => (
  <button
    onClick={onOpen}
    className="text-left bg-white border-2 border-black rounded-lg p-4 shadow-comic hover:shadow-comic-hover hover:translate-x-[2px] hover:translate-y-[2px] transition-all flex flex-col gap-3"
  >
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase text-slate-500">{providerOrigin(model)}</div>
        <div className="font-bold leading-tight truncate">{model.name}</div>
      </div>
      <Badge className={BAND_COLOR[model.costBand]}>{costLabel(model)}</Badge>
    </div>

    <div className="flex flex-wrap gap-1">
      {model.isFree && <Badge className="bg-green-500 text-white">Free</Badge>}
      {model.supportsImageOutput ? (
        <Badge className="bg-brand-blue text-white">
          <ImageIcon className="w-3 h-3 inline -mt-0.5 mr-0.5" />Image
        </Badge>
      ) : (
        <Badge className="bg-slate-100 text-slate-700">
          <TypeIcon className="w-3 h-3 inline -mt-0.5 mr-0.5" />Text
        </Badge>
      )}
      {model.supportsImageInput && <Badge className="bg-brand-yellow text-black">Refs</Badge>}
      {model.supportsJsonOutput && <Badge className="bg-slate-100 text-slate-700">JSON</Badge>}
    </div>

    {model.editorialNote && (
      <p className="text-xs text-slate-600 line-clamp-3">{model.editorialNote}</p>
    )}

    <div className="mt-auto flex flex-wrap gap-1">
      {model.roles.slice(0, 3).map((role) => (
        <span key={role} className="text-[10px] font-bold uppercase text-slate-500">
          #{role}
        </span>
      ))}
    </div>
  </button>
);

const DetailModal: React.FC<{ model: CatalogModel; onClose: () => void }> = ({ model, onClose }) => (
  <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
    <div
      className="bg-white border-4 border-black rounded-xl shadow-comic max-w-2xl w-full max-h-[85vh] overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="sticky top-0 bg-white border-b-2 border-black px-5 py-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase text-slate-500">{providerOrigin(model)}</div>
          <h2 className="text-xl font-display leading-tight">{model.name}</h2>
          <code className="text-[11px] text-slate-500 break-all">{model.id}</code>
        </div>
        <button onClick={onClose} className="border-2 border-black rounded p-1 hover:bg-brand-yellow shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-5 space-y-4">
        <div className="flex flex-wrap gap-1.5">
          <Badge className={BAND_COLOR[model.costBand]}>{costLabel(model)}</Badge>
          {model.isFree && <Badge className="bg-green-500 text-white">Free</Badge>}
          {model.supportsImageOutput && <Badge className="bg-brand-blue text-white">Image output</Badge>}
          {model.supportsImageInput && <Badge className="bg-brand-yellow text-black">Reference images</Badge>}
          {model.supportsJsonOutput && <Badge className="bg-slate-100 text-slate-700">Structured JSON</Badge>}
          {typeof model.contextLength === 'number' && (
            <Badge className="bg-slate-100 text-slate-700">{Math.round(model.contextLength / 1000)}K ctx</Badge>
          )}
        </div>

        {model.editorialNote && (
          <div className="bg-brand-yellow/30 border-2 border-black rounded-lg p-3 text-sm flex gap-2">
            <Sparkles className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{model.editorialNote}</span>
          </div>
        )}

        {model.description && <p className="text-sm text-slate-600">{model.description}</p>}

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <h3 className="text-xs font-bold uppercase mb-2 flex items-center gap-1">
              <Check className="w-4 h-4 text-green-600" /> What's possible
            </h3>
            <ul className="space-y-1.5">
              {model.possibilities.length ? (
                model.possibilities.map((item, i) => (
                  <li key={i} className="text-xs text-slate-700 flex gap-1.5">
                    <Check className="w-3.5 h-3.5 text-green-600 shrink-0 mt-0.5" />
                    {item}
                  </li>
                ))
              ) : (
                <li className="text-xs text-slate-400">—</li>
              )}
            </ul>
          </div>
          <div>
            <h3 className="text-xs font-bold uppercase mb-2 flex items-center gap-1">
              <AlertTriangle className="w-4 h-4 text-amber-600" /> Drawbacks
            </h3>
            <ul className="space-y-1.5">
              {model.drawbacks.length ? (
                model.drawbacks.map((item, i) => (
                  <li key={i} className="text-xs text-slate-700 flex gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                    {item}
                  </li>
                ))
              ) : (
                <li className="text-xs text-slate-400">None noted</li>
              )}
            </ul>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 pt-2 border-t-2 border-dashed border-slate-200">
          <span className="text-[10px] font-bold uppercase text-slate-500 mr-1 flex items-center gap-1">
            <Layers className="w-3 h-3" /> Roles:
          </span>
          {model.roles.map((role) => (
            <Badge key={role} className="bg-slate-100 text-slate-700">{role}</Badge>
          ))}
        </div>
      </div>
    </div>
  </div>
);

export const ModelLibrary: React.FC<ModelLibraryProps> = ({ onBack }) => {
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [degraded, setDegraded] = useState(false);
  const [degradedMessage, setDegradedMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CatalogModel | null>(null);

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
      .catch((e) => {
        if (!active) return;
        setError(e?.message || 'Failed to load the model catalog.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const visible = useMemo(
    () => models.filter((model) => matchesFilter(model, filter, query)),
    [models, filter, query]
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <button onClick={onBack} className="flex items-center gap-1 text-sm font-bold hover:underline mb-4">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>

        <h1 className="text-4xl font-display">Model Library</h1>
        <p className="text-slate-600 max-w-2xl mt-1">
          Every model is routed through OpenRouter and annotated for comics — what each is good for, what's
          possible, and the honest drawbacks. Free models power the script &amp; planning brain; image models
          (mostly paid) draw the panels. Reference-capable models hold characters consistent across pages.
        </p>

        {/* Controls */}
        <div className="mt-6 flex flex-col md:flex-row md:items-center gap-3">
          <div className="flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`text-xs font-bold uppercase px-3 py-1.5 rounded border-2 border-black transition-colors ${
                  filter === f.key ? 'bg-brand-blue text-white' : 'bg-white hover:bg-brand-yellow/60'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="md:ml-auto relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              className="pl-9 pr-3 py-2 border-2 border-black rounded-lg text-sm w-full md:w-64 focus:outline-none focus:bg-brand-yellow/10"
            />
          </div>
        </div>

        {degraded && (
          <div className="mt-4 bg-amber-100 border-2 border-black rounded-lg p-3 text-sm flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              Live catalog unavailable{degradedMessage ? ` (${degradedMessage})` : ''}. Configure
              {' '}<code>OPENROUTER_API_KEY</code> on the server to load the full model list.
            </span>
          </div>
        )}

        {/* Body */}
        {loading ? (
          <div className="flex items-center justify-center py-24 text-slate-400">
            <Loader2 className="w-8 h-8 animate-spin" />
          </div>
        ) : error ? (
          <div className="mt-8 bg-red-100 border-2 border-black rounded-lg p-4 text-sm">{error}</div>
        ) : visible.length === 0 ? (
          <div className="mt-8 text-center text-slate-500 py-16">No models match your filters.</div>
        ) : (
          <>
            <div className="mt-4 text-xs font-bold uppercase text-slate-500">{visible.length} models</div>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {visible.map((model) => (
                <ModelCard key={model.id} model={model} onOpen={() => setSelected(model)} />
              ))}
            </div>
          </>
        )}
      </div>

      {selected && <DetailModal model={selected} onClose={() => setSelected(null)} />}
    </div>
  );
};
