import 'dotenv/config'; // Load env vars before anything else
import express from 'express';
import cors from 'cors';
import compression from 'compression';

import {
  COMICFORGE_ENABLED,
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
import { attachFreeOnly } from './middleware/freeOnly.js';
import { errorHandler } from './middleware/errors.js';
import { optionalAuth, requireAuth } from './middleware/auth.js';
import { assistantLimits } from './middleware/assistantLimits.js';
import { createRateLimit } from './middleware/rateLimit.js';
import { attachRequestContext, requestLogger } from './middleware/requestContext.js';
import { applySecurityHeaders } from './middleware/security.js';
import { assistantRouter } from './routes/assistant.js';
import { chatRouter } from './routes/chat.js';
import { textRouter } from './routes/text.js';
import { imageRouter } from './routes/image.js';
import { visionRouter } from './routes/vision.js';
import { systemRouter } from './routes/system.js';
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
import { invitesRouter } from './routes/invites.js';
import { accountRouter } from './routes/account.js';
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
  res.json({ status: 'ok' });
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
app.use('/api/assistant', optionalAuth, assistantLimits, assistantRouter);
app.use('/api/billing', systemRateLimit, optionalAuth, billingRouter);

// Share token validation needs optionalAuth (returns loginRequired hint if not authenticated)
app.use('/api/shares/token', optionalAuth, systemRateLimit, sharingRouter);

// Outbound MCP server (Phase 10): external agents (Claude/Cursor/…) call our tool
// registry as an MCP endpoint. Authenticated by a bearer token (NOT the app session),
// so it must mount BEFORE the global requireAuth. Rate-limited like other public routes.
app.use('/api/connect', systemRateLimit, mcpOutboundRouter);

// Protect all API routes
app.use('/api', requireAuth);

app.use('/api/admin', adminRateLimit, adminRouter);
app.use('/api/admin/verification', adminRateLimit, verificationRouter);
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

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`DreamStream API listening on :${PORT}`);
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
