// Studio Worker client — the single place that signs + POSTs to the Cloudflare Studio
// Worker. Both the control-plane routes (launch/stop/logs) and the Phase 4 build service
// go through here, so the HMAC signing + timeout policy live in one spot (no duplication).

import { STUDIO_WORKER_URL, STUDIO_HMAC_SECRET, STUDIO_REQUEST_TIMEOUT_MS } from '../config.js';
import { signStudioBody } from './studioSign.js';
import type { RunResult } from '../ai/studio/buildAgent.js';

export interface WorkerCallResult {
  ok: boolean;
  status: number;
  json: any;
}

/** True iff `value` is a usable http(s) URL (rejects empty, malformed, and the docs
 * placeholder `…<account>.workers.dev`). Prevents a `fetch()` "Failed to parse URL" crash. */
export const isValidStudioWorkerUrl = (value: string | undefined): boolean => {
  if (!value || value.includes('<') || value.includes('>')) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

/** True once the owner has wired STUDIO_WORKER_URL (a valid URL) + STUDIO_HMAC_SECRET. */
export const studioConfigured = (): boolean => Boolean(STUDIO_HMAC_SECRET) && isValidStudioWorkerUrl(STUDIO_WORKER_URL);

/** Signed POST to the Studio Worker. Browsers never reach the Worker directly. `timeoutMs`
 *  defaults to the standard request budget; long operations (e.g. deploy = install+build+publish)
 *  pass a larger value so they don't abort mid-build. */
export const callStudioWorker = async (
  payload: Record<string, unknown>,
  timeoutMs: number = STUDIO_REQUEST_TIMEOUT_MS
): Promise<WorkerCallResult> => {
  const raw = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(STUDIO_WORKER_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-studio-signature': signStudioBody(raw, STUDIO_HMAC_SECRET)
      },
      body: raw,
      signal: controller.signal
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON body */
    }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
};

export interface RunSignals {
  /** The worker `launch` JSON ({ previewUrl } on success, { status:'error', phase, log } on failure). */
  launch?: { previewUrl?: string; status?: string; phase?: string; log?: string; message?: string };
  /** The worker `logs` JSON (dev process stdout/stderr). */
  logs?: { stdout?: string; stderr?: string };
  /** HTTP status of GET / on the preview URL (200 = up). */
  httpStatus?: number;
  /** Runtime console errors collected from the preview iframe. */
  consoleErrors?: string[];
}

/**
 * Normalize the worker's launch + logs + preview-probe signals into the `RunResult` the
 * Phase 4 observation parser consumes. Pure — unit-testable without a live worker.
 */
export const toRunResult = (signals: RunSignals): RunResult => {
  const installFailed = signals.launch?.status === 'error' && signals.launch?.phase === 'install';
  return {
    installLog: installFailed ? signals.launch?.log || signals.launch?.message : undefined,
    stdout: signals.logs?.stdout,
    stderr: signals.logs?.stderr,
    httpStatus: signals.httpStatus,
    consoleErrors: signals.consoleErrors,
    previewUrl: signals.launch?.previewUrl
  };
};
