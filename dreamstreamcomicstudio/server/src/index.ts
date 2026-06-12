import 'dotenv/config'; // Load env vars before anything else
import express from 'express';
import cors from 'cors';
import compression from 'compression';

import {
  COMICFORGE_ENABLED,
  EMAIL_HMAC_SECRET,
  EMAIL_WORKER_URL,
  isAllowedOrigin,
  MAX_BODY_SIZE,
  PORT,
  RATE_LIMIT_IMAGE_MAX_REQUESTS,
  RATE_LIMIT_SYSTEM_MAX_REQUESTS,
  RATE_LIMIT_TEXT_MAX_REQUESTS,
  RATE_LIMIT_VISION_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
  REDIS_URL,
  TRUST_PROXY,
  validateRuntimeConfig
} from './config.js';
import { attachKeys } from './middleware/keys.js';
import { attachAccountKeys } from './middleware/accountKeys.js';
import { attachFreeOnly } from './middleware/freeOnly.js';
import { errorHandler } from './middleware/errors.js';
import { optionalAuth, requireAuth } from './middleware/auth.js';
import { assistantLimits } from './middleware/assistantLimits.js';
import { createRateLimit } from './middleware/rateLimit.js';
import { attachRequestContext, requestLogger } from './middleware/requestContext.js';
import { applySecurityHeaders } from './middleware/security.js';
import { assistantRouter } from './routes/assistant.js';
import { chatPublicRouter, chatRouter } from './routes/chat.js';
import { textRouter } from './routes/text.js';
import { imageRouter } from './routes/image.js';
import { visionRouter } from './routes/vision.js';
import { systemRouter } from './routes/system.js';
import { usageRouter } from './routes/usage.js';
import { attachAccountContext } from './lib/accountContext.js';
import { setUsageCloudSink } from './lib/providerUsage.js';
import { getSupabaseAdmin } from './services/supabase.js';
import webhookRouter from './routes/webhook.js';
import { billingRouter } from './routes/billing.js';
import { adminRouter } from './routes/admin.js';
import { verificationRouter } from './routes/verification.js';
import { moderationRouter } from './routes/moderation.js';
import { sharingRouter } from './routes/sharing.js';
import { comicForgeRouter } from './routes/comicforge.js';
import { studioRouter } from './routes/studio.js';
import { agentsRouter } from './routes/agents.js';
import { recipesRouter } from './routes/recipes.js';
import { mcpRouter, mcpOutboundRouter } from './routes/mcp.js';
import { modelsRouter } from './routes/models.js';
import { telemetryRouter } from './routes/telemetry.js';
import { newsletterRouter } from './routes/newsletter.js';
import { emailRouter } from './routes/email.js';
import { adminEmailRouter } from './routes/adminEmail.js';
import { modelBenchRouter } from './routes/modelBench.js';
import { requireAdmin } from './middleware/requireAdmin.js';
import { invitesRouter } from './routes/invites.js';
import { accountRouter } from './routes/account.js';
import { learnRouter } from './routes/learn.js';
import { prewarmCatalog, startCatalogRefreshLoop } from './services/modelCatalog.js';
import { keysRouter } from './routes/keys.js';
import { venturesRouter } from './routes/ventures.js';
import { startInlineVenturesRunner } from './ventures/inlineRunner.js';

validateRuntimeConfig();

const app = express();

app.disable('x-powered-by');
if (TRUST_PROXY !== false) {
  app.set('trust proxy', TRUST_PROXY);
}

app.use(attachRequestContext);
app.use(requestLogger);
app.use(applySecurityHeaders);
// Gzip responses — the model catalog is a large JSON payload (~440KB uncompressed); compressing it
// to a fraction of that prevents slow transfers and the intermittent HTTP/2 stream resets they cause.
// Explicitly skip Server-Sent Event streams (chat/generation), where buffering would stall delivery.
app.use(
  compression({
    filter: (req, res) => {
      if (res.getHeader('Content-Type')?.toString().includes('text/event-stream')) return false;
      return compression.filter(req, res);
    }
  })
);
app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }

      const corsError = new Error(`CORS blocked for origin: ${origin}`) as Error & {
        status?: number;
        publicCode?: string;
      };
      corsError.status = 403;
      corsError.publicCode = 'FORBIDDEN';
      callback(corsError);
    },
    credentials: true
  })
);

