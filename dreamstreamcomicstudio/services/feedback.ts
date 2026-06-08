// Client helper for submitting explicit feedback — like/dislike on a response or
// error, plus general platform feedback (category + sentiment + comment). Posts to
// POST /api/telemetry/feedback, where the server persists it (user_feedback table).
//
// Like telemetry, this is best-effort and never throws: a failed submit resolves to
// { ok:false } so the UI can show a soft retry/thanks state without breaking.

import { post } from './apiClient';
import { getTelemetrySessionId } from './telemetry';
import { detectSentiment } from './sentiment';
import {
  FEEDBACK_CATEGORIES,
  type FeedbackInput,
  type FeedbackResponse,
  type FeedbackSentiment
} from '../apiTypes';

export { FEEDBACK_CATEGORIES, detectSentiment };
export type { FeedbackInput, FeedbackSentiment };

const currentSurface = (): string | undefined => {
  try {
    return typeof window !== 'undefined' ? window.location.pathname : undefined;
  } catch {
    return undefined;
  }
};

export const submitFeedback = async (
  input: FeedbackInput
): Promise<{ ok: boolean; persisted: boolean }> => {
  try {
    const payload: FeedbackInput = {
      ...input,
      source: input.source ?? 'client',
      surface: input.surface ?? currentSurface(),
      sessionId: input.sessionId ?? getTelemetrySessionId(),
      clientTs: input.clientTs ?? new Date().toISOString()
    };
    const res = await post<FeedbackInput, FeedbackResponse>('/telemetry/feedback', payload);
    return { ok: Boolean(res?.ok), persisted: Boolean(res?.persisted) };
  } catch {
    // Best-effort: a dropped feedback submit must not surface as an app error.
    return { ok: false, persisted: false };
  }
};
