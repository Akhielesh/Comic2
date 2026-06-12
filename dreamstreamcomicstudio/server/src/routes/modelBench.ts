// Admin model-bench API — the in-app trigger for the all-models live test.
// Mounted at /api/admin/model-bench behind requireAuth + requireAdmin (same gate
// as the Admin Email Console). One run at a time; results are polled by id.

import { Router } from 'express';
import {
  startBenchRun,
  listBenchRuns,
  getBenchRun,
  getRunningBenchRun,
  type BenchOptions
} from '../services/modelBenchRunner.js';

export const modelBenchRouter = Router();

// Start a run (409 when one is already in progress). Body: Partial<BenchOptions>.
modelBenchRouter.post('/start', (req, res) => {
  const { run, error } = startBenchRun((req.body || {}) as Partial<BenchOptions>);
  if (!run) {
    const running = getRunningBenchRun();
    res.status(running ? 409 : 503).json({ error: { message: error }, runId: running?.id });
    return;
  }
  res.status(202).json({ run });
});

// Past + current runs, newest first (summaries only — no result rows).
modelBenchRouter.get('/runs', (_req, res) => {
  res.json({ runs: listBenchRuns() });
});

// Full run state — the UI polls this while state === 'running'.
modelBenchRouter.get('/runs/:id', (req, res) => {
  const run = getBenchRun(String(req.params.id));
  if (!run) {
    res.status(404).json({ error: { message: 'No such bench run (runs are kept in memory and pruned).' } });
    return;
  }
  res.json({ run });
});