// Webhook must be before express.json() to get raw body
app.use('/api/webhook', express.raw({ type: 'application/json' }), webhookRouter);

app.use(express.json({ limit: MAX_BODY_SIZE }));
app.use(attachKeys);
app.use(attachFreeOnly);

const systemRateLimit = createRateLimit({
  scope: 'system',
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: RATE_LIMIT_SYSTEM_MAX_REQUESTS
});
const textRateLimit = createRateLimit({
  scope: 'text',
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: RATE_LIMIT_TEXT_MAX_REQUESTS
});
const imageRateLimit = createRateLimit({
  scope: 'image',
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: RATE_LIMIT_IMAGE_MAX_REQUESTS
});
const visionRateLimit = createRateLimit({
  scope: 'vision',
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: RATE_LIMIT_VISION_MAX_REQUESTS
});
const comicForgeRateLimit = createRateLimit({
  scope: 'comicforge',
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: Math.max(30, Math.floor(RATE_LIMIT_TEXT_MAX_REQUESTS / 2))
});
const adminRateLimit = createRateLimit({
  scope: 'admin',
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: Math.max(30, Math.floor(RATE_LIMIT_SYSTEM_MAX_REQUESTS / 2))
});
const moderationRateLimit = createRateLimit({
  scope: 'moderation',
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: Math.max(30, Math.floor(RATE_LIMIT_SYSTEM_MAX_REQUESTS / 2))
});

app.get('/api/health', (_req, res) => {
  // email: 'configured' | 'dormant' — mirrors mailerConfigured() so the live process's view of
  // EMAIL_WORKER_URL/EMAIL_HMAC_SECRET is checkable from outside (no admin login, no log access).
  const emailConfigured = Boolean(EMAIL_WORKER_URL && EMAIL_HMAC_SECRET && !EMAIL_WORKER_URL.includes('<'));
  res.json({ status: 'ok', email: emailConfigured ? 'configured' : 'dormant' });
});

// Public routes
app.use('/api/system', systemRateLimit, systemRouter);
app.use('/api/models', systemRateLimit, modelsRouter);
// BYOK key validation — read-only provider checks, no app login required.
app.use('/api/keys', systemRateLimit, keysRouter);
// Telemetry + feedback capture. Public + optionalAuth so failures that happen
// while logged-out (or while auth itself is failing) are still recorded; userId
// is attached when a valid session is present.
app.use('/api/telemetry', systemRateLimit, optionalAuth, telemetryRouter);
// Newsletter / waitlist capture with double opt-in (public, logged-out). optionalAuth so a
// signed-in user's id is attached when present; mounted before requireAuth.
app.use('/api/newsletter', systemRateLimit, optionalAuth, newsletterRouter);
// Email open-tracking pixel (public — fetched by the recipient's mail client, no session).
app.use('/api/email', systemRateLimit, optionalAuth, emailRouter);
app.use('/api/assistant', optionalAuth, assistantLimits, assistantRouter);
app.use('/api/billing', systemRateLimit, optionalAuth, billingRouter);

// Share token validation needs optionalAuth (returns loginRequired hint if not authenticated)
app.use('/api/shares/token', optionalAuth, systemRateLimit, sharingRouter);

// Outbound MCP server (Phase 10): external agents (Claude/Cursor/…) call our tool
// registry as an MCP endpoint. Authenticated by a bearer token (NOT the app session),
// so it must mount BEFORE the global requireAuth. Rate-limited like other public routes.
app.use('/api/connect', systemRateLimit, mcpOutboundRouter);

// Provider usage snapshot (counts only — no keys/queries). Public read like /api/system.
app.use('/api/usage', systemRateLimit, usageRouter);

// Pure data endpoints for live widgets (tool-refresh), reader-mode article
// extraction and link unfurl. optionalAuth BEFORE the global requireAuth: a
// stale/expired session token must degrade a dashboard to anonymous data, not
// kill every tile with a 401. Keyless tools, budget-guarded + rate-limited.
app.use('/api/chat', systemRateLimit, optionalAuth, attachAccountContext, chatPublicRouter);

// Protect all API routes
app.use('/api', requireAuth);
// Per-request account context (AsyncLocalStorage) so deep tool code — e.g. the
// provider usage meter — can attribute upstream API calls to the signed-in account.
app.use('/api', attachAccountContext);
// Account-level BYOK: fill provider keys from the user's encrypted account store
// wherever the request didn't carry one, so every studio and device shares the
// same keys (header > account > platform env).
app.use('/api', attachAccountKeys);

