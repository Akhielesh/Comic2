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
  STUDIO_MAX_CONCURRENT_PER_USER,
  STUDIO_DAILY_BUILD_MINUTES,
  STUDIO_COST_PER_AWAKE_SEC,
  STUDIO_REQUEST_TIMEOUT_MS
} from '../config.js';
import { getSupabaseAdmin } from '../services/supabase.js';
import { callStudioWorker, studioConfigured } from '../services/studioWorker.js';
import { createWorkerRun, createStudioFix } from '../services/studioBuildService.js';
import { evaluateLaunchAllowed } from '../services/studioCaps.js';
import { sanitizeFiles, deriveProjectName } from '../services/studioFiles.js';
import { saveProject, listProjects, getProjectWithFiles, deleteProject, listVersions, getVersionFiles } from '../services/studioRepository.js';
import { runBuildAgent } from '../ai/studio/buildAgent.js';
import { buildGeneratePrompt, parseGeneratedApp } from '../ai/studio/studioGenerate.js';
import { pickCodingModel, TEXT_FALLBACK } from '../ai/autoRouter.js';
import { runChat } from '../ai/chat.js';
import { resolveProviderContext } from '../ai/gateway.js';
import { studioGithubRouter } from './studioGithub.js';

export const studioRouter = Router();

// GitHub two-way sync (Phase 6) — /api/studio/github/{repos,push,pull}.
studioRouter.use('/github', studioGithubRouter);

const notConfigured = (): boolean => !studioConfigured();

