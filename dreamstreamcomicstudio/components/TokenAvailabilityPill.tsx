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
import { prettyModelLabel, sourceLabel } from '../services/modelCatalog';
import { isProviderEnabled, SOURCE_GOVERNANCE_CHANGED } from '../services/sourceGovernance';
import { getActiveModelInfo, onActiveModelChanged } from '../services/activeModelBeacon';

interface TokenAvailabilityPillProps {
  className?: string;
}

// Provider priority for the "headline" key shown in the pill.
const PROVIDER_PRIORITY: ApiKeyProvider[] = ['openrouter', 'nvidia', 'gemini', 'pixazo'];

const usageColor = (frac: number) =>
  frac >= 1 ? 'text-red-500' : frac >= 0.8 ? 'text-amber-500' : 'text-[var(--ds-muted)]';

/**
 * Header pill showing the ACTIVE API key's usage instead of the legacy CT credits.
 * Hover reveals provider, key, spend vs. limit (%), and the models in use.
 * (Per ADR 0003 the CT credit system is hidden from the UI.)
 *
 * Source-governance-synced: a provider turned OFF in Settings never headlines the
 * pill or appears in the per-source list, matching what generation can actually use.
 * Studio-aware: when a studio publishes its live model (activeModelBeacon — e.g.
 * Chat Studio's per-conversation pick), the hover shows that instead of implying the
 * comic-generation defaults apply everywhere.
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
    window.addEventListener(SOURCE_GOVERNANCE_CHANGED, onChange);
    const offBeacon = onActiveModelChanged(onChange);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onChange);
      window.removeEventListener(MODEL_SELECTION_CHANGED, onChange);
      window.removeEventListener(SOURCE_GOVERNANCE_CHANGED, onChange);
      offBeacon();
    };
  }, []);

  if (!user) return null;

  // Only providers the user has ENABLED in Settings count anywhere in this pill.
  const enabledProviders = ALL_PROVIDERS.filter(isProviderEnabled);

  const imageSource = getSelectedImageSource();
  const textSource = getSelectedTextSource();
  // The source(s) the user actually picked for generation lead the priority, so the
  // headline key reflects the source in use (e.g. NVIDIA) instead of defaulting to
  // OpenRouter just because an OpenRouter key also happens to exist.
  const preferred: ApiKeyProvider[] = [];
  for (const source of [textSource, imageSource]) {
    if (source && !preferred.includes(source) && enabledProviders.includes(source)) preferred.push(source);
  }
  const priority = [
    ...preferred,
    ...PROVIDER_PRIORITY.filter((p) => !preferred.includes(p) && enabledProviders.includes(p))
  ];
  const active = priority.map((p) => getActiveKey(p)).find(Boolean) || null;

  const pillShell =
    'inline-flex items-center gap-1.5 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface)] px-3 py-1 text-[11px] font-semibold shadow-sm';

  if (!active) {
    return (
      <div
        className={`${pillShell} text-[var(--ds-muted)] ${className}`}
        title={enabledProviders.length === 0 ? 'All AI sources are turned off in Settings → API Configuration' : 'Add an API key in Settings → API Configuration'}
      >
        <KeyRound size={13} /> {enabledProviders.length === 0 ? 'Sources off' : 'No API key'}
      </div>
    );
  }

  const frac = usageFraction(active);
  const pct = Math.round(frac * 100);
  const hasLimit = !!active.limitUsd && active.limitUsd > 0;
  const imageModelId = getSelectedImageModel();
  const textModelId = getSelectedTextModel();
  // What the CURRENT studio is really using (e.g. the chat's per-conversation model).
  const liveModel = getActiveModelInfo();
  // Every active source key, so a mixed setup (e.g. text via NVIDIA, image via OpenRouter)
  // shows each source's own usage/limit. Disabled sources are excluded by design.
  const activeSourceKeys = enabledProviders
    .map((provider) => ({ provider, key: getActiveKey(provider) }))
    .filter((entry): entry is { provider: ApiKeyProvider; key: NonNullable<typeof entry.key> } => Boolean(entry.key));

  const modelLine = (id: string | null, source: string | null) =>
    id
      ? `${prettyModelLabel(id)}${source ? ` · ${sourceLabel(source)}` : ''}`
      : 'Auto · picks the best per task';

  return (
    <div className={`relative group ${className}`}>
      <div className={`${pillShell} gap-2 text-[var(--ds-ink)] cursor-default`}>
        <Zap size={13} className="text-amber-400 fill-amber-400" />
        <span className="max-w-[8rem] truncate">{active.label}</span>
        <span className={`hidden md:inline tabular-nums ${hasLimit ? usageColor(frac) : 'text-[var(--ds-muted)]'}`}>
          {hasLimit ? `${pct}%` : `$${active.usedUsd.toFixed(2)}`}
        </span>
      </div>

      {/* Hover detail card */}
      <div className="absolute right-0 mt-2 w-72 z-50 hidden group-hover:block">
        <div className="rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] shadow-xl p-3 text-left">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ds-muted)]">{PROVIDER_META[active.provider].label}</span>
            <span className="text-[10px] font-bold uppercase bg-[#D97757]/10 text-[#D97757] px-1.5 py-0.5 rounded-full border border-[#D97757]/30">Active</span>
          </div>
          <div className="font-semibold text-sm mt-0.5 truncate text-[var(--ds-ink)]">{active.label}</div>

          <div className="mt-2">
            {hasLimit ? (
              <>
                <div className="h-1.5 w-full bg-[var(--ds-well)] rounded-full overflow-hidden">
                  <div
                    className={frac >= 1 ? 'bg-red-500 h-full' : frac >= 0.8 ? 'bg-amber-400 h-full' : 'bg-emerald-500 h-full'}
                    style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
                  />
                </div>
                <div className="flex justify-between text-[11px] text-[var(--ds-muted)] mt-1 tabular-nums">
                  <span>${active.usedUsd.toFixed(2)} / ${active.limitUsd!.toFixed(2)} this month</span>
                  <span className={usageColor(frac)}>{pct}%{frac >= 1 ? ' · blocked' : ''}</span>
                </div>
              </>
            ) : (
              <div className="text-[11px] text-[var(--ds-muted)] tabular-nums">${active.usedUsd.toFixed(2)} used this month · no limit set</div>
            )}
          </div>

          {activeSourceKeys.length > 1 && (
            <div className="mt-2 pt-2 border-t border-[var(--ds-hairline-soft)] text-[11px] text-[var(--ds-muted)] space-y-1">
              <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--ds-muted)]">Per-source usage</div>
              {activeSourceKeys.map(({ provider, key }) => {
                const f = usageFraction(key);
                const lim = !!key.limitUsd && key.limitUsd > 0;
                return (
                  <div key={provider} className="flex justify-between gap-2 tabular-nums">
                    <span className="truncate">{PROVIDER_META[provider].label}</span>
                    <span className={lim ? usageColor(f) : ''}>
                      {lim ? `$${key.usedUsd.toFixed(2)} / $${key.limitUsd!.toFixed(2)}` : `$${key.usedUsd.toFixed(2)}`}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {liveModel && (
            <div className="mt-2 pt-2 border-t border-[var(--ds-hairline-soft)] text-[11px] text-[var(--ds-muted)]">
              <div className="flex justify-between gap-2">
                <span>In use now{liveModel.surface === 'chat' ? ' (chat)' : liveModel.surface === 'code' ? ' (code)' : ''}</span>
                <span className="font-semibold text-[var(--ds-ink)] truncate">
                  {liveModel.label}
                  {liveModel.detail ? ` · ${liveModel.detail}` : ''}
                </span>
              </div>
            </div>
          )}

          <div className="mt-2 pt-2 border-t border-[var(--ds-hairline-soft)] text-[11px] text-[var(--ds-muted)] space-y-0.5">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--ds-muted)]">Generation defaults</div>
            <div className="flex justify-between gap-2"><span>Image</span><span className="truncate text-[var(--ds-ink)]">{modelLine(imageModelId, imageSource)}</span></div>
            <div className="flex justify-between gap-2"><span>Text</span><span className="truncate text-[var(--ds-ink)]">{modelLine(textModelId, textSource)}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
};