// Persist account-wise provider usage to Supabase (append-only deltas, ~60s flush).
// Best-effort: without a service-role key this stays in-memory only.
try {
  setUsageCloudSink(async (rows) => {
    const { error } = await getSupabaseAdmin().from('provider_usage_log').insert(rows);
    if (error) throw new Error(error.message);
  });
} catch {
  console.warn('[provider-usage] cloud sink not configured (no Supabase admin) — usage stays in-memory');
}

app.use('/api/admin', adminRateLimit, adminRouter);
app.use('/api/admin/verification', adminRateLimit, verificationRouter);
// Admin Email Console (templates/preview/test/send/invite). Admin-only.
app.use('/api/admin/email', adminRateLimit, requireAdmin, adminEmailRouter);
// Admin model bench — in-app trigger + results for the all-models live test.
app.use('/api/admin/model-bench', adminRateLimit, requireAdmin, modelBenchRouter);
app.use('/api/moderation', moderationRateLimit, moderationRouter);
app.use('/api/text', textRateLimit, textRouter);
app.use('/api/chat', textRateLimit, chatRouter);
app.use('/api/image', imageRateLimit, imageRouter);
app.use('/api/vision', visionRateLimit, visionRouter);
app.use('/api/shares', systemRateLimit, sharingRouter);
app.use('/api/v1/comicforge', comicForgeRateLimit, comicForgeRouter);
// Studio v2 control plane — auth'd (global requireAuth above), text-tier rate limited.
app.use('/api/studio', textRateLimit, studioRouter);
app.use('/api/agents', systemRateLimit, agentsRouter);
app.use('/api/recipes', textRateLimit, recipesRouter);
app.use('/api/mcp', systemRateLimit, mcpRouter);
// Autopilot control plane (Epic A1). Flag-gated + admin-only until GA (see ventures router).
app.use('/api/ventures', systemRateLimit, venturesRouter);
// Tester invite redemption (authenticated users).
app.use('/api/invites', systemRateLimit, invitesRouter);
// Account: server-side encrypted BYOK key storage (authenticated).
app.use('/api/account', systemRateLimit, accountRouter);
// Learning execution (sandboxed SQL playground). Auth'd + text-tier rate limited.
app.use('/api/learn', textRateLimit, learnRouter);

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`DreamStream API listening on :${PORT}`);
  // The mailer is dormant-by-design when unconfigured and skips sends WITHOUT logging to
  // email_log, so say so loudly here — otherwise "no emails and no errors" is undebuggable.
  if (EMAIL_WORKER_URL && EMAIL_HMAC_SECRET && !EMAIL_WORKER_URL.includes('<')) {
    console.log(`[email] mailer configured → ${EMAIL_WORKER_URL}`);
  } else {
    const missing = [
      !EMAIL_WORKER_URL || EMAIL_WORKER_URL.includes('<') ? 'EMAIL_WORKER_URL' : '',
      !EMAIL_HMAC_SECRET ? 'EMAIL_HMAC_SECRET' : ''
    ].filter(Boolean);
    console.warn(`[email] mailer DORMANT — all sends are silently skipped. Missing env: ${missing.join(', ')} (see docs/email/SETUP.md)`);
  }
  // Warm the model catalog from the durable index immediately so the first /api/models/catalog
  // request is instant (no slow live fetch on a cold start), then keep it warm in the background.
  void prewarmCatalog();
  startCatalogRefreshLoop();
  // Autopilot pilot loop (in-process). No-op unless VENTURES_ENABLED && VENTURES_PILOT_INLINE.
  startInlineVenturesRunner();
});

// Run the ComicForge worker in-process when the feature is enabled and a queue is
// configured. Without this, enqueued generation jobs would sit `queued` forever unless
// the standalone `comicforge:worker` process is deployed separately. Failures here must
// never take down the API, so they are caught and logged.
if (COMICFORGE_ENABLED && REDIS_URL.trim()) {
  import('./comicforge/worker.js')
    .then(({ startComicForgeWorker }) => startComicForgeWorker())
    .then(() => console.log('[ComicForge] In-process worker started'))
    .catch((error) => {
      console.error('[ComicForge] Failed to start in-process worker', (error as Error)?.message || error);
    });
}
