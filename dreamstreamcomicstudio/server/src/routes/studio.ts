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
  STUDIO_REQUEST_TIMEOUT_MS,
  NVIDIA_TEXT_MODEL
} from '../config.js';
import type { AIProviderId } from '../ai/providers/types.js';
import type { StudioBuildPlan, StudioAnswer } from '../../../apiTypes.js';
import { getSupabaseAdmin } from '../services/supabase.js';
import { callStudioWorker, studioConfigured } from '../services/studioWorker.js';
import { normalizeTarget, deployViaWorker, recordDeployment } from '../services/studioDeploy.js';
import { createWorkerRun, createStudioFix } from '../services/studioBuildService.js';
import { evaluateLaunchAllowed } from '../services/studioCaps.js';
import { sanitizeFiles, deriveProjectName } from '../services/studioFiles.js';
import { saveProject, listProjects, getProjectWithFiles, deleteProject, listVersions, getVersionFiles, listDeployments } from '../services/studioRepository.js';
import { runBuildAgent } from '../ai/studio/buildAgent.js';
import { runGenerate, buildGeneratePrompt, parseGeneratedApp, STRICT_JSON_REMINDER, reviewCompleteness, repairUntilClean } from '../ai/studio/studioGenerate.js';
import { runClarify } from '../ai/studio/studioClarify.js';
import { runSuggest } from '../ai/studio/studioSuggest.js';
import { runPlan } from '../ai/studio/studioPlan.js';
import { runStudioAgentsParallel, sanitizeAgentIds, studioAgentCatalog, STUDIO_AGENTS } from '../ai/studio/studioAgents.js';
import { resolveTools } from '../ai/tools/registry.js';
import { buildMcpTools } from '../ai/tools/mcpClient.js';
import { makeImageTool, imageGenAvailable, type ImageKeys } from '../ai/tools/imageGen.js';
import { enabledMcpConfigs } from '../services/mcpRegistry.js';
import { ALWAYS_ON_STUDIO_MCP_SERVERS, envDesignMcpServers, externalMcpEnabled } from '../ai/studio/designSystem.js';
import { scanStreamedFiles } from '../ai/studio/streamParse.js';
import { verifyGeneratedApp } from '../ai/studio/verifyApp.js';
import { pickCodingModel, TEXT_FALLBACK } from '../ai/autoRouter.js';
import { runChat } from '../ai/chat.js';
import { resolveProviderContext } from '../ai/gateway.js';
import { studioGithubRouter } from './studioGithub.js';

export const studioRouter = Router();

// GitHub two-way sync (Phase 6) — /api/studio/github/{repos,push,pull}.
studioRouter.use('/github', studioGithubRouter);

// GET /api/studio/status — does the live agentic build path actually work on THIS server?
// The client's mode badge reads this to honestly show "Agentic · live" vs "One-shot mode" instead
// of trusting only the build-time flag (which can be on while the Worker is still unconfigured).
// Read-only, no side effects.
studioRouter.get('/status', (_req, res) => {
  res.json({ liveConfigured: studioConfigured() });
});

const notConfigured = (): boolean => !studioConfigured();

const notConfiguredResponse = {
  error: {
    message: 'Live Studio is not configured on this server yet (set STUDIO_WORKER_URL and STUDIO_HMAC_SECRET).',
    code: 'STUDIO_NOT_CONFIGURED'
  }
};

// --- Code Studio model routing -----------------------------------------------------
// Code Studio picks its coding model INDEPENDENTLY of the comics/chat selection. By default
// it free-first auto-picks a proven coder; the client may pin a specific model + source (and
// tune spend preference / creativity) via the request body. Source routing mirrors the chat
// route: an explicit source wins when its key is present, else we fall back to whichever key
// exists (OpenRouter preferred, then NVIDIA).

