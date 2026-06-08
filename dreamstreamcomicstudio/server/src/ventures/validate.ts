// Pure request validators for the /api/ventures control plane (no DB, no Express). Epic A1.
// Returns a ParseResult so handlers can 400 on bad input with a consistent message; kept
// pure + unit-testable (mirrors routes/text.validation.ts). The server tsconfig is
// non-strict, so results carry optional value+error (no discriminated-union narrowing needed).

import type { GoalKind } from './controlPlane.js';

export interface ParseResult<T> {
  valid: boolean;
  value?: T;
  error?: string;
}

const ok = <T>(value: T): ParseResult<T> => ({ valid: true, value });
const fail = <T>(error: string): ParseResult<T> => ({ valid: false, error });

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const trimmed = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const optionalCap = (v: unknown, label: string): ParseResult<number | null> => {
  if (v === undefined || v === null) return ok(null);
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    return fail(`${label} must be a number >= 0 or null.`);
  }
  return ok(v);
};

export interface CreateVentureInput {
  name: string;
  summary?: string;
  scope?: string;
}

export const parseCreateVenture = (body: unknown): ParseResult<CreateVentureInput> => {
  const b = (body || {}) as Record<string, unknown>;
  const name = trimmed(b.name);
  if (!name) return fail('name is required.');
  if (name.length > 200) return fail('name must be <= 200 characters.');
  const summary = str(b.summary) ?? undefined;
  if (summary && summary.length > 2000) return fail('summary must be <= 2000 characters.');
  const scope = str(b.scope) ?? undefined;
  if (scope && scope.length > 8000) return fail('scope must be <= 8000 characters.');
  return ok({ name, summary, scope });
};

const GOAL_KINDS: readonly GoalKind[] = ['epic', 'feature', 'task', 'fix', 'chore'];

export interface CreateGoalInput {
  title: string;
  detail?: string;
  kind?: GoalKind;
  priority?: number;
}

export const parseCreateGoal = (body: unknown): ParseResult<CreateGoalInput> => {
  const b = (body || {}) as Record<string, unknown>;
  const title = trimmed(b.title);
  if (!title) return fail('title is required.');
  if (title.length > 300) return fail('title must be <= 300 characters.');
  const detail = str(b.detail) ?? undefined;
  if (detail && detail.length > 8000) return fail('detail must be <= 8000 characters.');
  let kind: GoalKind | undefined;
  if (b.kind !== undefined) {
    if (!GOAL_KINDS.includes(b.kind as GoalKind)) return fail(`kind must be one of: ${GOAL_KINDS.join(', ')}.`);
    kind = b.kind as GoalKind;
  }
  let priority: number | undefined;
  if (b.priority !== undefined) {
    if (typeof b.priority !== 'number' || !Number.isInteger(b.priority) || b.priority < 0) {
      return fail('priority must be a non-negative integer.');
    }
    priority = b.priority;
  }
  return ok({ title, detail, kind, priority });
};

export interface BudgetInput {
  usdPerDay: number | null;
  usdTotal: number | null;
  maxTokens: number | null;
  maxContainerMinutes: number | null;
}

export const parseBudget = (body: unknown): ParseResult<BudgetInput> => {
  const b = (body || {}) as Record<string, unknown>;
  const perDay = optionalCap(b.usdPerDay, 'usdPerDay');
  if (!perDay.valid) return fail(perDay.error as string);
  const total = optionalCap(b.usdTotal, 'usdTotal');
  if (!total.valid) return fail(total.error as string);
  const tokens = optionalCap(b.maxTokens, 'maxTokens');
  if (!tokens.valid) return fail(tokens.error as string);
  const minutes = optionalCap(b.maxContainerMinutes, 'maxContainerMinutes');
  if (!minutes.valid) return fail(minutes.error as string);
  return ok({
    usdPerDay: perDay.value ?? null,
    usdTotal: total.value ?? null,
    maxTokens: tokens.value ?? null,
    maxContainerMinutes: minutes.value ?? null
  });
};

export type VentureStatusChange = 'active' | 'paused' | 'archived';
const USER_STATUSES: readonly VentureStatusChange[] = ['active', 'paused', 'archived'];

export const parseStatusChange = (body: unknown): ParseResult<VentureStatusChange> => {
  const b = (body || {}) as Record<string, unknown>;
  const status = trimmed(b.status) as VentureStatusChange;
  if (!USER_STATUSES.includes(status)) return fail(`status must be one of: ${USER_STATUSES.join(', ')}.`);
  return ok(status);
};

export type CheckpointDecision = 'approved' | 'denied';

export const parseCheckpointDecision = (body: unknown): ParseResult<CheckpointDecision> => {
  const b = (body || {}) as Record<string, unknown>;
  const raw = trimmed(b.decision).toLowerCase();
  if (raw === 'approve' || raw === 'approved') return ok('approved');
  if (raw === 'deny' || raw === 'denied' || raw === 'reject') return ok('denied');
  return fail("decision must be 'approve' or 'deny'.");
};
