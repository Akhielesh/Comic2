// In-process pilot runner for the Autopilot loop (no Redis/queue, no separate worker process).
// Opt-in via VENTURES_PILOT_INLINE — the API process itself ticks active ventures on a timer.
// Safe no-op unless BOTH VENTURES_ENABLED and VENTURES_PILOT_INLINE are true. Use the dedicated
// BullMQ worker (queue.ts/worker.ts) for real scale; this is for single-instance validation.

import {
  VENTURES_ENABLED,
  VENTURES_PILOT_INLINE,
  VENTURES_TICK_INTERVAL_MS,
  VENTURES_MAX_CONCURRENT_TICKS
} from '../config.js';
import { getKillSwitch } from './killSwitch.js';
import { listActiveVentures } from './controlPlane.js';
import { runVentureTick } from './tickRunner.js';

let started = false;
let cycling = false; // prevents overlapping cycles if a tick runs long

const cycle = async (): Promise<void> => {
  if (cycling || getKillSwitch()) return;
  cycling = true;
  try {
    const ventures = await listActiveVentures(VENTURES_MAX_CONCURRENT_TICKS);
    for (const v of ventures) {
      if (getKillSwitch()) break;
      try {
        await runVentureTick(v.userId, v.id);
      } catch (e) {
        console.error('[Ventures Inline] tick failed', { ventureId: v.id, error: (e as Error)?.message });
      }
    }
  } catch (e) {
    console.error('[Ventures Inline] cycle error', (e as Error)?.message);
  } finally {
    cycling = false;
  }
};

/** Start the in-process pilot loop. No-op unless VENTURES_ENABLED && VENTURES_PILOT_INLINE. */
export const startInlineVenturesRunner = (): void => {
  if (started) return;
  if (!VENTURES_ENABLED || !VENTURES_PILOT_INLINE) return;
  started = true;
  console.log(`[Ventures Inline] pilot loop ON — ticking active ventures every ${VENTURES_TICK_INTERVAL_MS}ms`);
  const timer = setInterval(() => void cycle(), VENTURES_TICK_INTERVAL_MS);
  // Don't keep the event loop alive solely for this timer.
  if (typeof timer.unref === 'function') timer.unref();
};
