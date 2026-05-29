import React, { useEffect, useMemo, useState } from 'react';
import { Image as ImageIcon, Type as TypeIcon, Loader2, AlertTriangle, Sparkles } from 'lucide-react';
import { fetchModelCatalog, type CatalogModel } from '../services/modelCatalog';
import {
  getModelSelection,
  setSelectedModel,
  MODEL_SELECTION_CHANGED,
  type ModelSlot
} from '../services/modelSelection';
import { getActiveKey } from '../services/apiKeys';
import { getCapabilities } from '../services/modelCapabilities';

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

const Slot: React.FC<{
  slot: ModelSlot;
  icon: React.ReactNode;
  label: string;
  models: CatalogModel[];
  freeModel?: CatalogModel;
  selectedId: string | null;
}> = ({ slot, icon, label, models, freeModel, selectedId }) => {
  const selected = models.find((m) => m.id === selectedId);
  return (
    <div className="border-2 border-black rounded-lg p-3 bg-white">
      <div className="flex items-center gap-2 text-sm font-bold mb-2">{icon} {label}</div>
      <select
        value={selectedId || ''}
        onChange={(e) => setSelectedModel(slot, e.target.value || null, e.target.value ? 'specific' : 'default')}
        className="w-full border-2 border-black rounded px-2 py-1.5 text-sm bg-white"
      >
        <option value="">Default (app picks the best)</option>
        {freeModel && <option value={freeModel.id}>★ Free · {freeModel.name}</option>}
        <optgroup label={`${label} models`}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.name}{m.isFree ? ' · free' : ''}</option>
          ))}
        </optgroup>
      </select>
      {selectedId ? <CapBadges model={selected} /> : <div className="text-[11px] text-slate-500 mt-1">Auto-selected (prefers free when available).</div>}
    </div>
  );
};

/**
 * Default / Free / Specific model selection for image and text, driven by the live
 * OpenRouter catalog. Reflected everywhere via modelSelection (pill, editor, checklist).
 */
export const ModelSelectionPanel: React.FC = () => {
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [degraded, setDegraded] = useState(false);
  const [sel, setSel] = useState(getModelSelection());

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

  const imageModels = useMemo(() => catalog.filter((m) => m.supportsImageOutput), [catalog]);
  const textModels = useMemo(() => catalog.filter((m) => !m.supportsImageOutput), [catalog]);
  const freeImage = useMemo(() => imageModels.find((m) => m.isFree), [imageModels]);
  const freeText = useMemo(() => textModels.find((m) => m.isFree), [textModels]);
  const hasOpenRouter = !!getActiveKey('openrouter');

  return (
    <div className="bg-white border-2 border-black rounded-xl shadow-comic p-4 space-y-3">
      <div>
        <h4 className="font-display text-lg flex items-center gap-2"><Sparkles className="w-4 h-4" /> Models</h4>
        <p className="text-[11px] text-slate-500">Choose the image and text models, or leave on Default. Free models are flagged when OpenRouter offers them.</p>
      </div>

      {!hasOpenRouter && (
        <div className="text-[11px] bg-amber-100 border-2 border-black rounded-lg p-2 flex gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          Add an OpenRouter key above to use these models for generation.
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-slate-400 text-sm py-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading live model catalog…</div>
      ) : degraded ? (
        <div className="text-[11px] bg-amber-100 border-2 border-black rounded-lg p-2">Live catalog unavailable — Default will be used. Add an OpenRouter key or set OPENROUTER_API_KEY.</div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          <Slot slot="image" icon={<ImageIcon className="w-4 h-4" />} label="Image" models={imageModels} freeModel={freeImage} selectedId={sel.imageModel} />
          <Slot slot="text" icon={<TypeIcon className="w-4 h-4" />} label="Text" models={textModels} freeModel={freeText} selectedId={sel.textModel} />
        </div>
      )}
    </div>
  );
};