const notConfiguredResponse = {
  error: {
    message: 'Live Studio is not configured on this server yet (set STUDIO_WORKER_URL and STUDIO_HMAC_SECRET).',
    code: 'STUDIO_NOT_CONFIGURED'
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

// POST /api/studio/generate — turn a plain-language idea into a runnable app artifact, right
// inside the studio (no chat hand-off). Pure LLM (no sandbox/worker), so it works whenever a
// coding key is configured; the live cloud run (/build, /launch) is a separate upgrade. Auth +
// the global key middleware apply. Also handles "refine" when current files are sent along.
studioRouter.post('/generate', async (req, res, next) => {
  try {
    const body = (req.body || {}) as { prompt?: string; template?: string; files?: unknown; title?: string };
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      return res.status(400).json({ error: { message: 'A prompt describing the app is required.' } });
    }

    const providerCtx = resolveProviderContext(req.apiKeys?.openRouterKey as string | undefined, 'openrouter');
    if (!providerCtx.apiKey) {
      return res.status(400).json({
        error: {
          message: 'No coding model is available. Add an OpenRouter key in Settings (free models work too).',
          code: 'STUDIO_NO_MODEL_KEY'
        }
      });
    }

    let model: string;
    try { model = await pickCodingModel(); } catch { model = TEXT_FALLBACK; }

    const currentFiles = sanitizeFiles(body.files).map((f) => ({ path: f.path, content: f.content }));
    const genPrompt = buildGeneratePrompt({
      prompt,
      template: body.template,
      currentFiles: currentFiles.length ? currentFiles : undefined,
      currentTitle: typeof body.title === 'string' ? body.title : undefined
    });

    const result = await runChat({
      provider: 'openrouter',
      apiKey: providerCtx.apiKey,
      model,
      messages: [{ role: 'user', content: genPrompt }],
      temperature: 0.3,
      maxTokens: 16000,
      fallbackModel: TEXT_FALLBACK,
      timeoutMs: STUDIO_REQUEST_TIMEOUT_MS
    });

    const artifact = parseGeneratedApp(result.text || '', body.template);
    if (!artifact) {
      return res.status(502).json({
        error: { message: 'The model did not return a valid app. Try rephrasing your idea.', code: 'STUDIO_GENERATE_INVALID' }
      });
    }

    return res.json({ artifact });
  } catch (err) {
    next(err);
  }
});

// POST /api/studio/launch — start a live preview container for the AI-built project.
studioRouter.post('/launch', async (req, res, next) => {
  try {
    if (notConfigured()) return res.status(503).json(notConfiguredResponse);
    const userId = req.user!.id;
    const body = (req.body || {}) as {
      projectId?: string;
      title?: string;
      template?: string;
      files?: unknown;
      install?: string;
      dev?: string;
      port?: number;
    };

    const files = sanitizeFiles(body.files);
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
    const worker = await callStudioWorker({ action: 'launch', sandboxId, files, install: body.install, dev: body.dev, port });
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

    // Persist the project (best-effort) so it survives sleep/reload and is versioned.
    try {
      await saveProject({
        userId,
        projectId,
        name: deriveProjectName(body.title, files),
        template: typeof body.template === 'string' ? body.template : 'react-ts',
        files,
        versionLabel: 'live build',
        createdBy: 'agent'
      });
    } catch (err) {
      console.warn('[studio] project save skipped:', (err as Error)?.message);
    }

    return res.json({ previewUrl, sandboxId, projectId, runId });
  } catch (err) {
    next(err);
  }
});

// POST /api/studio/build — the agentic build loop (Phase 4) with a live SSE trace. Composes
// the tested engine (runBuildAgent) with the real worker `run` (createWorkerRun) + a coding-
// model `fix` (createStudioFix, guard-railed). Streams BuildEvents (plan/run/observe/fix/
// done/stopped) so the Code Studio UI renders the build as it happens. Auth + caps + run
// metering apply, same as launch. Safe to ship: nothing calls it until the Studio UI lands.
studioRouter.post('/build', async (req, res, next) => {
  try {
    if (notConfigured()) return res.status(503).json(notConfiguredResponse);
    const userId = req.user!.id;
    const body = (req.body || {}) as {
      projectId?: string;
      title?: string;
      template?: string;
      files?: unknown;
      install?: string;
      dev?: string;
      port?: number;
      maxIterations?: number;
    };

    const files = sanitizeFiles(body.files);
    if (!files.length) {
      return res.status(400).json({ error: { message: 'files[] (with path + content) is required.' } });
    }

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

    const projectId =
      typeof body.projectId === 'string' && body.projectId.trim()
        ? body.projectId.trim().slice(0, 80)
        : crypto.randomUUID();
    const port =
      Number.isInteger(body.port) && (body.port as number) > 1024 && body.port !== 3000 ? (body.port as number) : 3001;
    const sandboxId = `u_${userId}_${projectId}`;
    const maxIterations = Number.isInteger(body.maxIterations)
      ? Math.min(Math.max(body.maxIterations as number, 1), 6)
      : undefined;

    // FIX model call: the user's OpenRouter key if present, else the platform key — routed to
    // a strong coding model (free-first).
    const providerCtx = resolveProviderContext(req.apiKeys?.openRouterKey as string | undefined, 'openrouter');
    const complete = async (prompt: string): Promise<string> => {
      let model: string;
      try {
        model = await pickCodingModel();
      } catch {
        model = TEXT_FALLBACK;
      }
      const result = await runChat({
        provider: 'openrouter',
        apiKey: providerCtx.apiKey,
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        maxTokens: 8000,
        fallbackModel: TEXT_FALLBACK,
        timeoutMs: STUDIO_REQUEST_TIMEOUT_MS
      });
      return result.text || '';
    };

    // Open the SSE stream and drive the build.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const sse = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    let runId: string | undefined;
    try {
      const { data } = await getSupabaseAdmin()
        .from('studio_runs')
        .insert({ user_id: userId, project_id: projectId, sandbox_id: sandboxId, status: 'starting' })
        .select('id')
        .single();
      runId = data?.id;
    } catch (err) {
      console.warn('[studio] run record skipped:', (err as Error)?.message);
    }
    sse('start', { runId, projectId, sandboxId });

    const initialFiles = Object.fromEntries(files.map((f) => [f.path, f.content]));
    const run = createWorkerRun({ sandboxId, install: body.install, dev: body.dev, port });
    const fix = createStudioFix(complete);

    const result = await runBuildAgent(
      initialFiles,
      { run, fix, onEvent: (event) => sse(event.stage, event) },
      maxIterations ? { maxIterations } : {}
    );

    // Persist final run state + the (possibly fixed) project.
    try {
      const admin = getSupabaseAdmin();
      if (runId) {
        await admin
          .from('studio_runs')
          .update({ status: result.ok ? 'live' : 'error', preview_url: result.previewUrl })
          .eq('id', runId);
      }
      await saveProject({
        userId,
        projectId,
        name: deriveProjectName(body.title, files),
        template: typeof body.template === 'string' ? body.template : 'react-ts',
        files: Object.entries(result.files).map(([path, content]) => ({ path, content })),
        versionLabel: 'agentic build',
        createdBy: 'agent'
      });
    } catch (err) {
      console.warn('[studio] build persist skipped:', (err as Error)?.message);
    }

    sse('result', {
      ok: result.ok,
      reason: result.reason,
      iterations: result.iterations,
      previewUrl: result.previewUrl,
      runId
    });
    res.end();
  } catch (err) {
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error)?.message || 'Build failed.' })}\n\n`);
      res.end();
    } else {
      next(err);
    }
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

    await callStudioWorker({ action: 'stop', sandboxId: run.sandbox_id }).catch(() => null);

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

// GET /api/studio/:id/logs — live build/dev logs from the running container. Backed by the
// Worker's `logs` action (reads the dev process's stdout/stderr). This is the signal the
// agentic build loop (Phase 4) reads to self-correct, and what the in-app log panel shows.
studioRouter.get('/:id/logs', async (req, res, next) => {
  try {
    if (notConfigured()) return res.status(503).json(notConfiguredResponse);
    const userId = req.user!.id;
    const { data: run } = await getSupabaseAdmin()
      .from('studio_runs')
      .select('sandbox_id')
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .single();
    if (!run?.sandbox_id) return res.status(404).json({ error: { message: 'Run not found.' } });

    const worker = await callStudioWorker({ action: 'logs', sandboxId: run.sandbox_id });
    if (!worker.ok || worker.json?.status === 'error') {
      return res.status(502).json({
        error: { message: worker.json?.message || `Studio worker logs failed (HTTP ${worker.status}).`, code: 'STUDIO_WORKER_ERROR' }
      });
    }
    return res.json({
      stdout: typeof worker.json?.stdout === 'string' ? worker.json.stdout : '',
      stderr: typeof worker.json?.stderr === 'string' ? worker.json.stderr : '',
      processes: worker.json?.processes
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/studio/deploy — one-click deploy to a public URL (Phase 6). The build/publish
// step runs in the Cloudflare Worker, so until the owner deploys it (Phase 0/1) this is
// honestly pending rather than pretending to deploy. GitHub sync (above) works today.
studioRouter.post('/deploy', (_req, res) => {
  res.status(501).json({
    error: {
      message: notConfigured()
        ? 'One-click deploy lands with the Cloudflare Worker (deploy it to enable). Until then, push to GitHub and deploy from there.'
        : 'Deploy publishing is not wired in this build yet; push to GitHub and connect Pages/Workers to that repo.',
      code: 'STUDIO_DEPLOY_PENDING'
    }
  });
});

// --- Saved projects (Phase 5 persistence) -----------------------------------------

// GET /api/studio/projects — the user's saved projects (most recent first).
studioRouter.get('/projects', async (req, res, next) => {
  try {
    res.json({ projects: await listProjects(req.user!.id) });
  } catch (err) {
    next(err);
  }
});

// GET /api/studio/projects/:id — a project with its current file tree.
studioRouter.get('/projects/:id', async (req, res, next) => {
  try {
    const data = await getProjectWithFiles(req.user!.id, req.params.id);
    if (!data) return res.status(404).json({ error: { message: 'Project not found.' } });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/studio/projects/:id/versions — version history (most recent first).
studioRouter.get('/projects/:id/versions', async (req, res, next) => {
  try {
    const versions = await listVersions(req.user!.id, req.params.id);
    if (versions === null) return res.status(404).json({ error: { message: 'Project not found.' } });
    res.json({ versions });
  } catch (err) {
    next(err);
  }
});

// GET /api/studio/projects/:id/versions/:versionId — a version's file tree (for restore).
studioRouter.get('/projects/:id/versions/:versionId', async (req, res, next) => {
  try {
    const files = await getVersionFiles(req.user!.id, req.params.id, req.params.versionId);
    if (files === null) return res.status(404).json({ error: { message: 'Version not found.' } });
    res.json({ files });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/studio/projects/:id
studioRouter.delete('/projects/:id', async (req, res, next) => {
  try {
    const ok = await deleteProject(req.user!.id, req.params.id);
    if (!ok) return res.status(404).json({ error: { message: 'Project not found.' } });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});
