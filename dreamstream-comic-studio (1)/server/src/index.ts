import express from 'express';
import cors from 'cors';
import { PORT, CORS_ORIGIN, MAX_BODY_SIZE } from './config.js';
import { attachKeys } from './middleware/keys.js';
import { errorHandler } from './middleware/errors.js';
import { textRouter } from './routes/text.js';
import { imageRouter } from './routes/image.js';
import { assistantRouter } from './routes/assistant.js';
import { visionRouter } from './routes/vision.js';
import { systemRouter } from './routes/system.js';

const app = express();

app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: MAX_BODY_SIZE }));
app.use(attachKeys);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/text', textRouter);
app.use('/api/image', imageRouter);
app.use('/api/assistant', assistantRouter);
app.use('/api/vision', visionRouter);
app.use('/api/system', systemRouter);

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`DreamStream API listening on :${PORT}`);
});
