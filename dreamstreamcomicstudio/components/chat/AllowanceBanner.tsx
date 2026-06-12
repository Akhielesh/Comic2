import React, { useEffect, useState } from 'react';
import { AlertTriangle, Gauge, X } from 'lucide-react';
import {
  dismissThreshold,
  fetchAllowanceStatus,
  highestCrossedThreshold,
  isThresholdDismissed,
  patchBillingPrefs,
  resetsLabel,
  type AllowanceStatus
} from '../../services/usageAllowance';

// Slim, dismissible allowance alert across the top of the chat shell. Appears when
// monthly platform-allowance usage crosses 30/70/90/100% (info → warn → rose), and at
// 100% (mode 'ask' + a personal key on file) it becomes the consent prompt to fall
// back to the user's own key. Dismissals are remembered in localStorage PER threshold
// and per reset period, so each newly-crossed threshold re-shows exactly once.
// Hides entirely while the /api/usage/allowance backend doesn't exist or errors.

const POLL_MS = 5 * 60_000;

// Deep link into Settings → API & Models (App.tsx restores ?view=settings&tab=settings).
const openApiSettings = () => {
  try {
    window.location.assign('/?view=settings&tab=settings');
  } catch {
    /* navigation unavailable */
  }
};

export const AllowanceBanner: React.FC = () => {
  const [status, setStatus] = useState<AllowanceStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [, bump] = useState(0); // re-render after a localStorage dismissal

  useEffect(() => {
    let on = true;
    const load = async () => {
      const next = await fetchAllowanceStatus();
      if (on && next) setStatus(next); // keep last good status on a transient failure
    };
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => {
      on = false;
      clearInterval(id);
    };
  }, []);

  // Nothing to alert about while the feature is off / endpoint missing / allowance unused.
  if (!status || !status.enabled || !status.usePlatformAllowance) return null;
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
    const next = await patchBillingPrefs({ byokFallbackMode: 'auto' });
    if (next) {
      setStatus(next);
      dismiss(); // the user acted on this threshold — don't keep nagging
    }
    setSaving(false);
  };

  const toneClasses =
    tone === 'rose'
      ? 'border-rose-500/40 bg-rose-500/10'
      : tone === 'warn'
        ? 'border-amber-500/40 bg-amber-500/10'
        : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)]';

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

      <span className="min-w-0 flex-1 truncate">
        {showConsent ? (
          <>
            <span className="font-semibold">You've used 100% of this month's allowance.</span> Continue with your own key?{' '}
            <span className="text-[var(--ds-muted)]">Your key's own limits still apply.</span>
          </>
        ) : threshold >= 100 ? (
          <>
            <span className="font-semibold">You've used 100% of this month's DreamStream allowance.</span>{' '}
            <span className="text-[var(--ds-muted)]">
              {status.byokFallbackMode === 'auto' && status.byokAvailable
                ? 'Generation now runs on your own key'
                : 'Platform generation is paused'}
              {reset ? ` · resets ${reset}` : ''}
            </span>
          </>
        ) : (
          <>
            <span className="font-semibold">You've used {threshold}% of this month's DreamStream allowance.</span>
            {reset && <span className="text-[var(--ds-muted)]"> · resets {reset}</span>}
          </>
        )}
      </span>

      {showConsent && (
        <button
          onClick={() => void consent()}
          disabled={saving}
          className="shrink-0 rounded-full bg-rose-600 px-2.5 py-0.5 text-[11px] font-semibold text-white transition-all duration-200 hover:bg-rose-700 disabled:opacity-50"
        >
          Continue with my key
        </button>
      )}
      <button
        onClick={openApiSettings}
        className="hidden shrink-0 text-[11px] font-medium text-[var(--ds-muted)] underline-offset-2 transition-all duration-200 hover:text-[var(--ds-ink)] hover:underline sm:inline"
      >
        API settings
      </button>
      <button
        onClick={dismiss}
        aria-label="Dismiss allowance alert"
        className="shrink-0 rounded-md p-0.5 text-[var(--ds-muted)] transition-all duration-200 hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};
