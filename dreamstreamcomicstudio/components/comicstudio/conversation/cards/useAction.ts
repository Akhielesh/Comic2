// Run studio actions from a card while tracking which controls are in flight, so a
// clicked button shows a spinner and can't be double-fired. Different keys may run at the
// same time (retrying one page while another page's retry is still drawing).
//
// Sequences ("approve the plan, then draw it"; "retry the failed pages, sheets and cover") stop
// at the first step that did not go through, so a second spend never runs behind a refusal and
// a second approval card never replaces the first:
//   - a step that THROWS stops the sequence (never an unhandled rejection);
//   - a step that RESOLVES to an outcome object with `ok: false`, `aborted: true` or
//     `gated: true` stops it (forward-compatible: today's controller `act` resolves void —
//     see the wave-2 note on useStudio.act returning its StreamOutcome);
//   - the optional `guard` is armed when a sequence starts and checked between steps, after
//     React has committed the previous step's stream: `useStudioSequenceGuard` stops when a NEW
//     approval opened or a new error was reported while the step ran.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComicDoc } from '../../../../shared/comic/doc';
import type { StudioAction } from '../../../../shared/comic/ops';

/** A step result that means "don't run the rest": it failed, was cancelled, or opened a spend gate. */
export const stopsSequence = (result: unknown): boolean => {
  if (!result || typeof result !== 'object') return false;
  const r = result as { ok?: unknown; gated?: unknown; aborted?: unknown };
  return r.ok === false || r.gated === true || r.aborted === true;
};

export interface UseActionOptions {
  /**
   * Called when a multi-step sequence starts; returns the check run between steps (true = stop).
   * Read live state through refs — the check runs after the previous step's stream finished.
   */
  guard?: () => () => boolean;
}

/** Let React commit what the previous step's stream dispatched before the guard reads it. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export const useAction = (act: (action: StudioAction) => Promise<unknown> | unknown, opts: UseActionOptions = {}) => {
  const pendingRef = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const mounted = useRef(true);
  const guardRef = useRef(opts.guard);
  guardRef.current = opts.guard;
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
        const check = actions.length > 1 ? guardRef.current?.() : undefined;
        // Sequential on purpose (e.g. approve the plan, then draw it).
        for (let i = 0; i < actions.length; i += 1) {
          const result = await act(actions[i]);
          if (i === actions.length - 1) break;
          if (stopsSequence(result)) return false;
          if (check) {
            await settle();
            if (check()) return false;
          }
        }
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

/** The open gate's id, if any. */
const openGateId = (doc: ComicDoc | null | undefined): string | null => (doc?.gate && doc.gate.status === 'open' ? doc.gate.id : null);

/**
 * The guard most card sequences want: stop when the step just run opened a NEW approval (the
 * user must answer it before anything else is spent) or reported a new error.
 */
export const useStudioSequenceGuard = (studio: { doc: ComicDoc | null; error: string | null }): (() => () => boolean) => {
  const live = useRef(studio);
  live.current = studio;
  return useCallback(() => {
    const gateBefore = openGateId(live.current.doc);
    const errorBefore = live.current.error;
    return () => {
      const now = live.current;
      const gate = openGateId(now.doc);
      if (gate && gate !== gateBefore) return true;
      return !!now.error && now.error !== errorBefore;
    };
  }, []);
};
