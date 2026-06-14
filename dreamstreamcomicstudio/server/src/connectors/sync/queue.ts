// ============================================================================
// Connector sync queue (BullMQ) — mirrors the ventures queue pattern
// ============================================================================
//
// Lazily-created, guarded by REDIS_URL. Without Redis the queue is simply
// unavailable and the API keeps working — connect/force-sync run the sync INLINE
// instead (see runner.runConnectorSyncInline). A per-connection jobId de-dupes
// user-triggered syncs; paginated follow-ups use a unique id so they aren't dropped.
// ============================================================================

import * as IORedis from 'ioredis';
import { Job, JobsOptions, Queue } from 'bullmq';
import { REDIS_URL, CONNECTORS_QUEUE_PREFIX } from '../../config.js';

export type ConnectorSyncMode = 'full' | 'incremental' | 'auto';

export interface ConnectorSyncJobData {
  userId: string;
  connectionId: string;
  mode: ConnectorSyncMode;
}

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  removeOnComplete: 200,
  removeOnFail: 500,
  backoff: { type: 'exponential', delay: 5000 }
};

let queue: Queue | null = null;
let redisConnection: any = null;

export const queueName = `${CONNECTORS_QUEUE_PREFIX}:sync`;

export const isConnectorQueueConfigured = (): boolean => Boolean(REDIS_URL && REDIS_URL.trim());

export const getConnectorRedisConnection = () => {
  if (!isConnectorQueueConfigured()) {
    throw new Error('Connector sync queue is unavailable. Configure REDIS_URL.');
  }
  if (!redisConnection) {
    const RedisCtor = (IORedis as any).default || (IORedis as any);
    redisConnection = new RedisCtor(REDIS_URL!, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false
    });
  }
  return redisConnection;
};

export const getConnectorSyncQueue = (): Queue => {
  if (!queue) {
    queue = new Queue(queueName, {
      connection: getConnectorRedisConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS
    });
  }
  return queue;
};

/**
 * Enqueue a sync. `dedupe` (default true) sets a per-connection jobId so duplicate
 * user requests collapse; paginated follow-ups pass dedupe:false for a unique id.
 */
export const enqueueSync = async (
  data: ConnectorSyncJobData,
  opts: { dedupe?: boolean; delayMs?: number } = {}
): Promise<Job> => {
  const q = getConnectorSyncQueue();
  const jobId = opts.dedupe === false ? `sync:${data.connectionId}:${Date.now()}` : `sync:${data.connectionId}`;
  return q.add('sync', data, {
    ...DEFAULT_JOB_OPTIONS,
    jobId,
    ...(opts.delayMs ? { delay: opts.delayMs } : {})
  });
};
