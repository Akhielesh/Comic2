import { Router, type Request } from 'express';
import type { FeedbackResponse, TelemetryIngestResponse } from '../../../apiTypes.js';
import { recordFeedback, recordTelemetryEvents, type TelemetryContext } from '../services/telemetryStore.js';

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
