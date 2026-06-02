import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import { COMICFORGE_WORKER_CONCURRENCY, COMICFORGE_QUEUE_PREFIX } from '../config.js';
import { getComicForgeRedisConnection, isComicForgeQueueConfigured } from './queue.js';
import { comicForgePipelineService } from './pipelineService.js';
import { runAssemblyWorker } from './workers/assemblyWorker.js';
import { runLetteringWorker } from './workers/letteringWorker.js';
import { runQcWorker } from './workers/qcWorker.js';
import { generateComicForgeImages } from './generation.js';

const queueName = `${COMICFORGE_QUEUE_PREFIX}:jobs`;

const GENERATION_TASKS = new Set(['thumbnail_gen', 'panel_gen_draft', 'panel_gen_final']);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const handleJob = async (job: { id?: string; name: string; data: Record<string, unknown> }) => {
  if (!job.id) {
    throw new Error('Missing job id');
  }

  await comicForgePipelineService.notifyJobRunning(job.id);

  try {
    await comicForgePipelineService.notifyJobProgress(job.id, 35, 'Preparing worker payload');

    let result: Record<string, unknown>;

    const operation = asString(job.data.operation);

    if (job.name === 'panel_gen_final' && operation === 'assemble_page') {
      result = await runAssemblyWorker(job.data);
    } else if (job.name === 'panel_gen_final' && operation === 'render_lettering') {
      result = await runLetteringWorker(job.data);
    } else if (job.name === 'qc_check') {
      result = await runQcWorker(job.data);
    } else if (GENERATION_TASKS.has(job.name) && !operation) {
      // Real image generation via the live OpenRouter gateway. Requires userId
      // (threaded through the job payload) + a configured platform key.
      const userId = asString(job.data.userId);
      const projectId = asString(job.data.projectId);
      if (!userId || !projectId) {
        throw new Error('ComicForge generation job is missing userId/projectId.');
      }
      const quality = job.name === 'thumbnail_gen'
        ? 'thumbnail'
        : (asString(job.data.quality) === 'final' ? 'final' : 'draft');
      result = await generateComicForgeImages({
        userId,
        projectId,
        quality,
        onProgress: (progress, message) => comicForgePipelineService.notifyJobProgress(job.id!, progress, message)
      });
    } else if (job.name === 'panel_gen_export') {
      result = {
        exported: true,
        downloadUrl: '',
        payload: job.data,
        completedAt: Date.now()
      };
    } else {
      result = {
        completed: true,
        payload: job.data,
        taskType: job.name,
        completedAt: Date.now()
      };
    }

    await comicForgePipelineService.notifyJobProgress(job.id, 95, 'Finalizing artifacts');
    await comicForgePipelineService.notifyJobDone(job.id, result);
    return result;
  } catch (error) {
    const message = (error as Error).message || 'Job failed';
    await comicForgePipelineService.notifyJobFailed(job.id, message);
    throw error;
  }
};

export const startComicForgeWorker = async () => {
  if (!isComicForgeQueueConfigured()) {
    throw new Error('REDIS_URL is required to run ComicForge worker.');
  }

  const connection = getComicForgeRedisConnection();
  const worker = new Worker(
    queueName,
    async (job) => {
      return handleJob(job);
    },
    {
      connection,
      concurrency: COMICFORGE_WORKER_CONCURRENCY
    }
  );

  worker.on('ready', () => {
    console.log('[ComicForge Worker] Ready');
  });

  worker.on('failed', (job, error) => {
    console.error('[ComicForge Worker] Job failed', {
      id: job?.id,
      name: job?.name,
      error: error?.message
    });
  });

  worker.on('completed', (job) => {
    console.log('[ComicForge Worker] Job completed', {
      id: job?.id,
      name: job?.name
    });
  });

  return worker;
};

const filePath = fileURLToPath(import.meta.url);
if (process.argv[1] === filePath) {
  startComicForgeWorker().catch((error) => {
    console.error('[ComicForge Worker] Fatal startup error', error);
    process.exit(1);
  });
}
