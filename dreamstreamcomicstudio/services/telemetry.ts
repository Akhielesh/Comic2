// Client-side capture for the observability pipeline. Buffers small, timestamped
// events and flushes them in batches to POST /api/telemetry/events, where the
// server enriches + persists them (see server/services/telemetryStore.ts).
//
// Hard rules:
// - NEVER throw and NEVER block. Capturing a log/error must not affect the user's
//   flow. Every entry point is wrapped; flush failures are swallowed (we don't
//   re-capture our own failures, which would risk a feedback loop).
// - Always timestamped + sourced. Each event carries a client ISO timestamp, the
//   product surface it came from, and a per-tab session id so a flow can be
//   reconstructed even before the user logs in.

import { buildApiUrl } from './clientConfig';
import { post } from './apiClient';
import type { TelemetryEventInput, TelemetrySource } from '../apiTypes';

const SESSION_KEY = 'ds_telemetry_session_id';
const MAX_QUEUE = 100;
const MAX_BATCH = 50;
const FLUSH_INTERVAL_MS = 8000;

let queue: TelemetryEventInput[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let initialized = false;

// Ambient context the app can update as the user navigates, so events captured by
// generic listeners (window errors, unhandled rejections) still get a useful source.
let ambientSource: TelemetrySource = 'client';

const safe = <T>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

/** Stable per-tab session id (sessionStorage), used to group a single visit's flow. */
export const getTelemetrySessionId = (): string | undefined =>
  safe(() => {
    if (typeof window === 'undefined') return undefined;
    let id = window.sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = (crypto?.randomUUID?.() ?? `sid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      window.sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  });

const currentSurface = (): string | undefined =>
  safe(() => (typeof window !== 'undefined' ? window.location.pathname : undefined));

/** Lets the app annotate which product surface the user is on (e.g. 'ai_chat'). */
export const setTelemetrySource = (source: TelemetrySource) => {
  ambientSource = source;
};

const scheduleFlush = () => {
  if (flushTimer || typeof window === 'undefined') return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushTelemetry();
  }, FLUSH_INTERVAL_MS);
};

/** Queue a single telemetry event. Best-effort; never throws. */
export const captureEvent = (input: TelemetryEventInput): void => {
  safe(() => {
    const event: TelemetryEventInput = {
      eventType: input.eventType || 'log',
      severity: input.severity ?? 'info',
      source: input.source ?? ambientSource,
      surface: input.surface ?? currentSurface(),
      message: input.message,
      sessionId: input.sessionId ?? getTelemetrySessionId(),
      clientTs: input.clientTs ?? new Date().toISOString(),
      metadata: input.metadata
    };
    queue.push(event);
    // Bound memory: if we're backed up (offline, server down), keep the newest.
    if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE);
    // Errors/crashes are worth shipping promptly; routine logs can wait for the batch.
    if (event.severity === 'error' || event.severity === 'critical') void flushTelemetry();
    else scheduleFlush();
  });
};

/** Convenience wrapper for capturing a thrown error or failed request. */
export const captureError = (
  error: unknown,
  context: {
    eventType?: string;
    source?: TelemetrySource;
    surface?: string;
    sessionId?: string;
    message?: string;
    metadata?: Record<string, unknown>;
  } = {}
): void => {
  const err = error as { message?: string; name?: string; stack?: string; status?: number; details?: unknown };
  captureEvent({
    eventType: context.eventType || 'error',
    severity: 'error',
    source: context.source,
    surface: context.surface,
    sessionId: context.sessionId,
    message: context.message || err?.message || String(error),
    metadata: {
      name: err?.name,
      status: err?.status,
      stack: typeof err?.stack === 'string' ? err.stack.slice(0, 4000) : undefined,
      details: err?.details,
      ...context.metadata
    }
  });
};

/** Flush buffered events to the server. Swallows all errors (best-effort delivery). */
export const flushTelemetry = async (): Promise<void> => {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue.splice(0, MAX_BATCH);
  try {
    await post('/telemetry/events', { events: batch });
  } catch {
    // Delivery failed (offline / rate-limited / server down). Drop the batch rather
    // than retry-storm — telemetry is best-effort and must not generate more traffic.
  } finally {
    flushing = false;
    // If errors piled up while flushing, keep draining.
    if (queue.length > 0) scheduleFlush();
  }
};

// On page hide, use sendBeacon so in-flight events survive an unload (fetch would be
// cancelled). sendBeacon can't attach the auth header, so these land as anonymous —
// acceptable for last-gasp delivery; the bulk ships via the authenticated interval flush.
const beaconFlush = () => {
  safe(() => {
    if (queue.length === 0 || typeof navigator === 'undefined' || !navigator.sendBeacon) return;
    const batch = queue.splice(0, MAX_QUEUE);
    const blob = new Blob([JSON.stringify({ events: batch })], { type: 'application/json' });
    navigator.sendBeacon(buildApiUrl('/telemetry/events'), blob);
  });
};

/**
 * Install global capture: uncaught window errors, unhandled promise rejections, an
 * interval flush, and a page-hide beacon flush. Idempotent; safe to call at startup.
 */
export const initTelemetry = (): void => {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  window.addEventListener('error', (event) => {
    captureEvent({
      eventType: 'window_error',
      severity: 'error',
      message: event.message || 'Uncaught error',
      metadata: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: typeof event.error?.stack === 'string' ? event.error.stack.slice(0, 4000) : undefined
      }
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as { message?: string; stack?: string } | undefined;
    captureEvent({
      eventType: 'unhandled_rejection',
      severity: 'error',
      message: reason?.message || String(event.reason),
      metadata: { stack: typeof reason?.stack === 'string' ? reason.stack.slice(0, 4000) : undefined }
    });
  });

  window.addEventListener('pagehide', beaconFlush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') beaconFlush();
  });

  setInterval(() => void flushTelemetry(), FLUSH_INTERVAL_MS);
};
