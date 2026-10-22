// Repository-backed adapter that runs one tick for a venture. Epic A2.
//
// The ACT step used to build the venture's app with Code Studio's generator and save it as a
// studio_project. Code Studio is retired (ADR 0005), and the build stage went with it: a tick
// now pauses the venture once ('build_retired') and logs why. listActiveVentures only returns
// status='active', so each venture is paused exactly once — one event, no spend, no model call.
// Roadmaps, goals, budgets, checkpoints and signals still work through the API. The pure
// governed loop (tick.ts) stays intact for a future ACT step.

import { appendEvent, setVentureStatus } from './repository.js';
import type { TickResult } from './tick.js';
import { incr } from '../observability/metrics.js';

export const BUILD_RETIRED_MESSAGE =
  'The build stage was retired with Code Studio (ADR 0005). Roadmaps, goals, budgets, checkpoints and signals still work; nothing is built automatically.';

export const runVentureTick = async (userId: string, ventureId: string): Promise<TickResult> => {
  await setVentureStatus(userId, ventureId, 'paused', 'build_retired');
  await appendEvent({
    ventureId,
    userId,
    kind: 'venture.paused',
    level: 'warn',
    message: BUILD_RETIRED_MESSAGE,
    source: 'engine'
  });
  incr('venture_tick', { outcome: 'retired' });
  return { outcome: 'retired' };
};
