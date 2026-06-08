// Collapse a failure into a stable signature so the "same issue" folds together
// regardless of volatile bits (ids, numbers, urls). Shared by the analytics
// "top issues" aggregation and the telemetry_failure_spike verification check so
// both group failures the exact same way.

export const normalizeFailureMessage = (msg: unknown): string =>
  String(msg || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/g, '<hex>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);

/** Signature key for grouping: event type + source + normalized message. */
export const failureSignature = (eventType: unknown, source: unknown, message: unknown): string =>
  `${String(eventType || 'error')}|${String(source || 'unknown')}|${normalizeFailureMessage(message)}`;
