import 'dotenv/config'; // Load env vars before anything else
import express from 'express';
import cors from 'cors';

import {
  COMICFORGE_ENABLED,
  CORS_ORIGINS,
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
import { errorHandler } from './middleware/errors.js';
import { optionalAuth, requireAuth } from './middleware/auth.js';
import { assistantLimits } from './middleware/assistantLimits.js';
import { createRateLimit } from './middleware/rateLimit.js';
import { attachRequestContext, requestLogger } from './middleware/requestContext.js';
import { applySecurityHeaders } from './middleware/security.js';
import { assistantRouter } from './routes/assistant.js';
import { textRouter } from './routes/text.js';
import { imageRouter } from './routes/image.js';
import { visionRouter } from './routes/vision.js';
import { systemRouter } from './routes/system.js';
import webhookRouter from './routes/webhook.js';
import { billingRouter } from './routes/billing.js';
import { adminRouter } from './routes/admin.js';
import { moderationRouter } from './routes/moderation.js';
import { sharingRouter } from './routes/sharing.js';
import { comicForgeRouter } from './routes/comicforge.js';
import { modelsRouter } from './routes/models.js';

validateRuntimeConfig();

const app = express();

app.disable('x-powered-by');
if (TRUST_PROXY !== false) {
  app.set('trust proxy', TRUST_PROXY);
}

const allowedOrigins = new Set(CORS_ORIGINS);
app.use(attachRequestContext);
app.use(requestLogger);
app.use(applySecurityHeaders);
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) {
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
app.use('/api/assistant', optionalAuth, assistantLimits, assistantRouter);
app.use('/api/billing', systemRateLimit, optionalAuth, billingRouter);

// Share token validation needs optionalAuth (returns loginRequired hint if not authenticated)
app.use('/api/shares/token', optionalAuth, systemRateLimit, sharingRouter);

// Protect all API routes
app.use('/api', requireAuth);

app.use('/api/admin', adminRateLimit, adminRouter);
app.use('/api/moderation', moderationRateLimit, moderationRouter);
app.use('/api/text', textRateLimit, textRouter);
app.use('/api/image', imageRateLimit, imageRouter);
app.use('/api/vision', visionRateLimit, visionRouter);
app.use('/api/shares', systemRateLimit, sharingRouter);
app.use('/api/v1/comicforge', comicForgeRateLimit, comicForgeRouter);

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`DreamStream API listening on :${PORT}`);
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