type StudioCostPref = 'free' | 'cheap' | 'quality';
// Generation leans creative (ambitious, complete apps); fixes stay precise/deterministic.
const STUDIO_GEN_TEMPERATURE = 0.6;
const STUDIO_FIX_TEMPERATURE = 0.2;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
// Default to the STRONGEST available coder ('quality') — weak free coders can't build real apps.
// An explicit 'free'/'cheap' from the client is still honored.
const normCostPref = (p?: string): StudioCostPref => (p === 'cheap' || p === 'free' || p === 'quality' ? p : 'quality');
const studioTemp = (t: unknown, fallback: number): number =>
  typeof t === 'number' && Number.isFinite(t) ? clamp01(t) : fallback;

/** Resolve the provider + key for a studio request, honoring an explicit `source`. */
const resolveStudioProvider = (
  keys: { openRouterKey?: string | null; nvidiaKey?: string | null } | undefined,
  requestedSource?: string
): { provider: AIProviderId; apiKey: string } | null => {
  const source = String(requestedSource || '').trim().toLowerCase();
  const openRouterKey = (keys?.openRouterKey || undefined) as string | undefined;
  const nvidiaKey = (keys?.nvidiaKey || undefined) as string | undefined;
  if (source === 'nvidia' && nvidiaKey) return { provider: 'nvidia', apiKey: nvidiaKey };
  if (source === 'openrouter' && openRouterKey) return { provider: 'openrouter', apiKey: openRouterKey };
  if (openRouterKey) return { provider: 'openrouter', apiKey: openRouterKey };
  if (nvidiaKey) return { provider: 'nvidia', apiKey: nvidiaKey };
  return null;
};

/** A user-pinned model id wins; otherwise auto-pick the strongest coder for the provider. */
const resolveStudioCodingModel = async (
  provider: AIProviderId,
  requestedModel?: string,
  costPref?: string
): Promise<string> => {
  const pinned = typeof requestedModel === 'string' ? requestedModel.trim() : '';
  if (pinned) return pinned;
  const pref = normCostPref(costPref);
  if (provider === 'nvidia') {
    try {
      return await pickCodingModel({ costPref: pref, filter: (m) => m.source === 'nvidia' });
    } catch {
      return NVIDIA_TEXT_MODEL;
    }
  }
  try {
    return await pickCodingModel({ costPref: pref });
  } catch {
    return TEXT_FALLBACK;
  }
};

// A run with ended_at IS NULL only counts toward the concurrency cap if it started recently.
// Containers idle-sleep long before this; without the bound, a build/launch row that never got
// closed (client navigated away, worker hiccup, or a build that didn't set ended_at) would block
// the user from EVER building again with a spurious 429. 30 min is comfortably past idle-sleep.
const ACTIVE_RUN_WINDOW_MS = 30 * 60 * 1000;

/** The user's current Studio usage, for cap enforcement. */
const getUsage = async (userId: string): Promise<{ activeRuns: number; dailyAwakeSeconds: number }> => {
  const admin = getSupabaseAdmin();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const activeSince = new Date(Date.now() - ACTIVE_RUN_WINDOW_MS).toISOString();
  const [active, daily] = await Promise.all([
    admin.from('studio_runs').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).is('ended_at', null).gte('started_at', activeSince),
    admin.from('studio_runs').select('awake_seconds').eq('user_id', userId).gte('started_at', startOfDay.toISOString())
  ]);
  const dailyAwakeSeconds = (daily.data || []).reduce(
    (n: number, r: { awake_seconds: number | null }) => n + (r.awake_seconds || 0),
    0
  );
  return { activeRuns: active.count || 0, dailyAwakeSeconds };
};

// Shared: resolve provider + a coding-model `complete()` for the non-streaming flow stages
// (clarify, plan). Returns null when no key is configured.
// Research tools the planning stage may use to investigate real APIs, packages, repos and docs
// before it commits to a plan. resolveTools ignores unknown names, so this is safe to broaden.
const PLAN_RESEARCH_TOOLS = ['web_search', 'wiki_lookup', 'github_repo', 'npm_package', 'pypi_package', 'search_papers'];

