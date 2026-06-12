// BullMQ queue for Autopilot ticks (Epic A2). A guarded,
// lazily-created queue that requires REDIS_URL. Without Redis the queue is simply unavailable
// and the API keeps working — only the autonomous worker needs it. A per-venture jobId
// de-dupes so a venture never piles up overlapping ticks.

import * as IORedis from 'ioredis';
import { Job, JobsOptions, Queue } from 'bullmq';
import { REDIS_URL, VENTURES_QUEUE_PREFIX } from '../config.js';

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 2,
  removeOnComplete: 200,
  removeOnFail: 500,
  backoff: { type: 'exponential', delay: 2000 }
};

let queue: Queue | null = null;
let redisConnection: any = null;

export const queueName = `${VENTURES_QUEUE_PREFIX}:ticks`;

export const isVenturesQueueConfigured = (): boolean => Boolean(REDIS_URL && REDIS_URL.trim());

export const getVenturesRedisConnection = () => {
  if (!isVenturesQueueConfigured()) {
    throw new Error('Ventures queue is unavailable. Configure REDIS_URL.');
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

export const getVenturesQueue = (): Queue => {
  if (!queue) {
    queue = new Queue(queueName, {
      connection: getVenturesRedisConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS
    });
  }
  return queue;
};

/** Enqueue one tick for a venture. The per-venture jobId prevents overlapping ticks. */
export const enqueueTick = async (userId: string, ventureId: string): Promise<Job> => {
  const q = getVenturesQueue();
  return q.add(
    'tick',
    { userId, ventureId },
    { ...DEFAULT_JOB_OPTIONS, jobId: `tick:${ventureId}` }
  );
};
