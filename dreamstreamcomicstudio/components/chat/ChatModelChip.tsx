import React, { useEffect, useState } from 'react';
import { Cpu, ChevronDown, KeyRound } from 'lucide-react';
import { getProviderDef } from '../../shared/providers';
import { ProviderLogo, hasProviderLogo } from '../providerLogos';
import { sourceShortLabel } from '../../services/modelCatalog';
import { getActiveKey, usageFraction, usageColor, isModelSourceUsable, API_KEYS_CHANGED, type ApiKeyProvider } from '../../services/apiKeys';
import { CONTROL_BTN, INK, ACCENT_TEXT } from './studioDesign';

interface ChatModelChipProps {
  modelId: string | null;
  modelName?: string | null;
  source?: string | null;
  autoMode?: boolean;
  lockedSource?: string | null;
  onClick: () => void;
}

/**
 * The chat header's model button — but instead of just the model name it surfaces, at a glance,
 * the three things a user actually needs to trust before they send a message:
 *   • SOURCE  — the provider logo + short label, so "which service is answering" is never a mystery.
 *   • KEY     — an explicit "no key" state when a pinned model's provider has no usable key
 *               (instead of silently failing at send time).
 *   • USAGE   — the active key's spend vs. its monthly limit, so you see how much room is left.
 * Stays live by re-reading the local key store on API_KEYS_CHANGED, window focus, and a slow tick.
 */
export const ChatModelChip: React.FC<ChatModelChipProps> = ({ modelId, modelName, source, autoMode, lockedSource, onClick }) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener(API_KEYS_CHANGED, bump);
    window.addEventListener('focus', bump);
    const id = window.setInterval(bump, 8000);
    return () => {
      window.removeEventListener(API_KEYS_CHANGED, bump);
      window.removeEventListener('focus', bump);
      window.clearInterval(id);
    };
  }, []);

  const auto = Boolean(autoMode) || !modelId;
  const name = auto ? 'Auto' : modelName || modelId || 'Auto';
  const effSource = auto ? lockedSource || null : source || null;
  const def = effSource ? getProviderDef(effSource) : null;

  let status: React.ReactNode = null;
  let titleHint = 'Switch model';
  if (auto) {
    status = <span className="text-[var(--ds-muted)]">{lockedSource ? `Auto · ${sourceShortLabel(lockedSource)}` : 'Auto · best per message'}</span>;
  } else if (effSource) {
    const short = sourceShortLabel(effSource);
    const provider = effSource as ApiKeyProvider;
    const platform = Boolean(def?.platformServed);
    const usable = isModelSourceUsable(effSource);
    if (!usable) {
      titleHint = `No ${def?.label || short} key — add one in Settings → API Configuration to use this model`;
      status = (
        <span className="flex items-center gap-0.5 text-amber-600 font-semibold">
          <KeyRound className="w-2.5 h-2.5 shrink-0" /> {short} · no key
        </span>
      );
    } else {
      const key = getActiveKey(provider);
      const hasLimit = Boolean(key && key.limitUsd && key.limitUsd > 0);
      if (key && hasLimit) {
        const frac = usageFraction(key);
        const pct = Math.round(frac * 100);
        titleHint = `${def?.label || short}: $${key.usedUsd.toFixed(2)} / $${key.limitUsd!.toFixed(2)} used this month`;
        status = (
          <span className="flex items-center gap-1 text-[var(--ds-muted)]">
            {short} · <span className={`tabular-nums font-semibold ${usageColor(frac)}`}>{pct}%{frac >= 1 ? ' · blocked' : ''}</span>
          </span>
        );
      } else {
        status = <span className="text-[var(--ds-muted)]">{short}{platform ? ' · platform' : ''}</span>;
      }
    }
  }

  return (
    <button onClick={onClick} className={`flex items-center gap-2 ${CONTROL_BTN} px-3 py-1.5 min-w-0`} title={titleHint}>
      {effSource && hasProviderLogo(effSource) ? (
        <ProviderLogo provider={effSource} className="w-4 h-4 shrink-0" style={{ color: def?.accent }} />
      ) : (
        <Cpu className={`w-4 h-4 shrink-0 ${ACCENT_TEXT}`} />
      )}
      <span className="flex flex-col items-start leading-tight min-w-0">
        <span className={`font-semibold text-sm truncate max-w-[120px] sm:max-w-[170px] ${INK}`}>{name}</span>
        {status && <span className="text-[10px] truncate max-w-[120px] sm:max-w-[170px]">{status}</span>}
      </span>
      <ChevronDown className="w-4 h-4 shrink-0 text-[var(--ds-muted)]" />
    </button>
  );
};
