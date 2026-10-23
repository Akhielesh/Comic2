import React, { useState } from 'react';
import { AlertTriangle, Gauge, X } from 'lucide-react';
import {
  dismissThreshold,
  formatPctLeft,
  highestCrossedThreshold,
  isThresholdDismissed,
  patchBillingPrefs,
  resetsLabel,
  showsUsageMeter,
  USAGE_EXHAUSTED_COPY
} from '../../services/usageAllowance';
import { useUsageAllowance } from '../usage/useUsageAllowance';

// Slim, dismissible "usage left" alert across the top of the chat shell (P1-LIMITS). Appears when
// the user's DreamStream usage crosses 30/70/90/100% (info → warn → rose). At 100% it is the
// honest hard stop: nothing more is spent; ask for a top-up or add your own key — and, with a
// personal key on file and mode 'ask', it becomes the consent prompt to continue on that key.
// Percent only (never dollars). Dismissals are remembered per threshold (and per period for
// monthly usage). Hidden for admins/exempt accounts and while the backend can't answer.
// Refreshed on mount and window focus — never polled on a timer.

// Deep link into Settings → API keys (App.tsx restores ?view=settings&tab=settings).
const openApiSettings = () => {
  try {
    window.location.assign('/?view=settings&tab=settings');
  } catch {
    /* navigation unavailable */
  }
};

export const AllowanceBanner: React.FC = () => {
  // Render from the shared store so settings-panel changes (mode/toggle) reflect here
  // immediately — e.g. the consent CTA hides the moment the mode stops being 'ask'.
  const status = useUsageAllowance();
  const [saving, setSaving] = useState(false);
  const [, bump] = useState(0); // re-render after a localStorage dismissal

  // Nothing to alert about while the meter is off / not governed / platform usage switched off.
  if (!showsUsageMeter(status) || !status.usePlatformAllowance) return null;
  const threshold = highestCrossedThreshold(status);
  if (!threshold || isThresholdDismissed(threshold, status.resetsAt)) return null;

  const tone = threshold >= 100 ? 'rose' : threshold >= 90 ? 'warn' : 'info';
  const reset = resetsLabel(status.resetsAt);
  const showConsent = threshold >= 100 && status.byokAvailable && status.byokFallbackMode === 'ask';

  const dismiss = () => {
    dismissThreshold(threshold, status.resetsAt);
    bump((n) => n + 1);
  };

  const consent = async () => {
    if (saving) return;
    setSaving(true);
    // patchBillingPrefs publishes to the shared store, updating this banner AND the panel.
    const next = await patchBillingPrefs({ byokFallbackMode: 'auto' });
    if (next) dismiss(); // the user acted on this threshold — don't keep nagging
    setSaving(false);
  };

  const toneClasses =
    tone === 'rose'
      ? 'border-rose-500/40 bg-rose-500/10'
      : tone === 'warn'
        ? 'border-amber-500/40 bg-amber-500/10'
        : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)]';

  const left = formatPctLeft(status.pctLeft);
  const units = status.friendlyUnits?.label;

  return (
    <div
      role="status"
      className={`flex items-center gap-2.5 border-b px-3 py-1.5 text-[12px] text-[var(--ds-ink)] backdrop-blur-md sm:px-4 ${toneClasses}`}
    >
      {tone === 'info' ? (
        <Gauge className="h-3.5 w-3.5 shrink-0 text-[var(--ds-accent)]" />
      ) : (
        <AlertTriangle className={`h-3.5 w-3.5 shrink-0 ${tone === 'rose' ? 'text-rose-500' : 'text-amber-500'}`} />
      )}

      <span className="min-w-0 flex-1 truncate" title={threshold >= 100 && !showConsent ? USAGE_EXHAUSTED_COPY : undefined}>
        {showConsent ? (
          <>
            <span className="font-semibold">You've used all of your DreamStream usage.</span> Continue with your own key?{' '}
            <span className="text-[var(--ds-muted)]">Your key's own limits still apply.</span>
          </>
        ) : threshold >= 100 ? (
          <>
            <span className="font-semibold">You've used all of your DreamStream usage.</span>{' '}
            <span className="text-[var(--ds-muted)]">
              {status.byokFallbackMode === 'auto' && status.byokAvailable
                ? 'Generation now runs on your own key.'
                : reset
                  ? `Nothing more is spent — it comes back ${reset}, or add your own key.`
                  : 'Nothing more is spent — ask us for a top-up, or add your own key.'}
            </span>
          </>
        ) : (
          <>
            <span className="font-semibold">{left} of your DreamStream usage left.</span>
            {units && <span className="text-[var(--ds-muted)]"> · {units}</span>}
          </>
        )}
      </span>

      {showConsent && (
        <button
          onClick={() => void consent()}
          disabled={saving}
          className="shrink-0 rounded-full bg-rose-600 px-2.5 py-0.5 text-[11px] font-semibold text-white transition-all duration-200 hover:bg-rose-700 disabled:opacity-50 coarse:min-h-11 coarse:px-3"
        >
          Continue with my key
        </button>
      )}
      <button
        onClick={openApiSettings}
        className="hidden shrink-0 text-[11px] font-medium text-[var(--ds-muted)] underline-offset-2 transition-all duration-200 hover:text-[var(--ds-ink)] hover:underline sm:inline"
      >
        API keys
      </button>
      <button
        onClick={dismiss}
        aria-label="Dismiss usage alert"
        className="inline-flex shrink-0 items-center justify-center rounded-md p-0.5 text-[var(--ds-muted)] transition-all duration-200 hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] coarse:h-11 coarse:w-11"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};