// Always-on reference sources for Code Studio (curated in designSystem.ts): Context7 for live,
// version-correct library docs (so the team uses real Tailwind/shadcn/Framer Motion APIs, not
// hallucinated ones) + DeepWiki to read patterns from popular GitHub repos. Plus any design or
// API-connector MCPs an operator has self-hosted over HTTPS and pointed at via env vars
// (STUDIO_SHADCN_MCP_URL / STUDIO_MAGIC_MCP_URL / STUDIO_MAGICUI_MCP_URL / STUDIO_NANGO_MCP_URL).
// All are best-effort: an unreachable server yields no tools and never blocks a build.
const DEFAULT_STUDIO_MCP_SERVERS: { id: string; url: string; name?: string }[] = ALWAYS_ON_STUDIO_MCP_SERVERS;

// Tools for Code Studio's planner + agents: the always-on DeepWiki reference source + the user's
// configured MCP servers (saved + request), so the team gets the SAME extended access as chat
// (their MCPs + APIs). Best-effort + deduped by URL; network/registry hiccups never block a build.
const studioMcpTools = async (
  req: { user?: { id?: string }; },
  body: { mcpServers?: unknown }
) => {
  try {
    const requestServers = Array.isArray(body?.mcpServers)
      ? (body.mcpServers as { id?: unknown; url?: unknown }[]).filter((s) => s && typeof s.url === 'string' && typeof s.id === 'string')
      : [];
    const savedServers = req.user?.id ? await enabledMcpConfigs(req.user.id).catch(() => []) : [];
    // `trusted` lets operator-set servers (defaults + env) reach a self-hosted sidecar over
    // http/internal hosts; user-supplied servers stay behind the strict SSRF guard (no trusted flag).
    const byUrl = new Map<string, { id: string; url: string; name?: string; trusted?: boolean; headers?: Record<string, string> }>();
    // Always-on reference MCPs are THIRD-PARTY (send context off-box) — skip them when external MCP
    // is disabled for privacy. Operator self-hosted + user MCPs below are unaffected.
    if (externalMcpEnabled()) for (const s of DEFAULT_STUDIO_MCP_SERVERS) byUrl.set(s.url, s);
    // Operator-configured (self-hosted) design + API-connector MCPs, read fresh each call.
    for (const s of envDesignMcpServers()) byUrl.set(s.url, s);
    for (const s of [...savedServers, ...requestServers] as { id: string; url: string }[]) byUrl.set(s.url, s);
    const servers = [...byUrl.values()];
    return servers.length ? await buildMcpTools(servers as Parameters<typeof buildMcpTools>[0]) : [];
  } catch {
    return [];
  }
};

// Exported so the Autopilot intake route (A3) reuses the exact same model wiring (provider
// resolution + coding-model selection + runChat with fallback). Additive — no behavior change.
export const studioStageComplete = async (
  req: { apiKeys?: { openRouterKey?: string | null; nvidiaKey?: string | null } },
  body: { source?: string; model?: string; costPref?: string },
  maxTokens: number,
  toolNames?: string[],
  extraTools?: Awaited<ReturnType<typeof buildMcpTools>>
): Promise<((prompt: string) => Promise<string>) | null> => {
  const resolved = resolveStudioProvider(req.apiKeys, body.source);
  if (!resolved) return null;
  const model = await resolveStudioCodingModel(resolved.provider, body.model, body.costPref);
  return async (prompt: string): Promise<string> => {
    const tools = [...(toolNames && toolNames.length ? resolveTools(toolNames) : []), ...(extraTools || [])];
    const result = await runChat({
      provider: resolved.provider,
      apiKey: resolved.apiKey,
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      maxTokens,
      fallbackModel: resolved.provider === 'openrouter' ? TEXT_FALLBACK : undefined,
      timeoutMs: STUDIO_REQUEST_TIMEOUT_MS,
      ...(tools.length ? { tools } : {})
    });
    return result.text || '';
  };
};

const NO_MODEL_KEY = {
  error: {
    message: 'No coding model is available. Add an OpenRouter or NVIDIA key in Settings (free models work too).',
    code: 'STUDIO_NO_MODEL_KEY'
  }
};

