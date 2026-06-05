// Studio control plane (Railway/Express).
//
// Brokers the browser → Cloudflare Studio Worker hop: authenticates the user (global
// requireAuth on /api), enforces per-user caps, HMAC-signs the request to the Worker,
// and records each container session in `studio_runs` for metering. Browsers never call
// the Worker directly. App traffic to the running preview goes straight to the preview
// URL (not through here). See docs/studio/phases/PHASE-2-control-plane.md.

import { Router } from 'express';
import crypto from 'crypto';
import {
  STUDIO_WORKER_URL,
  STUDIO_HMAC_SECRET,
  STUDIO_MAX_CONCURRENT_PER_USER,
  STUDIO_DAILY_BUILD_MINUTES,
  STUDIO_REQUEST_TIMEOUT_MS,
  STUDIO_COST_PER_AWAKE_SEC
} from '../config.js';
import { getSupabaseAdmin } from '../services/supabase.js';
import { signStudioBody } from '../services/studioSign.js';
import { evaluateLaunchAllowed } from '../services/studioCaps.js';

export const studioRouter = Router();

const notConfigured = (): boolean => !STUDIO_WORKER_URL || !STUDIO_HMAC_SECRET;

const notConfiguredResponse = {
  error: {
    message: 'Live Studio is not configured on this server yet (set STUDIO_WORKER_URL and STUDIO_HMAC_SECRET).',
    code: 'STUDIO_NOT_CONFIGURED'
  }
};

/** Signed POST to the Studio Worker. */
const callWorker = async (
  payload: Record<string, unknown>
): Promise<{ ok: boolean; status: number; json: any }> => {
  const raw = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STUDIO_REQUEST_TIMEOUT_MS);
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

/** The user's current Studio usage, for cap enforcement. */
const getUsage = async (userId: string): Promise<{ activeRuns: number; dailyAwakeSeconds: number }> => {
  const admin = getSupabaseAdmin();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [active, daily] = await Promise.all([
    admin.from('studio_runs').select('id', { count: 'exact', head: true }).eq('user_id', userId).is('ended_at', null),
    admin.from('studio_runs').select('awake_seconds').eq('user_id', userId).gte('started_at', startOfDay.toISOString())
  ]);
  const dailyAwakeSeconds = (daily.data || []).reduce(
    (n: number, r: { awake_seconds: number | null }) => n + (r.awake_seconds || 0),
    0
  );
  return { activeRuns: active.count || 0, dailyAwakeSeconds };
};

// POST /api/studio/launch — start a live preview container for the AI-built project.
studioRouter.post('/launch', async (req, res, next) => {
  try {
    if (notConfigured()) return res.status(503).json(notConfiguredResponse);
    const userId = req.user!.id;
    const body = (req.body || {}) as {
      projectId?: string;
      files?: { path?: unknown; content?: unknown }[];
      install?: string;
      dev?: string;
      port?: number;
    };

    const files = Array.isArray(body.files)
      ? body.files
          .filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string')
          .slice(0, 200)
      : [];
    if (!files.length) {
      return res.status(400).json({ error: { message: 'files[] (with path + content) is required.' } });
    }
    const projectId =
      typeof body.projectId === 'string' && body.projectId.trim()
        ? body.projectId.trim().slice(0, 80)
        : crypto.randomUUID();
    const port = Number.isInteger(body.port) && (body.port as number) > 1024 && body.port !== 3000 ? (body.port as number) : 3001;

    // Per-user caps (defensive: if the DB is unavailable in dev, log + allow rather than block).
    try {
      const usage = await getUsage(userId);
      const decision = evaluateLaunchAllowed(usage, {
        maxConcurrentPerUser: STUDIO_MAX_CONCURRENT_PER_USER,
        dailyBuildMinutes: STUDIO_DAILY_BUILD_MINUTES
      });
      if (!decision.allowed) {
        return res.status(429).json({ error: { message: decision.message, code: decision.code } });
      }
    } catch (err) {
      console.warn('[studio] cap check skipped:', (err as Error)?.message);
    }

    const sandboxId = `u_${userId}_${projectId}`;
    const worker = await callWorker({ action: 'launch', sandboxId, files, install: body.install, dev: body.dev, port });
    if (!worker.ok || worker.json?.status === 'error') {
      return res.status(502).json({
        error: {
          message: worker.json?.message || worker.json?.log || `Studio worker failed (HTTP ${worker.status}).`,
          code: 'STUDIO_WORKER_ERROR',
          phase: worker.json?.phase
        }
      });
    }

    const previewUrl: string | undefined = worker.json?.previewUrl;
    let runId: string | undefined;
    try {
      const admin = getSupabaseAdmin();
      const { data } = await admin
        .from('studio_runs')
        .insert({ user_id: userId, project_id: projectId, sandbox_id: sandboxId, status: 'live', preview_url: previewUrl })
        .select('id')
        .single();
      runId = data?.id;
    } catch (err) {
      console.warn('[studio] run record skipped:', (err as Error)?.message);
    }

    return res.json({ previewUrl, sandboxId, projectId, runId });
  } catch (err) {
    next(err);
  }
});

// POST /api/studio/:id/stop — stop a live preview and close out its run (cost accounting).
studioRouter.post('/:id/stop', async (req, res, next) => {
  try {
    if (notConfigured()) return res.status(503).json(notConfiguredResponse);
    const userId = req.user!.id;
    const runId = req.params.id;
    const admin = getSupabaseAdmin();
    const { data: run } = await admin
      .from('studio_runs')
      .select('id, sandbox_id, started_at, ended_at, awake_seconds')
      .eq('id', runId)
      .eq('user_id', userId)
      .single();
    if (!run) return res.status(404).json({ error: { message: 'Run not found.' } });

    await callWorker({ action: 'stop', sandboxId: run.sandbox_id }).catch(() => null);

    const awakeSeconds = run.ended_at
      ? run.awake_seconds || 0
      : Math.max(0, Math.round((Date.now() - new Date(run.started_at).getTime()) / 1000));
    await admin
      .from('studio_runs')
      .update({
        status: 'stopped',
        ended_at: new Date().toISOString(),
        awake_seconds: awakeSeconds,
        cost_usd: Number((awakeSeconds * STUDIO_COST_PER_AWAKE_SEC).toFixed(4))
      })
      .eq('id', runId);

    return res.json({ status: 'stopped', awakeSeconds });
  } catch (err) {
    next(err);
  }
});

// GET /api/studio/:id/logs — live build/dev logs. Lands when the Worker's logs action
// ships (Phase 1 follow-up); stubbed honestly until then so callers can detect it.
studioRouter.get('/:id/logs', (_req, res) => {
  res.status(501).json({
    error: { message: 'Live log streaming arrives with the Phase 1 Worker logs action.', code: 'STUDIO_LOGS_PENDING' }
  });
});
