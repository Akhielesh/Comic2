import 'dotenv/config'; // Load env vars before anything else
import express from 'express';
import cors from 'cors';

import {
  CORS_ORIGINS,
  MAX_BODY_SIZE,
  PORT,
  RATE_LIMIT_IMAGE_MAX_REQUESTS,
  RATE_LIMIT_SYSTEM_MAX_REQUESTS,
  RATE_LIMIT_TEXT_MAX_REQUESTS,
  RATE_LIMIT_VISION_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
  TRUST_PROXY,
  validateRuntimeConfig
} from './config.js';
import { attachKeys } from './middleware/keys.js';
import { errorHandler } from './middleware/errors.js';
import { requireAuth } from './middleware/auth.js';
import { createRateLimit } from './middleware/rateLimit.js';
import { attachRequestContext, requestLogger } from './middleware/requestContext.js';
import { applySecurityHeaders } from './middleware/security.js';
import { textRouter } from './routes/text.js';
import { imageRouter } from './routes/image.js';
import { visionRouter } from './routes/vision.js';
import { systemRouter } from './routes/system.js';
// import webhookRouter from './routes/webhook.js'; // [DISABLED]
// import paymentsRouter from './routes/payments.js'; // [DISABLED]

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

// [DISABLED] Webhook must be before express.json() to get raw body
// app.use('/api/webhook', express.raw({ type: 'application/json' }), webhookRouter);

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

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Public routes
app.use('/api/system', systemRateLimit, systemRouter);

// Protect all API routes
app.use('/api', requireAuth);

// app.use('/api/payments', paymentsRouter); // [DISABLED] Authenticated payments
app.use('/api/text', textRateLimit, textRouter);
app.use('/api/image', imageRateLimit, imageRouter);
app.use('/api/assistant', textRateLimit, (_req, res) => {
  res.status(410).json({ error: { message: 'Story Assistant has been removed.' } });
});
app.use('/api/vision', visionRateLimit, visionRouter);

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`DreamStream API listening on :${PORT}`);
});
