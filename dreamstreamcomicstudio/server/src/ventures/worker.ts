// Ventures worker (Epic A2) — a SEPARATE process: `npm run ventures:worker`. Requires
// REDIS_URL. It (1) processes 'tick' jobs by running one governed tick per venture, and
// (2) runs the scheduler heartbeat that fans out ticks for active ventures. Deploy it as its
// own Railway service so the autonomous loop never competes with the API.
// Nothing runs unless VENTURES_ENABLED is true + the kill switch is off
// (enforced inside the tick + scheduler).

import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import { VENTURES_WORKER_CONCURRENCY, VENTURES_TICK_INTERVAL_MS } from '../config.js';
import { getVenturesRedisConnection, isVenturesQueueConfigured, queueName } from './queue.js';
import { runVentureTick } from './tickRunner.js';
import { scheduleDueTicks } from './scheduler.js';

export const startVenturesWorker = async () => {
  if (!isVenturesQueueConfigured()) {
    throw new Error('REDIS_URL is required to run the Ventures worker.');
  }

  const connection = getVenturesRedisConnection();
  const worker = new Worker(
    queueName,
    async (job) => {
      const { userId, ventureId } = (job.data || {}) as { userId?: string; ventureId?: string };
      if (!userId || !ventureId) throw new Error('Tick job missing userId/ventureId.');
      return runVentureTick(userId, ventureId);
    },
    { connection, concurrency: VENTURES_WORKER_CONCURRENCY }
  );

  worker.on('ready', () => console.log('[Ventures Worker] Ready'));
  worker.on('failed', (job, error) =>
    console.error('[Ventures Worker] Tick failed', { id: job?.id, error: error?.message })
  );
  worker.on('completed', (job) =>
    console.log('[Ventures Worker] Tick done', { id: job?.id, result: job?.returnvalue })
  );

  // Heartbeat: fan out ticks for active ventures on an interval.
  const interval = setInterval(() => {
    scheduleDueTicks().catch((e) => console.error('[Ventures Scheduler] error', (e as Error)?.message));
  }, VENTURES_TICK_INTERVAL_MS);
  worker.on('closing', () => clearInterval(interval));

  return worker;
};

const filePath = fileURLToPath(import.meta.url);
if (process.argv[1] === filePath) {
  startVenturesWorker().catch((error) => {
    console.error('[Ventures Worker] Fatal startup error', error);
    process.exit(1);
  });
}
