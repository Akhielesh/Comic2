import React, { useEffect, useMemo, useState } from 'react';
import { Search, X, Loader2, Check, Sparkles, Globe, Eye, Brain } from 'lucide-react';
import { ModalPortal } from '../modals/ModalPortal';
import {
  fetchModelCatalog,
  sourceLabel,
  providerOrigin,
  costLabel,
  type CatalogModel
} from '../../services/modelCatalog';
import { getCapabilities } from '../../services/modelCapabilities';

interface ChatModelPickerProps {
  selectedModelId: string | null;
  onSelect: (model: CatalogModel) => void;
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

const CapabilityChips: React.FC<{ model: CatalogModel }> = ({ model }) => {
  const caps = getCapabilities(model);
  return (
    <div className="flex flex-wrap items-center gap-1">
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

export const ChatModelPicker: React.FC<ChatModelPickerProps> = ({ selectedModelId, onSelect, onClose }) => {
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [facet, setFacet] = useState<Facet>('all');

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
    const q = query.trim().toLowerCase();
    return models.filter((model) => {
      const caps = getCapabilities(model);
      if (facet === 'free' && !caps.isFree) return false;
      if (facet === 'reasoning' && !caps.reasoning) return false;
      if (facet === 'vision' && !caps.imageInput) return false;
      if (facet === 'web' && model.source !== 'openrouter') return false;
      if (!q) return true;
      return (
        model.name.toLowerCase().includes(q) ||
        model.id.toLowerCase().includes(q) ||
        (model.description || '').toLowerCase().includes(q)
      );
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
                      return (
                        <button
                          key={`${model.source}:${model.id}`}
                          onClick={() => onSelect(model)}
                          className={`text-left border-2 border-black rounded-lg p-3 transition-all hover:translate-x-[1px] hover:translate-y-[1px] ${isSelected ? 'bg-brand-yellow/40 shadow-comic-hover' : 'bg-white shadow-comic hover:bg-slate-50'}`}
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
                            <CapabilityChips model={model} />
                          </div>
                          {model.description && (
                            <p className="text-[11px] text-slate-600 mt-1.5 line-clamp-2">{model.description}</p>
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
