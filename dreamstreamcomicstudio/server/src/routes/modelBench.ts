// Admin model-bench API — the in-app trigger for the all-models live test.
// Mounted at /api/admin/model-bench behind requireAuth + requireAdmin (same gate
// as the Admin Email Console). One run at a time; results are polled by id.
// Finished runs persist to model_bench_runs, so history survives restarts.

import { Router } from 'express';
import {
  startBenchRun,
  listBenchRuns,
  getBenchRun,
  getAllBenchRuns,
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
modelBenchRouter.get('/runs', async (_req, res, next) => {
  try {
    res.json({ runs: await listBenchRuns() });
  } catch (err) {
    next(err);
  }
});

// Every finished run WITH full results — the "export all tests combined" payload.
// Registered before /runs/:id so "export" is never matched as a run id.
modelBenchRouter.get('/runs/export', async (_req, res, next) => {
  try {
    res.json({ runs: await getAllBenchRuns() });
  } catch (err) {
    next(err);
  }
});

// Full run state — the UI polls this while state === 'running'.
modelBenchRouter.get('/runs/:id', async (req, res, next) => {
  try {
    const run = await getBenchRun(String(req.params.id));
    if (!run) {
      res.status(404).json({ error: { message: 'No such bench run.' } });
      return;
    }
    res.json({ run });
  } catch (err) {
    next(err);
  }
});
