import { Router } from 'express';
import { ORIGINAL_KEYS, ORIGINAL_SLUGS, isPublishableOriginal, type OriginalKey } from '../../../shared/comic/originals.js';
import { publishBundledOriginal } from '../comic/originals/import.js';
import { createRateLimit } from '../middleware/rateLimit.js';
import { authenticateCatalogMaintenance } from '../services/catalogMaintenanceAuth.js';

const failureCodes = new Map([
  ['Public publication storage is unavailable.', 'STORAGE_UNAVAILABLE'],
  ['Editorial publication is busy, withdrawn, or its source changed.', 'EDITION_UNAVAILABLE'],
  ['Editorial publication lease or review state changed.', 'PUBLICATION_CONFLICT'],
  ['The complete original did not clear the publication checks.', 'REVIEW_INCOMPLETE'],
  ['Editorial rating revision is unavailable.', 'RATING_REVISION_UNAVAILABLE'],
  ['Editorial rating revision could not be recorded.', 'RATING_REVISION_NOT_RECORDED'],
  ['Editorial artwork upload failed.', 'STORAGE_WRITE_FAILED'],
  ['Editorial artwork checksum mismatch.', 'STORAGE_VERIFY_FAILED'],
  ['The full live Studio Original could not be verified.', 'READER_VERIFY_FAILED']
]);
type Result = { state: 'running' } | { state: 'published'; slug: string } | { state: 'failed'; code: string };
type Job = { attempt: string; result: Result };

export function createOriginalsPublisher(
  authenticate = authenticateCatalogMaintenance,
  publish = publishBundledOriginal
) {
  const jobs = new Map<OriginalKey, Job>();
  const busy = () => Array.from(jobs.values()).some(job => job.result.state === 'running');
  const router = Router();
  router.use(createRateLimit({scope: 'editorial-publishing', windowMs: 60_000, maxRequests: 20}));

  for (const key of ORIGINAL_KEYS) {
    router.post('/' + key, async (req, res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      if (Object.keys(req.query).length || (req.body && Object.keys(req.body).length)) {
        res.status(400).json({code: 'NO_PARAMETERS'}); return;
      }
      const auth = req.header('authorization') ?? '';
      if (!auth.startsWith('Bearer ')) { res.sendStatus(401); return; }
      let attempt: string;
      try {
        const identity = await authenticate(auth.slice(7), 'publish-originals');
        attempt = identity.runId + '/' + identity.attempt;
      } catch {
        res.sendStatus(401); return;
      }
      if (!isPublishableOriginal(key)) {
        res.status(410).json({state: 'held', code: 'EDITION_HELD'}); return;
      }
      let job = jobs.get(key);
      if (!job || (job.attempt !== attempt && job.result.state !== 'running')) {
        if (busy()) { res.setHeader('Retry-After', '12'); res.sendStatus(409); return; }
        const started: Job = {attempt, result: {state: 'running'}};
        jobs.set(key, started);
        job = started;
        // The client polls while the regular publication and safety gates complete.
        // A restarted container resumes the persisted edition through the same importer.
        void publish(key, '/app/editorial-originals').then(({slug}) => {
          if (slug !== ORIGINAL_SLUGS[key]) throw new Error('Invalid published slug');
          started.result = {state: 'published', slug};
        }).catch((error: unknown) => {
          const code = error instanceof Error ? failureCodes.get(error.message) : undefined;
          started.result = {state: 'failed', code: code ?? 'PUBLICATION_FAILED'};
        });
      }
      if (job.result.state === 'running') {
        res.setHeader('Retry-After', '12');
        res.status(202).json(job.result);
      } else {
        res.status(job.result.state === 'published' ? 200 : 503).json(job.result);
      }
    });
  }
  return { router, busy };
}

const publisher = createOriginalsPublisher();
export const originalsPublisherRouter = publisher.router;
export const originalsPublisherBusy = publisher.busy;
