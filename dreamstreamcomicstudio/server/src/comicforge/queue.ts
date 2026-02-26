import * as IORedis from 'ioredis';
import { Job, JobsOptions, Queue } from 'bullmq';
import { COMICFORGE_QUEUE_PREFIX, REDIS_URL } from '../config.js';

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  removeOnComplete: 200,
  removeOnFail: 500,
  backoff: {
    type: 'exponential',
    delay: 1500
  }
};

let queue: Queue | null = null;
let redisConnection: any = null;

export const isComicForgeQueueConfigured = () => Boolean(REDIS_URL && REDIS_URL.trim());

const buildQueueUnavailableError = () => {
  const error = new Error('ComicForge queue is unavailable. Configure REDIS_URL.') as Error & {
    status?: number;
    publicCode?: string;
  };
  error.status = 503;
  error.publicCode = 'COMICFORGE_QUEUE_UNAVAILABLE';
  return error;
};

export const assertComicForgeQueueAvailable = () => {
  if (!isComicForgeQueueConfigured()) {
    throw buildQueueUnavailableError();
  }
};

export const getComicForgeRedisConnection = () => {
  assertComicForgeQueueAvailable();
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

export const getComicForgeQueue = () => {
  if (!queue) {
    const connection = getComicForgeRedisConnection();
    queue = new Queue(`${COMICFORGE_QUEUE_PREFIX}:jobs`, {
      connection,
      defaultJobOptions: DEFAULT_JOB_OPTIONS
    });
  }
  return queue;
};

export const enqueueComicForgeJob = async (
  taskType: string,
  payload: Record<string, unknown>,
  options?: JobsOptions
): Promise<Job> => {
  const q = getComicForgeQueue();
  return q.add(taskType, payload, {
    ...DEFAULT_JOB_OPTIONS,
    ...(options || {})
  });
};

export const getComicForgeJob = async (jobId: string): Promise<Job | null> => {
  const q = getComicForgeQueue();
  return q.getJob(jobId);
};

export const getComicForgeJobState = async (jobId: string): Promise<{
  status: 'queued' | 'running' | 'done' | 'failed';
  progress?: number;
  errorMessage?: string;
  result?: Record<string, unknown>;
}> => {
  const job = await getComicForgeJob(jobId);
  if (!job) {
    return {
      status: 'failed',
      errorMessage: 'Job not found'
    };
  }

  const state = await job.getState();
  const progress = typeof job.progress === 'number' ? job.progress : undefined;

  if (state === 'completed') {
    return {
      status: 'done',
      progress: 100,
      result: (job.returnvalue || undefined) as Record<string, unknown> | undefined
    };
  }

  if (state === 'failed') {
    return {
      status: 'failed',
      progress,
      errorMessage: job.failedReason || 'Job failed'
    };
  }

  if (state === 'active') {
    return {
      status: 'running',
      progress
    };
  }

  return {
    status: 'queued',
    progress
  };
};
