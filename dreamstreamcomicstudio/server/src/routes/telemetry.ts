import { ReportError, saveFeedbackReport } from '../services/feedbackReports.js';
import { createRateLimit } from '../middleware/rateLimit.js';
import { Router, type Request } from 'express';
import type { FeedbackResponse, FeedbackWithdrawResponse, TelemetryIngestResponse } from '../../../apiTypes.js';
import { recordFeedback, recordTelemetryEvents, withdrawFeedback, type TelemetryContext } from '../services/telemetryStore.js';

// Public capture endpoints. Mounted with optionalAuth BEFORE the global requireAuth
// so failures that happen while logged-out (or while auth itself is failing) are
// still recorded. Both handlers are intentionally forgiving: malformed payloads are
// sanitized away rather than rejected, because dropping a feedback/log signal is
// worse than accepting a partial one.
export const telemetryRouter = Router();

const MAX_EVENTS_PER_BATCH = 50;

const contextFromReq = (req: Request): TelemetryContext => ({
  userId: req.user?.id ?? null,
  requestId: req.requestId,
  ip: req.ip,
  userAgent: req.header('user-agent') || undefined
});

telemetryRouter.post('/events', async (req, res, next) => {
  try {
    const rawEvents = Array.isArray(req.body?.events) ? req.body.events : [];
    const result = await recordTelemetryEvents(rawEvents.slice(0, MAX_EVENTS_PER_BATCH), contextFromReq(req));
    const payload: TelemetryIngestResponse = { ok: true, accepted: result.accepted, persisted: result.persisted };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

telemetryRouter.post('/feedback', async (req, res, next) => {
  try {
    const result = await recordFeedback(req.body ?? {}, contextFromReq(req));
    const payload: FeedbackResponse = { ok: true, persisted: result.persisted };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// A rating's Undo (Comic Studio's reply rating): a signed-in person takes back their own rating of one reply. The
// store removes only that person's rows of a withdrawable kind; anything else is refused or left alone.
telemetryRouter.post('/feedback/withdraw', createRateLimit({
  scope: 'feedback-withdraw', windowMs: 60_000, maxRequests: 30
}), async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!req.user?.id) return res.status(401).json({ error: { message: 'Sign in again to change your rating.' } });
  try {
    const result = await withdrawFeedback(req.body ?? {}, contextFromReq(req));
    const payload: FeedbackWithdrawResponse = { ok: true, withdrawn: result.withdrawn };
    return res.json(payload);
  } catch (err) {
    next(err);
  }
});

// Explicit reports provide a durable receipt. The lightweight telemetry and vote routes
// retain their original best-effort contract for older clients.
telemetryRouter.post('/reports', createRateLimit({
  scope: 'feedback-reports', windowMs: 60_000, maxRequests: 8
}), async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.header('Authorization') && !req.user?.id) {
    return res.status(401).json({ error: { message: 'Your session expired. Sign in again to send this report.' } });
  }
  try {
    const receipt = await saveFeedbackReport(req.body, req.user?.id ?? null, req.ip ?? 'unknown');
    return res.status(201).json(receipt);
  } catch (error) {
    if (error instanceof ReportError) return res.status(error.status).json({ error: { message: error.message } });
    next(error);
  }
});
