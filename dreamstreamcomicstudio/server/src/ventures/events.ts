// Pure venture-event shaping for Autopilot's append-only audit trail (no DB, no network).
// Epic A0. The actual append is a thin repository call (added in A1); this module builds and
// lightly redacts the record so the loop can log every sense/decision/action/spend
// deterministically and explainably. See docs/studio/autopilot/spec/38-observability.md.

export type VentureEventLevel = 'info' | 'warn' | 'error';

export type VentureEventKind =
  | 'tick.started'
  | 'tick.completed'
  | 'goal.selected'
  | 'goal.shipped'
  | 'goal.failed'
  | 'decision.gated'
  | 'budget.alert'
  | 'budget.exceeded'
  | 'checkpoint.raised'
  | 'checkpoint.resolved'
  | 'deploy.shipped'
  | 'kill.activated'
  | 'venture.paused'
  | 'venture.resumed'
  | 'signal'
  | 'error';

export interface VentureEventInput {
  ventureId: string;
  userId: string;
  kind: VentureEventKind;
  level?: VentureEventLevel;
  message?: string;
  data?: Record<string, unknown>;
  costUsd?: number;
  model?: string;
  source?: string; // 'engine' | 'scheduler' | 'api' | ...
  at?: string; // ISO; defaults to now
}

/** Row shape for the `venture_events` table (snake_case to match SQL). */
export interface VentureEventRecord {
  venture_id: string;
  user_id: string;
  kind: VentureEventKind;
  level: VentureEventLevel;
  message: string | null;
  data: Record<string, unknown> | null;
  cost_usd: number | null;
  model: string | null;
  source: string;
  created_at: string;
}

// Mask obvious secret-like tokens so they can never land in the audit log.
const SECRET_PATTERN =
  /(sk-[A-Za-z0-9]{8,}|nvapi-[A-Za-z0-9]{8,}|AIza[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}|[A-Za-z0-9_-]{40,})/g;

export const redactSecrets = (text: string): string => text.replace(SECRET_PATTERN, '[redacted]');

const MAX_MESSAGE_LEN = 2000;

/** Pure: build a normalized, secret-redacted venture event record. */
export const buildVentureEvent = (input: VentureEventInput): VentureEventRecord => {
  const message = input.message ? redactSecrets(input.message).slice(0, MAX_MESSAGE_LEN) : null;
  return {
    venture_id: input.ventureId,
    user_id: input.userId,
    kind: input.kind,
    level: input.level ?? 'info',
    message,
    data: input.data ?? null,
    cost_usd: typeof input.costUsd === 'number' && Number.isFinite(input.costUsd) ? input.costUsd : null,
    model: input.model ?? null,
    source: input.source ?? 'engine',
    created_at: input.at ?? new Date().toISOString()
  };
};
