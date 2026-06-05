// Phase 4 — the live RUN capability for the agentic build loop.
//
// Wraps the Studio Worker into the `run(files)` function `runBuildAgent` expects: (re)launch
// the container with the current files, pull the dev logs, probe the preview's HTTP status,
// and normalize all three into a RunResult for the observation parser. The worker call and
// the HTTP probe are injectable so the orchestration is unit-testable without a live worker.
//
// The AI FIX call (the other injected dep of runBuildAgent) is wired separately, in the
// build route, where the authenticated request's provider/key/model are available.

import { callStudioWorker, toRunResult } from './studioWorker.js';
import type { RunResult } from '../ai/studio/buildAgent.js';
import type { StudioFiles } from '../ai/studio/studioFix.js';

/** buildAgent holds files as a path→content map; the worker wants [{path, content}]. */
export const filesRecordToArray = (files: StudioFiles): { path: string; content: string }[] =>
  Object.entries(files).map(([path, content]) => ({ path: path.startsWith('/') ? path : `/${path}`, content }));

/** GET / on the preview URL; returns the HTTP status (0 if it didn't respond in time). */
export const probePreview = async (
  url: string,
  timeoutMs = 8000,
  fetchImpl: typeof fetch = fetch
): Promise<number> => {
  if (!url) return 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
};

export interface WorkerRunConfig {
  sandboxId: string;
  install?: string;
  dev?: string;
  port?: number;
  /** Injectable worker client (defaults to the real signed call) — for tests. */
  call?: typeof callStudioWorker;
  /** Injectable preview probe (defaults to a real GET /) — for tests. */
  probe?: (url: string) => Promise<number>;
}

/**
 * Build the `run(files)` capability for runBuildAgent: launch → logs → probe → RunResult.
 * On a launch failure it short-circuits to an install/boot observation (no logs to fetch).
 */
export const createWorkerRun = (config: WorkerRunConfig) => {
  const call = config.call ?? callStudioWorker;
  const probe = config.probe ?? ((u: string) => probePreview(u));

  return async (files: StudioFiles): Promise<RunResult> => {
    const launch = await call({
      action: 'launch',
      sandboxId: config.sandboxId,
      files: filesRecordToArray(files),
      install: config.install,
      dev: config.dev,
      port: config.port
    });

    if (!launch.ok || launch.json?.status === 'error') {
      return toRunResult({
        launch: launch.json && typeof launch.json === 'object'
          ? launch.json
          : { status: 'error', phase: 'install', log: `Studio worker failed (HTTP ${launch.status}).` }
      });
    }

    const previewUrl: string | undefined = launch.json?.previewUrl;
    const logs = await call({ action: 'logs', sandboxId: config.sandboxId });
    const httpStatus = previewUrl ? await probe(previewUrl) : 0;

    return toRunResult({
      launch: launch.json,
      logs: logs.ok && logs.json && typeof logs.json === 'object' ? logs.json : undefined,
      httpStatus
    });
  };
};
