import { Router } from 'express';

export const assistantRouter = Router();

assistantRouter.all('*', (_req, res) => {
  res.status(410).json({ error: { message: 'Story Assistant has been removed.' } });
});
