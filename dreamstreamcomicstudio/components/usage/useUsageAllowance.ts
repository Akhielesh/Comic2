// The user's usage left, kept fresh WITHOUT a timer (P1-LIMITS): read on mount, when the window
// regains focus, and shortly after something was spent (`refreshKey` changes — e.g. a comic's
// spend total). The backend container sleeps when idle; nothing here may poll it.

import { useEffect, useRef, useState } from 'react';
import {
  getLastAllowanceStatus,
  refreshAllowanceStatus,
  subscribeAllowanceStatus,
  type AllowanceStatus
} from '../../services/usageAllowance';

const FOCUS_MIN_AGE_MS = 60_000;
const AFTER_SPEND_DELAY_MS = 1_500;

export const useUsageAllowance = (opts: { refreshKey?: unknown } = {}): AllowanceStatus | null => {
  const [status, setStatus] = useState<AllowanceStatus | null>(() => getLastAllowanceStatus());

  useEffect(() => {
    const unsubscribe = subscribeAllowanceStatus(setStatus);
    void refreshAllowanceStatus();
    const onFocus = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refreshAllowanceStatus(FOCUS_MIN_AGE_MS);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  // Something was spent: re-read once, shortly after (one debounced request, not a poll).
  const seen = useRef(opts.refreshKey);
  useEffect(() => {
    if (Object.is(seen.current, opts.refreshKey)) return;
    seen.current = opts.refreshKey;
    const t = setTimeout(() => void refreshAllowanceStatus(0), AFTER_SPEND_DELAY_MS);
    return () => clearTimeout(t);
  }, [opts.refreshKey]);

  return status;
};
