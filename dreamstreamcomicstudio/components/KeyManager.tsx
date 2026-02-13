import React, { useEffect, useMemo, useState } from 'react';
import { IMAGE_MODELS } from '../services/imageModels';
import { TEXT_MODELS, isTextModelAllowedForPlan } from '../services/modelPolicy';
import { getAllModelKeys, setModelSpecificKey, deleteModelKey } from '../services/appSettings';
import { Button } from './Button';
import { Trash2, Edit2, Save, Key, CheckCircle2, Lock } from 'lucide-react';
import { isImageModelAllowedForPlan } from '../services/imageModels';
import { getBillingSummary } from '../services/billing';
import { getPlanTierFromBillingSummary } from '../services/modelEntitlements';

interface KeyManagerProps {
  planTier?: string;
}

type ModelOption = {
  id: string;
  label: string;
  provider: 'gemini' | 'flux';
  allowed: boolean;
};

export const KeyManager: React.FC<KeyManagerProps> = ({ planTier }) => {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [effectivePlanTier, setEffectivePlanTier] = useState<string>(planTier || 'free');
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [inputKey, setInputKey] = useState('');

  useEffect(() => {
    setKeys(getAllModelKeys());
  }, []);

  useEffect(() => {
    let active = true;
    if (planTier) {
      setEffectivePlanTier(planTier);
      return () => {
        active = false;
      };
    }

    const loadPlan = async () => {
      try {
        const summary = await getBillingSummary();
        if (!active) return;
        setEffectivePlanTier(getPlanTierFromBillingSummary(summary));
      } catch {
        if (!active) return;
        setEffectivePlanTier('free');
      }
    };

    void loadPlan();
    return () => {
      active = false;
    };
  }, [planTier]);

  const availableModels = useMemo<ModelOption[]>(() => {
    const imageOptions = IMAGE_MODELS.map((model) => ({
      id: model.id,
      label: model.label,
      provider: model.provider,
      allowed: isImageModelAllowedForPlan(model.id, effectivePlanTier)
    } as ModelOption));

    const textOptions = TEXT_MODELS.map((model) => ({
      id: model.id,
      label: `${model.label} (Text)`,
      provider: 'gemini' as const,
      allowed: isTextModelAllowedForPlan(model.id, effectivePlanTier)
    }));

    return [...imageOptions, ...textOptions];
  }, [effectivePlanTier]);

  useEffect(() => {
    if (!availableModels.length) return;
    const selected = availableModels.find((model) => model.id === selectedModelId);
    if (selected) {
      if (!selected.allowed) {
        const fallback = availableModels.find((model) => model.allowed);
        if (fallback) {
          setSelectedModelId(fallback.id);
          setInputKey('');
        }
      }
      return;
    }
    const fallback = availableModels.find((model) => model.allowed) || availableModels[0];
    if (fallback) {
      setSelectedModelId(fallback.id);
    }
  }, [availableModels, selectedModelId]);

  const handleSave = () => {
    if (!inputKey.trim()) return;
    const selected = availableModels.find((model) => model.id === selectedModelId);
    if (!selected || !selected.allowed) return;

    setModelSpecificKey(selectedModelId, inputKey.trim());
    setKeys(getAllModelKeys());
    setInputKey('');
  };

  const handleDelete = (modelId: string) => {
    if (!confirm('Are you sure you want to delete this key?')) return;
    deleteModelKey(modelId);
    setKeys(getAllModelKeys());
  };

  const handleEdit = (modelId: string) => {
    const model = availableModels.find((entry) => entry.id === modelId);
    if (!model || !model.allowed) return;
    setSelectedModelId(modelId);
    setInputKey(keys[modelId] || '');
  };

  const getModelLabel = (id: string) => {
    return availableModels.find((model) => model.id === id)?.label || id;
  };

  const selectedModel = availableModels.find((model) => model.id === selectedModelId);
  const selectedProvider = selectedModel?.provider || (selectedModelId.includes('flux') ? 'flux' : 'gemini');
  const selectedBlockedByPlan = selectedModel ? !selectedModel.allowed : false;

  return (
    <div className="bg-slate-50 border-2 border-black rounded-xl p-6 space-y-6">
      <h3 className="font-display text-xl">API Key Configuration</h3>

      <div className="bg-white border-2 border-black rounded-lg p-4 space-y-4">
        <div className="space-y-2">
          <label className="text-xs font-bold uppercase">Select Model</label>
          <select
            value={selectedModelId}
            onChange={(e) => {
              setSelectedModelId(e.target.value);
              setInputKey('');
            }}
            className="w-full border-2 border-black rounded-lg px-3 py-2 text-sm bg-white"
          >
            {availableModels.map((model) => (
              <option key={model.id} value={model.id} disabled={!model.allowed}>
                {model.label}{model.allowed ? '' : ' (Pro only)'}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-bold uppercase">Enter API Key</label>
          <div className="relative">
            <Key className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="password"
              value={inputKey}
              onChange={(e) => setInputKey(e.target.value)}
              placeholder={`Key for ${selectedModel?.label || selectedModelId}`}
              className="w-full border-2 border-black rounded-lg pl-10 pr-3 py-2 text-sm font-mono"
              disabled={selectedBlockedByPlan}
            />
          </div>
          <p className="text-[10px] text-slate-500">
            {selectedProvider === 'flux'
              ? 'Requires Pixazo Flux key for Flux models.'
              : 'Requires Google AI Studio Gemini key (starts with AI...).'}
          </p>
          {selectedBlockedByPlan && (
            <p className="text-[11px] text-amber-700 font-semibold flex items-center gap-1">
              <Lock className="w-3 h-3" /> Upgrade to Pro to configure this model key.
            </p>
          )}
        </div>

        <div className="flex justify-end">
          <Button size="sm" onClick={handleSave} icon={<Save size={14} />} disabled={!inputKey || selectedBlockedByPlan}>
            {keys[selectedModelId] ? 'Update Key' : 'Save Key'}
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-bold uppercase text-slate-500">Configured Keys</h4>
        {Object.keys(keys).length === 0 && (
          <div className="text-sm text-slate-400 italic">No custom keys configured. Using system defaults.</div>
        )}
        {Object.entries(keys).map(([modelId, key]) => {
          const isAllowed = availableModels.find((model) => model.id === modelId)?.allowed ?? true;
          return (
            <div key={modelId} className="flex items-center justify-between bg-white border-2 border-black rounded-lg p-3">
              <div>
                <div className="text-sm font-bold flex items-center gap-2">
                  {getModelLabel(modelId)}
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                  {!isAllowed && <Lock className="w-4 h-4 text-amber-600" />}
                </div>
                <div className="text-[10px] font-mono text-slate-500 mt-1">
                  {key.slice(0, 4)}••••••••{key.slice(-4)}
                </div>
                {!isAllowed && (
                  <div className="text-[10px] font-semibold text-amber-700 mt-1">Locked on current plan tier.</div>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleEdit(modelId)}
                  className="p-2 hover:bg-slate-100 rounded text-slate-600 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Edit"
                  disabled={!isAllowed}
                >
                  <Edit2 size={14} />
                </button>
                <button
                  onClick={() => handleDelete(modelId)}
                  className="p-2 hover:bg-red-50 rounded text-red-500"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
