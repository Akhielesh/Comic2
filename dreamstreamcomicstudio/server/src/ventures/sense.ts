// SENSE layer (Epic A6) — turn an observed signal (runtime error, user feedback, health) into
// a backlog goal so the loop keeps IMPROVING the product, not just building the initial roadmap.
// Pure + unit-testable; the route persists the event and (deduped) creates the goal.

export type SignalType = 'error' | 'feedback' | 'health';

export interface VentureSignal {
  type: SignalType;
  message: string;
  data?: Record<string, unknown>;
}

export interface SenseGoal {
  title: string;
  detail: string;
  kind: 'fix' | 'feature' | 'chore';
  priority: number;
}

/** Map a signal to the fix/improve goal it warrants, or null if it shouldn't create one. */
export const signalToGoal = (signal: VentureSignal): SenseGoal | null => {
  const msg = (signal.message || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  if (!msg) return null;
  if (signal.type === 'error') {
    return { title: `Fix runtime error: ${msg}`, detail: 'Auto-created from a runtime error signal.', kind: 'fix', priority: 5 };
  }
  if (signal.type === 'feedback') {
    return { title: `Address feedback: ${msg}`, detail: 'Auto-created from user feedback.', kind: 'feature', priority: 50 };
  }
  return null; // 'health' is recorded but doesn't auto-create a goal
};

const ACTIONABLE_STATUSES = new Set(['proposed', 'queued', 'in_progress']);

/** Dedupe: is there already an open goal with this exact title? (avoids signal spam) */
export const goalAlreadyOpen = (title: string, goals: Array<{ title: string; status: string }>): boolean =>
  goals.some((g) => g.title === title && ACTIONABLE_STATUSES.has(g.status));
