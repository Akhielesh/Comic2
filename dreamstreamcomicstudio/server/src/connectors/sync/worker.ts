// ============================================================================
// Connector sync worker — a SEPARATE process: `npm run connectors:worker`
// ============================================================================
//
// Requires REDIS_URL. Processes one sync page per job and re-enqueues a follow-up
// while there's more to fetch (so a large mailbox drains across many small, retryable
// jobs). Deploy as its own Railway service so background sync never competes with the
// API. Importing ../index.js registers the connectors in THIS process's registry.
// ============================================================================

import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import { CONNECTORS_WORKER_CONCURRENCY } from '../../config.js';
import {
  enqueueSync,
  getConnectorRedisConnection,
  isConnectorQueueConfigured,
  queueName,
  type ConnectorSyncJobData
} from './queue.js';
import { runConnectorSyncPage } from './runner.js';
import { logNote } from './syncLog.js';
import { purgeExpiredOAuthState } from '../store.js';
import '../index.js';

export const startConnectorWorker = async () => {
  if (!isConnectorQueueConfigured()) {
    throw new Error('REDIS_URL is required to run the connector sync worker.');
  }

  const connection = getConnectorRedisConnection();
  const worker = new Worker(
    queueName,
    async (job) => {
      const { userId, connectionId, mode } = (job.data || {}) as ConnectorSyncJobData;
      if (!userId || !connectionId) throw new Error('Sync job missing userId/connectionId.');
      const result = await runConnectorSyncPage(userId, connectionId, mode);
      // Drain pagination: re-enqueue the next page (unique id so it isn't de-duped).
      if (result.status === 'ok' && result.hasMore) {
        await enqueueSync({ userId, connectionId, mode: result.mode }, { dedupe: false });
      }
      return result;
    },
    { connection, concurrency: CONNECTORS_WORKER_CONCURRENCY }
  );

  // Per-page detail (what each page captured) is logged by the runner via syncLog; the
  // worker only narrates job lifecycle so the two don't double up.
  worker.on('ready', () => logNote('connector_worker_ready', 'worker ready — draining the sync queue', 'info'));
  worker.on('failed', (job, error) =>
    logNote('connector_worker_job_failed', `job ${job?.id || '?'} failed — ${error?.message || 'unknown error'} (BullMQ will retry)`, 'error', {
      id: job?.id,
      error: error?.message
    })
  );

  // Periodic housekeeping: drop expired OAuth handshake rows.
  const interval = setInterval(() => {
    purgeExpiredOAuthState().catch((e) =>
      logNote('connector_oauth_state_purge_error', `OAuth-state purge error — ${(e as Error)?.message}`, 'warn', { error: (e as Error)?.message })
    );
  }, 15 * 60_000);
  worker.on('closing', () => clearInterval(interval));

  return worker;
};

const filePath = fileURLToPath(import.meta.url);
if (process.argv[1] === filePath) {
  startConnectorWorker().catch((error) => {
    console.error('[Connectors Worker] Fatal startup error', error);
    process.exit(1);
  });
}
