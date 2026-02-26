import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import { COMICFORGE_WORKER_CONCURRENCY, COMICFORGE_QUEUE_PREFIX } from '../config.js';
import { getComicForgeRedisConnection, isComicForgeQueueConfigured } from './queue.js';
import { comicForgePipelineService } from './pipelineService.js';
import { runAssemblyWorker } from './workers/assemblyWorker.js';
import { runLetteringWorker } from './workers/letteringWorker.js';
import { runQcWorker } from './workers/qcWorker.js';

const queueName = `${COMICFORGE_QUEUE_PREFIX}:jobs`;

const handleJob = async (job: { id?: string; name: string; data: Record<string, unknown> }) => {
  if (!job.id) {
    throw new Error('Missing job id');
  }

  await comicForgePipelineService.notifyJobRunning(job.id);

  try {
    await comicForgePipelineService.notifyJobProgress(job.id, 35, 'Preparing worker payload');

    let result: Record<string, unknown>;

    if (job.name === 'panel_gen_final' && job.data.operation === 'assemble_page') {
      result = await runAssemblyWorker(job.data);
    } else if (job.name === 'panel_gen_final' && job.data.operation === 'render_lettering') {
      result = await runLetteringWorker(job.data);
    } else if (job.name === 'qc_check') {
      result = await runQcWorker(job.data);
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

    await comicForgePipelineService.notifyJobProgress(job.id, 80, 'Finalizing artifacts');
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
