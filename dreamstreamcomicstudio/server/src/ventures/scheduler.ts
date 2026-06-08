// The scheduler — the loop's heartbeat (Epic A2). Periodically fans out one tick per ACTIVE
// venture, but only when Autopilot is enabled, the kill switch is off, and Redis is configured.
// The global concurrency cap bounds how many ticks are in flight per cycle; the per-venture
// jobId (queue.ts) prevents a single venture from overlapping. Crash-safe: state is durable in
// Postgres, so a restarted worker simply re-reads active ventures and resumes.

import { VENTURES_ENABLED, VENTURES_MAX_CONCURRENT_TICKS } from '../config.js';
import { getKillSwitch } from './killSwitch.js';
import { listActiveVentures } from './controlPlane.js';
import { enqueueTick, isVenturesQueueConfigured } from './queue.js';

/** Enqueue ticks for due ventures. Returns how many were enqueued (0 when halted/unconfigured). */
export const scheduleDueTicks = async (): Promise<number> => {
  if (!VENTURES_ENABLED || getKillSwitch() || !isVenturesQueueConfigured()) return 0;
  const ventures = await listActiveVentures(VENTURES_MAX_CONCURRENT_TICKS);
  let enqueued = 0;
  for (const v of ventures) {
    try {
      await enqueueTick(v.userId, v.id);
      enqueued += 1;
    } catch (e) {
      console.error('[Ventures Scheduler] failed to enqueue tick', { ventureId: v.id, error: (e as Error)?.message });
    }
  }
  return enqueued;
};