// POST /api/studio/clarify — the CLARIFY stage: the AI decides what (if anything) it needs to ask
// the user before building, returning 0–4 structured questions (options + custom answers) and the
// assumptions it will otherwise make. Pure LLM; fast.
studioRouter.post('/clarify', async (req, res, next) => {
  try {
    const body = (req.body || {}) as { prompt?: string; files?: unknown; source?: string; model?: string; costPref?: string };
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return res.status(400).json({ error: { message: 'A prompt describing the app is required.' } });
    const complete = await studioStageComplete(req, body, 1200);
    if (!complete) return res.status(400).json(NO_MODEL_KEY);
    // Refine mode: when the client sends the current files, clarify asks app-aware follow-ups
    // (and is tuned to ask nothing for clear changes) instead of new-build questions.
    const files = sanitizeFiles(body.files);
    const ctx = files.length ? { mode: 'refine' as const, files: files.map((f) => ({ path: f.path })) } : undefined;
    try {
      const result = await runClarify(prompt, complete, ctx);
      return res.json(result);
    } catch {
      // Never block the build on a clarify hiccup — just skip straight to building.
      return res.json({ questions: [], assumptions: [] });
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/studio/suggest — the SUGGEST stage: real, app-specific "what to build next"
// recommendations derived from the ACTUAL code (replaces the old hardcoded chips). Pure LLM; fast.
// Any hiccup returns an empty list so the client falls back to its local heuristic — never blocks.
studioRouter.post('/suggest', async (req, res, next) => {
  try {
    const body = (req.body || {}) as { title?: string; files?: unknown; source?: string; model?: string; costPref?: string };
    const files = sanitizeFiles(body.files).map((f) => ({ path: f.path, content: f.content }));
    if (!files.length) return res.json({ suggestions: [] });
    const complete = await studioStageComplete(req, body, 1100);
    if (!complete) return res.json({ suggestions: [] });
    try {
      const result = await runSuggest({ title: typeof body.title === 'string' ? body.title : undefined, files }, complete);
      return res.json(result);
    } catch {
      return res.json({ suggestions: [] });
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/studio/plan — the PLAN stage: turn the idea (+ the user's answers) into a concrete,
// reviewable build plan (summary, stack, features, file tree, data sources). Pure LLM.
studioRouter.post('/plan', async (req, res, next) => {
  try {
    const body = (req.body || {}) as { prompt?: string; answers?: StudioAnswer[]; source?: string; model?: string; costPref?: string; mcpServers?: unknown };
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return res.status(400).json({ error: { message: 'A prompt describing the app is required.' } });
    // The planning stage researches real APIs/packages/repos with tools (incl. the user's MCPs).
    const mcp = await studioMcpTools(req, body);
    const complete = await studioStageComplete(req, body, 2000, PLAN_RESEARCH_TOOLS, mcp);
    if (!complete) return res.status(400).json(NO_MODEL_KEY);
    const answers = Array.isArray(body.answers) ? body.answers : undefined;
    const plan = await runPlan(prompt, answers, complete);
    if (!plan) {
      return res.status(502).json({ error: { message: 'Could not draft a build plan. Try rephrasing your idea.', code: 'STUDIO_PLAN_INVALID' } });
    }
    return res.json({ plan });
  } catch (err) {
    next(err);
  }
});

// POST /api/studio/generate — turn a plain-language idea into a runnable app artifact, right
// inside the studio (no chat hand-off). Pure LLM (no sandbox/worker), so it works whenever a
// coding key is configured; the live cloud run (/build, /launch) is a separate upgrade. Auth +
// the global key middleware apply. Also handles "refine" when current files are sent along.
studioRouter.post('/generate', async (req, res, next) => {
  try {
    const body = (req.body || {}) as {
      prompt?: string; template?: string; files?: unknown; title?: string;
      model?: string; source?: string; costPref?: string; temperature?: number;
      plan?: StudioBuildPlan; answers?: StudioAnswer[]; designPreset?: string;
    };
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      return res.status(400).json({ error: { message: 'A prompt describing the app is required.' } });
    }

    const resolved = resolveStudioProvider(req.apiKeys, body.source);
    if (!resolved) {
      return res.status(400).json({
        error: {
          message: 'No coding model is available. Add an OpenRouter or NVIDIA key in Settings (free models work too).',
          code: 'STUDIO_NO_MODEL_KEY'
        }
      });
    }

    const model = await resolveStudioCodingModel(resolved.provider, body.model, body.costPref);
    const temperature = studioTemp(body.temperature, STUDIO_GEN_TEMPERATURE);

    const currentFiles = sanitizeFiles(body.files).map((f) => ({ path: f.path, content: f.content }));

    const complete = async (genPrompt: string): Promise<string> => {
      const result = await runChat({
        provider: resolved.provider,
        apiKey: resolved.apiKey,
        model,
        messages: [{ role: 'user', content: genPrompt }],
        temperature,
        maxTokens: 16000,
        fallbackModel: resolved.provider === 'openrouter' ? TEXT_FALLBACK : undefined,
        timeoutMs: STUDIO_REQUEST_TIMEOUT_MS
      });
      return result.text || '';
    };

    const artifact = await runGenerate(complete, {
      prompt,
      template: body.template,
      currentFiles: currentFiles.length ? currentFiles : undefined,
      currentTitle: typeof body.title === 'string' ? body.title : undefined,
      plan: currentFiles.length ? undefined : body.plan,
      answers: currentFiles.length ? undefined : (Array.isArray(body.answers) ? body.answers : undefined),
      designPreset: typeof body.designPreset === 'string' ? body.designPreset : undefined
    });
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

// POST /api/studio/generate/stream — the same generation as /generate, but streamed over SSE so
// the studio can show the build happening *synchronously*: a live activity feed where each file
// appears ("writing /App.tsx") and resolves ("written, 1.2 KB") as the model emits it. This is the
// non-gated, pure-LLM path (no worker needed). The client falls back to the blocking /generate if
// the stream isn't available. Auth + the global key middleware apply.
studioRouter.post('/generate/stream', async (req, res, next) => {
  try {
    const body = (req.body || {}) as {
      prompt?: string; template?: string; files?: unknown; title?: string;
      model?: string; source?: string; costPref?: string; temperature?: number;
      plan?: StudioBuildPlan; answers?: StudioAnswer[]; designPreset?: string;
    };
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      return res.status(400).json({ error: { message: 'A prompt describing the app is required.' } });
    }

    const resolved = resolveStudioProvider(req.apiKeys, body.source);
    if (!resolved) {
      return res.status(400).json({
        error: {
          message: 'No coding model is available. Add an OpenRouter or NVIDIA key in Settings (free models work too).',
          code: 'STUDIO_NO_MODEL_KEY'
        }
      });
    }

    const model = await resolveStudioCodingModel(resolved.provider, body.model, body.costPref);
    const temperature = studioTemp(body.temperature, STUDIO_GEN_TEMPERATURE);

    const currentFiles = sanitizeFiles(body.files).map((f) => ({ path: f.path, content: f.content }));
    const refining = currentFiles.length > 0;
    const genInput = {
      prompt,
      template: body.template,
      currentFiles: refining ? currentFiles : undefined,
      currentTitle: typeof body.title === 'string' ? body.title : undefined,
      plan: refining ? undefined : body.plan,
      answers: refining ? undefined : (Array.isArray(body.answers) ? body.answers : undefined),
      designPreset: typeof body.designPreset === 'string' ? body.designPreset : undefined
    };
    const genPrompt = buildGeneratePrompt(genInput);

    // Open the SSE stream.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const sse = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    sse('start', { refining });
    sse('phase', { label: refining ? 'Reading your current app…' : 'Designing your app…' });

    // Stream the model's tokens; as files appear in the JSON, emit live file events.
    let acc = '';
    const writingSeen = new Set<string>();
    const writtenSeen = new Set<string>();
    let announcedWriting = false;
    const onDelta = (delta: { content?: string }) => {
      if (!delta.content) return;
      acc += delta.content;
      const files = scanStreamedFiles(acc);
      if (files.length && !announcedWriting) {
        announcedWriting = true;
        sse('phase', { label: refining ? 'Applying your changes…' : 'Writing files…' });
      }
      for (const f of files) {
        if (!writingSeen.has(f.path)) { writingSeen.add(f.path); sse('file', { path: f.path, status: 'writing' }); }
        if (f.complete && !writtenSeen.has(f.path)) {
          writtenSeen.add(f.path);
          sse('file', { path: f.path, status: 'written', bytes: f.bytes });
        }
      }
    };

    const complete = async (p: string, stream: boolean): Promise<string> => {
      const result = await runChat({
        provider: resolved.provider,
        apiKey: resolved.apiKey,
        model,
        messages: [{ role: 'user', content: p }],
        temperature,
        maxTokens: 16000,
        fallbackModel: resolved.provider === 'openrouter' ? TEXT_FALLBACK : undefined,
        timeoutMs: STUDIO_REQUEST_TIMEOUT_MS,
        ...(stream ? { onDelta } : {})
      });
      return result.text || '';
    };

    let text = (await complete(genPrompt, true)) || acc;
    let artifact = parseGeneratedApp(text, body.template);
    if (!artifact) {
      // One stricter, non-streamed retry (matches runGenerate's resilience).
      sse('phase', { label: 'Tightening the output…' });
      text = await complete(genPrompt + STRICT_JSON_REMINDER, false);
      artifact = parseGeneratedApp(text, body.template);
    }

    if (!artifact) {
      sse('error', { message: 'The model did not return a valid app. Try rephrasing your idea.' });
      return res.end();
    }

    // Verifier agent: statically check the generated app for the failure modes that break studio
    // apps (empty/placeholder files, missing React default export, invalid JSON, unresolved relative
    // imports) and auto-repair them in a LOOP — re-checking after each pass — so the user gets a
    // working app without clicking "fix", and a stubborn issue gets more than one attempt.
    try {
      const before = verifyGeneratedApp(artifact);
      if (before.length) {
        sse('phase', { label: `Verifying — fixing ${before.length} issue${before.length === 1 ? '' : 's'}…` });
        artifact = await repairUntilClean(
          (p) => complete(p, false),
          { prompt, template: body.template, currentFiles: artifact.files.map((f) => ({ path: f.path, content: f.content })), currentTitle: artifact.title },
          artifact,
          { onPass: ({ pass, issues }) => sse('phase', { label: `Verifying pass ${pass} — fixing ${issues.length} issue${issues.length === 1 ? '' : 's'}…` }) }
        );
        sse('phase', { label: verifyGeneratedApp(artifact).length ? 'Verified — applied fixes' : 'Verified ✓' });
      } else {
        sse('phase', { label: 'Verified ✓' });
      }
    } catch (err) {
      // Verification/repair is best-effort — never fail the generation over it.
      console.warn('[studio] verify/repair skipped:', (err as Error)?.message);
    }

    // Functional completeness self-review (new apps only): catch skeletons that "compile" but don't
    // actually implement the request, and complete them in one pass before handing over.
    if (!refining) {
      try {
        sse('phase', { label: 'Checking it actually works…' });
        const before = artifact.files.length;
        artifact = await reviewCompleteness((p) => complete(p, false), prompt, artifact, body.template);
        sse('phase', { label: artifact.files.length > before ? 'Filled in missing functionality ✓' : 'Looks complete ✓' });
      } catch (err) {
        console.warn('[studio] completeness review skipped:', (err as Error)?.message);
      }
    }

    sse('result', { artifact });
    return res.end();
  } catch (err) {
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error)?.message || 'Generation failed.' })}\n\n`);
      return res.end();
    }
    return next(err);
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
      model?: string;
      source?: string;
      costPref?: string;
      temperature?: number;
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

    // FIX model call: honors the studio's chosen coding model + source (BYOK key if present,
    // else the platform key). Defaults to a strong coding model, free-first.
    const resolved = resolveStudioProvider(req.apiKeys, body.source)
      ?? { provider: 'openrouter' as AIProviderId, apiKey: resolveProviderContext(undefined, 'openrouter').apiKey };
    const fixModel = await resolveStudioCodingModel(resolved.provider, body.model, body.costPref);
    const fixTemperature = studioTemp(body.temperature, STUDIO_FIX_TEMPERATURE);
    const complete = async (prompt: string): Promise<string> => {
      const result = await runChat({
        provider: resolved.provider,
        apiKey: resolved.apiKey,
        model: fixModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: fixTemperature,
        maxTokens: 8000,
        fallbackModel: resolved.provider === 'openrouter' ? TEXT_FALLBACK : undefined,
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
        // A build that didn't end with a live preview URL has no running container — close the run
        // so it never counts against the concurrency cap. Live ones stay open (until Stop / the
        // active-run window expires them) so metering still sees them.
        const isLive = result.ok && !!result.previewUrl;
        await admin
          .from('studio_runs')
          .update({
            status: result.ok ? 'live' : 'error',
            preview_url: result.previewUrl,
            ...(isLive ? {} : { ended_at: new Date().toISOString() })
          })
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

// GET /api/studio/agents — the catalog of specialist refinement agents (for the UI).
studioRouter.get('/agents', (_req, res) => {
  res.json({ agents: studioAgentCatalog() });
});

// POST /api/studio/agents — multi-agent refinement. A team of specialist agents (architecture,
// code, frontend, ui, design, data, security, verification) sequentially reviews + refines the
// current app, each within its specialty, honoring the user's preferences. Pure LLM (no worker/
// sandbox), like /generate — works as soon as a coding key is configured. Live web/data tools are
// wired in for the data agent so it can research real APIs and wire LIVE data into the app.
// Streams a per-agent SSE trace and returns the refined files. Auth + the global key middleware apply.
studioRouter.post('/agents', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const body = (req.body || {}) as {
      projectId?: string; title?: string; template?: string; files?: unknown;
      prompt?: string; preferences?: string; agents?: unknown;
      model?: string; source?: string; costPref?: string; temperature?: number; mcpServers?: unknown;
    };

    const files = sanitizeFiles(body.files);
    if (!files.length) {
      return res.status(400).json({ error: { message: 'files[] (with path + content) is required.' } });
    }

    const resolved = resolveStudioProvider(req.apiKeys, body.source);
    if (!resolved) {
      return res.status(400).json({
        error: {
          message: 'No coding model is available. Add an OpenRouter or NVIDIA key in Settings (free models work too).',
          code: 'STUDIO_NO_MODEL_KEY'
        }
      });
    }

    const model = await resolveStudioCodingModel(resolved.provider, body.model, body.costPref);
    const temperature = studioTemp(body.temperature, STUDIO_GEN_TEMPERATURE);
    const agentIds = sanitizeAgentIds(body.agents);
    const preferences = [
      typeof body.prompt === 'string' ? body.prompt.trim() : '',
      typeof body.preferences === 'string' ? body.preferences.trim() : ''
    ].filter(Boolean).join('\n');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const sse = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // The user's MCP servers' tools — extended access for the whole agent team (built once).
    const mcp = await studioMcpTools(req, body);
    // BYOK image generation, bound to the user's own account keys (built once, used only by agents
    // that request 'generate_image' and only when a key is configured).
    const imageKeys = (req as { apiKeys?: ImageKeys }).apiKeys || {};
    // Each agent gets a focused model call; agents get their live web/data tools PLUS your MCP tools.
    const complete = async (prompt: string, toolNames: string[]): Promise<string> => {
      const img = imageGenAvailable(imageKeys) && toolNames.includes('generate_image') ? [makeImageTool(imageKeys)] : [];
      const tools = [...resolveTools(toolNames), ...mcp, ...img];
      const result = await runChat({
        provider: resolved.provider,
        apiKey: resolved.apiKey,
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        maxTokens: 8000,
        fallbackModel: resolved.provider === 'openrouter' ? TEXT_FALLBACK : undefined,
        timeoutMs: STUDIO_REQUEST_TIMEOUT_MS,
        ...(tools.length ? { tools } : {})
      });
      return result.text || '';
    };

    sse('plan', {
      model,
      source: resolved.provider,
      agents: agentIds.map((id) => ({ id, name: STUDIO_AGENTS[id].name }))
    });

    // Synthesis applies all reviewers' findings at once — precise (low temp) + room for full files.
    const synthesize = async (prompt: string): Promise<string> => {
      const result = await runChat({
        provider: resolved.provider,
        apiKey: resolved.apiKey,
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: STUDIO_FIX_TEMPERATURE,
        maxTokens: 16000,
        fallbackModel: resolved.provider === 'openrouter' ? TEXT_FALLBACK : undefined,
        timeoutMs: STUDIO_REQUEST_TIMEOUT_MS
      });
      return result.text || '';
    };

    const initial = Object.fromEntries(files.map((f) => [f.path, f.content]));
    // Parallel scored review → single synthesis ("Design Jury"): specialists critique + score
    // concurrently, one writer applies all findings, iterate up to 2 rounds until the ship bar.
    const result = await runStudioAgentsParallel(initial, agentIds, preferences, {
      review: complete,
      synthesize,
      onEvent: (e) => sse(e.stage, e),
      maxRounds: 2
    });

    // Persist the refined project (best-effort) so the workspace + history survive reloads.
    try {
      await saveProject({
        userId,
        projectId: typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim().slice(0, 80) : crypto.randomUUID(),
        name: deriveProjectName(body.title, files),
        template: typeof body.template === 'string' ? body.template : 'react-ts',
        files: Object.entries(result.files).map(([path, content]) => ({ path, content })),
        versionLabel: 'multi-agent refine',
        createdBy: 'agent'
      });
    } catch (err) {
      console.warn('[studio] agents persist skipped:', (err as Error)?.message);
    }

    sse('result', {
      files: Object.entries(result.files).map(([path, content]) => ({ path, content })),
      trace: result.trace,
      score: result.score
    });
    res.end();
  } catch (err) {
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error)?.message || 'Agent refinement failed.' })}\n\n`);
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

// POST /api/studio/deploy — one-click deploy to a public, permanent URL. The build + publish runs
// in the Studio Worker (it has wrangler + the Cloudflare token in its container); this route
// validates, derives a safe project name, delegates, persists, and returns an HONEST status. When
// the worker isn't configured it returns `unavailable` (200) so the client shows the working manual
// path (deploy bundle + commands) instead of a hard 501.
studioRouter.post('/deploy', async (req, res, next) => {
  try {
    const body = (req.body || {}) as { projectId?: string; title?: string; target?: string; files?: unknown };
    const target = normalizeTarget(body.target);
    const files = sanitizeFiles(body.files).map((f) => ({ path: f.path, content: f.content }));
    if (!files.length) return res.json({ status: 'error', message: 'No files to deploy — build an app first.' });

    if (!studioConfigured()) {
      return res.json({
        status: 'unavailable',
        message: 'One-click deploy needs the Studio Worker configured (STUDIO_WORKER_URL + STUDIO_HMAC_SECRET) with a Cloudflare token. Use the deploy bundle + the commands shown — they work today.'
      });
    }
    // Cloudflare Pages + Vercel both publish via the worker. Supabase is a backend/DB, not a static
    // host — guide the user to the (working) CLI steps + a frontend host instead of faking a deploy.
    if (target === 'supabase') {
      return res.json({
        status: 'unavailable',
        message: 'Supabase is a backend/DB, not a static host — provision it with the `supabase` CLI steps shown, then deploy the frontend to Cloudflare or Vercel.'
      });
    }

    await recordDeployment(body.projectId, target, 'building');
    const result = await deployViaWorker({ userId: req.user!.id, projectId: body.projectId, title: body.title, target, files });
    await recordDeployment(body.projectId, target, result.status, result.url);
    return res.json(result);
  } catch (err) {
    next(err);
  }
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
// GET /api/studio/projects/:id/deployments — the project's deploy history (most recent first).
studioRouter.get('/projects/:id/deployments', async (req, res, next) => {
  try {
    res.json({ deployments: await listDeployments(req.user!.id, req.params.id) });
  } catch (err) {
    next(err);
  }
});

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
