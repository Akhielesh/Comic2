import React, { useEffect, useState } from 'react';
import { Zap, KeyRound } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getActiveKey, usageFraction, PROVIDER_META, ALL_PROVIDERS, type ApiKeyProvider } from '../services/apiKeys';
import {
  getSelectedImageModel,
  getSelectedTextModel,
  getSelectedImageSource,
  getSelectedTextSource,
  MODEL_SELECTION_CHANGED
} from '../services/modelSelection';

interface TokenAvailabilityPillProps {
  className?: string;
}

// Provider priority for the "headline" key shown in the pill.
const PROVIDER_PRIORITY: ApiKeyProvider[] = ['openrouter', 'nvidia', 'gemini', 'pixazo'];

const usageColor = (frac: number) =>
  frac >= 1 ? 'text-brand-red' : frac >= 0.8 ? 'text-amber-600' : 'text-slate-600';

/**
 * Header pill showing the ACTIVE API key's usage instead of the legacy CT credits.
 * Hover reveals provider, key, spend vs. limit (%), and the models in use.
 * (Per ADR 0003 the CT credit system is hidden from the UI.)
 */
export const TokenAvailabilityPill: React.FC<TokenAvailabilityPillProps> = ({ className = '' }) => {
  const { user } = useAuth();
  // Re-read the local key store periodically so usage stays fresh after generations.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 5000);
    const onChange = () => setTick((t) => t + 1);
    window.addEventListener('focus', onChange);
    window.addEventListener(MODEL_SELECTION_CHANGED, onChange);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onChange);
      window.removeEventListener(MODEL_SELECTION_CHANGED, onChange);
    };
  }, []);

  if (!user) return null;

  const active = PROVIDER_PRIORITY.map((p) => getActiveKey(p)).find(Boolean) || null;

  if (!active) {
    return (
      <div className={`inline-flex items-center gap-1.5 rounded-full border-2 border-black bg-white px-3 py-1 text-[11px] font-bold text-slate-500 shadow-sm ${className}`}>
        <KeyRound size={13} /> No API key
      </div>
    );
  }

  const frac = usageFraction(active);
  const pct = Math.round(frac * 100);
  const hasLimit = !!active.limitUsd && active.limitUsd > 0;
  const imageModel = getSelectedImageModel() || 'Auto';
  const textModel = getSelectedTextModel() || 'Auto';
  const imageSource = getSelectedImageSource();
  const textSource = getSelectedTextSource();
  // Every active source key, so a mixed setup (e.g. text via NVIDIA, image via OpenRouter)
  // shows each source's own usage/limit.
  const activeSourceKeys = ALL_PROVIDERS
    .map((provider) => ({ provider, key: getActiveKey(provider) }))
    .filter((entry): entry is { provider: ApiKeyProvider; key: NonNullable<typeof entry.key> } => Boolean(entry.key));

  return (
    <div className={`relative group ${className}`}>
      <div className="inline-flex items-center gap-2 rounded-full border-2 border-black bg-white px-3 py-1 text-[11px] font-bold text-slate-900 shadow-sm cursor-default">
        <Zap size={13} className="text-brand-yellow fill-brand-yellow" />
        <span className="max-w-[8rem] truncate">{active.label}</span>
        <span className={`hidden md:inline ${hasLimit ? usageColor(frac) : 'text-slate-500'}`}>
          {hasLimit ? `${pct}%` : `$${active.usedUsd.toFixed(2)}`}
        </span>
      </div>

      {/* Hover detail card */}
      <div className="absolute right-0 mt-2 w-72 z-50 hidden group-hover:block">
        <div className="bg-white border-2 border-black rounded-xl shadow-comic p-3 text-left">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase text-slate-500">{PROVIDER_META[active.provider].label}</span>
            <span className="text-[10px] font-bold uppercase bg-brand-blue text-white px-1.5 py-0.5 rounded border border-black">Active</span>
          </div>
          <div className="font-bold text-sm mt-0.5 truncate">{active.label}</div>

          <div className="mt-2">
            {hasLimit ? (
              <>
                <div className="h-2 w-full bg-slate-200 rounded-full overflow-hidden border border-black/20">
                  <div
                    className={frac >= 1 ? 'bg-brand-red h-full' : frac >= 0.8 ? 'bg-brand-yellow h-full' : 'bg-green-500 h-full'}
                    style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
                  />
                </div>
                <div className="flex justify-between text-[11px] text-slate-600 mt-1">
                  <span>${active.usedUsd.toFixed(2)} / ${active.limitUsd!.toFixed(2)} this month</span>
                  <span className={usageColor(frac)}>{pct}%{frac >= 1 ? ' · blocked' : ''}</span>
                </div>
              </>
            ) : (
              <div className="text-[11px] text-slate-600">${active.usedUsd.toFixed(2)} used this month · no limit set</div>
            )}
          </div>

          {activeSourceKeys.length > 1 && (
            <div className="mt-2 pt-2 border-t border-dashed border-slate-200 text-[11px] text-slate-600 space-y-1">
              <div className="text-[10px] font-bold uppercase text-slate-400">Per-source usage</div>
              {activeSourceKeys.map(({ provider, key }) => {
                const f = usageFraction(key);
                const lim = !!key.limitUsd && key.limitUsd > 0;
                return (
                  <div key={provider} className="flex justify-between gap-2">
                    <span className="truncate">{PROVIDER_META[provider].label}</span>
                    <span className={lim ? usageColor(f) : 'text-slate-500'}>
                      {lim ? `$${key.usedUsd.toFixed(2)} / $${key.limitUsd!.toFixed(2)}` : `$${key.usedUsd.toFixed(2)}`}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-2 pt-2 border-t border-dashed border-slate-200 text-[11px] text-slate-600 space-y-0.5">
            <div className="flex justify-between gap-2"><span className="text-slate-400">Image model</span><span className="font-mono truncate">{imageModel}{imageSource ? ` · ${imageSource}` : ''}</span></div>
            <div className="flex justify-between gap-2"><span className="text-slate-400">Text model</span><span className="font-mono truncate">{textModel}{textSource ? ` · ${textSource}` : ''}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
};
