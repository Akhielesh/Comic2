import 'dotenv/config'; // Load env vars before anything else
import express from 'express';
import cors from 'cors';

import { PORT, CORS_ORIGIN, MAX_BODY_SIZE } from './config.js';
import { attachKeys } from './middleware/keys.js';
import { errorHandler } from './middleware/errors.js';
import { requireAuth } from './middleware/auth.js';
import { textRouter } from './routes/text.js';
import { imageRouter } from './routes/image.js';
import { visionRouter } from './routes/vision.js';
import { systemRouter } from './routes/system.js';
// import webhookRouter from './routes/webhook.js'; // [DISABLED]
// import paymentsRouter from './routes/payments.js'; // [DISABLED]

const app = express();

app.use(cors({ origin: CORS_ORIGIN, credentials: true }));

// [DISABLED] Webhook must be before express.json() to get raw body
// app.use('/api/webhook', express.raw({ type: 'application/json' }), webhookRouter);

app.use(express.json({ limit: MAX_BODY_SIZE }));
app.use(attachKeys);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Public routes
app.use('/api/system', systemRouter);

// Protect all API routes
app.use('/api', requireAuth);

// app.use('/api/payments', paymentsRouter); // [DISABLED] Authenticated payments
app.use('/api/text', textRouter);
app.use('/api/image', imageRouter);
app.use('/api/assistant', (_req, res) => {
  res.status(410).json({ error: { message: 'Story Assistant has been removed.' } });
});
app.use('/api/vision', visionRouter);

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`DreamStream API listening on :${PORT}`);
});
