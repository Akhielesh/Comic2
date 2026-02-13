import React, { useEffect, useMemo, useState } from 'react';
import { Lock } from 'lucide-react';
import { ImageProviderId } from '../types';
import {
  getImageProvider,
  getLockedImageProvider,
  setImageProvider,
  getImageModelId,
  setImageModelId
} from '../services/appSettings';
import {
  IMAGE_MODELS,
  getDefaultImageModelForPlan,
  isImageModelAllowedForPlan
} from '../services/imageModels';
import { getBillingSummary } from '../services/billing';
import { getPlanTierFromBillingSummary } from '../services/modelEntitlements';

interface ModelSelectorProps {
  className?: string;
  planTier?: string;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({ className = '', planTier }) => {
  const [provider, setProvider] = useState<ImageProviderId>(getImageProvider());
  const [modelId, setModelId] = useState<string | null>(getImageModelId());
  const [effectivePlanTier, setEffectivePlanTier] = useState<string>(planTier || 'free');
  const locked = getLockedImageProvider();

  useEffect(() => {
    setProvider(getImageProvider());
    setModelId(getImageModelId());
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

  useEffect(() => {
    const storedModelId = getImageModelId();
    if (storedModelId && !isImageModelAllowedForPlan(storedModelId, effectivePlanTier)) {
      const fallback = getDefaultImageModelForPlan(effectivePlanTier);
      const fallbackProvider = setImageProvider(fallback.provider);
      setImageModelId(fallback.id);
      setProvider(fallbackProvider);
      setModelId(fallback.id);
    }
  }, [effectivePlanTier]);

  const allowedModelIds = useMemo(() => {
    const allowed = new Set<string>();
    IMAGE_MODELS.forEach((model) => {
      if (isImageModelAllowedForPlan(model.id, effectivePlanTier)) {
        allowed.add(model.id);
      }
    });
    return allowed;
  }, [effectivePlanTier]);

  const handleSelect = (model: { provider: ImageProviderId; id: string }) => {
    if (!allowedModelIds.has(model.id)) return;
    const effectiveProvider = setImageProvider(model.provider);
    setImageModelId(model.id);
    setProvider(effectiveProvider);
    setModelId(model.id);
  };

  return (
    <div className={`bg-white border-2 border-black rounded-lg p-4 ${className}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-bold uppercase">Image Model</div>
        {locked && (
          <span className="text-[10px] font-bold uppercase bg-brand-yellow px-2 py-0.5 rounded border border-black flex items-center gap-1">
            <Lock className="w-3 h-3" /> Locked
          </span>
        )}
      </div>
      <div className="space-y-2">
        {IMAGE_MODELS.map((model) => {
          const isProviderActive = provider === model.provider;
          const isModelActive = modelId === model.id;
          const isDefaultActive = !modelId && isProviderActive && IMAGE_MODELS.find((entry) => entry.provider === provider)?.id === model.id;
          const isSelected = isModelActive || isDefaultActive;
          const blockedByPlan = !allowedModelIds.has(model.id);
          const blockedByProviderLock = !!locked && locked !== model.provider;
          const isDisabled = blockedByProviderLock || blockedByPlan;

          return (
            <button
              key={model.id}
              onClick={() => handleSelect(model)}
              disabled={isDisabled}
              className={`w-full flex items-center justify-between border-2 rounded-lg px-3 py-2 text-xs font-bold transition-colors ${isSelected ? 'bg-brand-blue text-white border-black' : 'bg-slate-50 text-slate-700 border-black'} ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-brand-yellow/60'}`}
            >
              <span>{model.label}</span>
              {blockedByPlan && <span className="text-[10px] uppercase">Pro</span>}
              {isSelected && !blockedByPlan && <span className="text-[10px] uppercase">Active</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-2 text-[11px] text-slate-500">
        {locked
          ? 'Model selection is locked to Flux (Pixazo) for now.'
          : 'Free plan includes Flux and Nano Banana. Pro unlocks Nano Banana Pro.'}
      </div>
    </div>
  );
};
