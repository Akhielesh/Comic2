// Run studio actions from a card while tracking which controls are in flight, so a
// clicked button shows a spinner and can't be double-fired. Different keys may run at the
// same time (retrying one page while another page's retry is still drawing).
// A failing action stops the rest of its sequence (never "approve failed, draw anyway") and
// never surfaces as an unhandled rejection — the controller already shows the error calmly.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudioAction } from '../../../../shared/comic/ops';

export const useAction = (act: (action: StudioAction) => Promise<void> | void) => {
  const pendingRef = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (key: string, ...actions: StudioAction[]): Promise<boolean> => {
      if (pendingRef.current.has(key)) return false;
      pendingRef.current.add(key);
      setPending(new Set(pendingRef.current));
      try {
        // Sequential on purpose (e.g. approve the plan, then draw it).
        for (const action of actions) await act(action);
        return true;
      } catch (err) {
        console.warn('[comicstudio] card action failed', err);
        return false;
      } finally {
        pendingRef.current.delete(key);
        if (mounted.current) setPending(new Set(pendingRef.current));
      }
    },
    [act]
  );

  const isPending = useCallback((key: string) => pending.has(key), [pending]);

  return { run, isPending, anyPending: pending.size > 0 };
};
