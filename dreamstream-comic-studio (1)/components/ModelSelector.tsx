import React, { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { ImageProviderId } from "../types";
import { getImageProvider, getLockedImageProvider, setImageProvider } from "../services/appSettings";
import { IMAGE_MODELS } from "../services/imageModels";

interface ModelSelectorProps {
  className?: string;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({ className = "" }) => {
  const [provider, setProvider] = useState<ImageProviderId>(getImageProvider());
  const locked = getLockedImageProvider();

  useEffect(() => {
    setProvider(getImageProvider());
  }, []);

  const handleSelect = (next: ImageProviderId) => {
    const effective = setImageProvider(next);
    setProvider(effective);
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
          const isSelected = provider === model.provider;
          const isDisabled = !!locked && locked !== model.provider;
          return (
            <button
              key={model.id}
              onClick={() => handleSelect(model.provider)}
              disabled={isDisabled}
              className={`w-full flex items-center justify-between border-2 rounded-lg px-3 py-2 text-xs font-bold transition-colors ${
                isSelected ? "bg-brand-blue text-white border-black" : "bg-slate-50 text-slate-700 border-black"
              } ${isDisabled ? "opacity-50 cursor-not-allowed" : "hover:bg-brand-yellow/60"}`}
            >
              <span>{model.label}</span>
              {isSelected && <span className="text-[10px] uppercase">Active</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-2 text-[11px] text-slate-500">
        {locked
          ? "Model selection is locked to Flux (Pixazo) for now."
          : "You can switch models at any time."}
      </div>
    </div>
  );
};
