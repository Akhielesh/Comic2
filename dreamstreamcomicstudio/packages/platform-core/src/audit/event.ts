/**
 * Audit events (plan §5.10). `PlatformAuditEvent` is what every governed call, consent and flow run reports through
 * the host's `AuditPort`. It NEVER carries content: no document text, no addresses, no file names, no prompts —
 * only ids, the decision, the outcome and a hash of the input. `auditEvent()` builds one from an allowlist of fields,
 * so an extra field a caller passes (a subject line, a body) is dropped, not stored.
 *
 * Where a host files it is its own business; `dreamstreamAuditSink` names DreamStream's routing: security-relevant
 * decisions to `audit_log` (routine budget refusals never), paid calls to the cost row's `metadata.platform`,
 * stranded holds and everything else to a log line.
 */
import { ID_PATTERN } from '../contract/schema.js';
import { isInputHash } from './inputHash.js';

export const AUDIT_ACTOR_KINDS = ['user', 'agent', 'system'] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/** `auto`: the gate let it run; `confirmed`: a person approved it; `rejected`: a person said no; `blocked`: a guard refused it. */
export const AUDIT_DECISIONS = ['auto', 'confirmed', 'rejected', 'blocked'] as const;
export type AuditDecision = (typeof AUDIT_DECISIONS)[number];

/** `pending`: waiting for a person (a proposal, a plan, a draft action). */
export const AUDIT_OUTCOMES = ['ok', 'failed', 'refused', 'pending'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** What happened: a tool call, a recorded consent, a capability switched on or off, or a whole flow run. */
export const AUDIT_KINDS = ['call', 'consent', 'toggle', 'flow'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface PlatformAuditEvent {
  id: string;
  /** Unix ms. */
  at: number;
  kind: AuditKind;
  app: string;
  product: string;
  actor: { kind: AuditActorKind; id?: string };
  tool?: string;
  capability?: string;
  flow?: string;
  decision: AuditDecision;
  /** `inputHash()` of what the call acted on (`sha256:<hex>`): the only trace of content. */
  inputHash: string;
  /** Ids of the ops it applied or proposed (never the ops). */
  opIds: string[];
  /** `engine@version`. */
  engine?: string;
  /** What it cost, in millionths of a dollar (server-side only; never shown to a governed user). */
  costMicros?: number;
  outcome: AuditOutcome;
  /** A platform or gate code (`forbidden`, `max-per-turn`…), never a message. */
  errorCode?: string;
}

/** The port each host implements over its own sinks. Recording must never throw into the caller's path. */
export interface AuditPort {
  record(event: PlatformAuditEvent): void | Promise<void>;
}

export const AUDIT_LIMITS = {
  opIds: 500,
  short: 64,
  engine: 80,
} as const;

const ID = new RegExp(ID_PATTERN);
const SHORT = /^[a-z0-9][a-z0-9._:@+-]{0,79}$/i;

const has = (list: readonly string[], v: unknown): boolean => typeof v === 'string' && list.indexOf(v) !== -1;

export class AuditEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditEventError';
  }
}

/** Optional fields are copied only when present and well formed; a malformed required field throws. */
export interface AuditEventInput {
  id: string;
  at: number;
  kind?: AuditKind;
  app: string;
  product: string;
  actor: { kind: AuditActorKind; id?: string };
  tool?: string;
  capability?: string;
  flow?: string;
  decision: AuditDecision;
  inputHash: string;
  opIds?: readonly string[];
  engine?: string;
  costMicros?: number;
  outcome: AuditOutcome;
  errorCode?: string;
}

const short = (v: unknown, max: number = AUDIT_LIMITS.short): v is string => typeof v === 'string' && v.length <= max && SHORT.test(v);

/**
 * Build a content-free event from `input`. Only the fields above survive, each checked: ids match `ID_PATTERN`,
 * names are short machine words, `inputHash` is a `sha256:` fingerprint. Throws `AuditEventError` on a bad required
 * field (a programming error); drops a bad optional one.
 */
export const auditEvent = (input: AuditEventInput): PlatformAuditEvent => {
  if (typeof input !== 'object' || input === null) throw new AuditEventError('an audit event needs its fields');
  if (typeof input.id !== 'string' || !ID.test(input.id)) throw new AuditEventError('audit event id must match ID_PATTERN');
  if (typeof input.at !== 'number' || !isFinite(input.at) || input.at < 0) throw new AuditEventError('audit event at must be Unix ms');
  if (!short(input.app) || !short(input.product)) throw new AuditEventError('audit event app and product must be short ids');
  if (!input.actor || !has(AUDIT_ACTOR_KINDS, input.actor.kind)) throw new AuditEventError('audit event actor.kind must be user, agent or system');
  if (!has(AUDIT_DECISIONS, input.decision)) throw new AuditEventError('audit event decision is unknown');
  if (!has(AUDIT_OUTCOMES, input.outcome)) throw new AuditEventError('audit event outcome is unknown');
  if (!isInputHash(input.inputHash)) throw new AuditEventError('audit event inputHash must be a sha256: fingerprint');
  const kind = input.kind === undefined ? 'call' : input.kind;
  if (!has(AUDIT_KINDS, kind)) throw new AuditEventError('audit event kind is unknown');

  const actor: PlatformAuditEvent['actor'] = { kind: input.actor.kind };
  if (typeof input.actor.id === 'string' && input.actor.id.length > 0 && input.actor.id.length <= 128 && /^[A-Za-z0-9._:@-]+$/.test(input.actor.id)) {
    actor.id = input.actor.id;
  }
  const opIds = (Array.isArray(input.opIds) ? input.opIds : []).filter((x) => typeof x === 'string' && ID.test(x)).slice(0, AUDIT_LIMITS.opIds);
  const out: PlatformAuditEvent = {
    id: input.id,
    at: input.at,
    kind,
    app: input.app,
    product: input.product,
    actor,
    decision: input.decision,
    inputHash: input.inputHash,
    opIds,
    outcome: input.outcome,
  };
  if (short(input.tool)) out.tool = input.tool;
  if (short(input.capability)) out.capability = input.capability;
  if (short(input.flow)) out.flow = input.flow;
  if (short(input.engine, AUDIT_LIMITS.engine)) out.engine = input.engine;
  if (typeof input.costMicros === 'number' && Number.isSafeInteger(input.costMicros) && input.costMicros >= 0) out.costMicros = input.costMicros;
  if (short(input.errorCode)) out.errorCode = input.errorCode;
  return out;
};

/** DreamStream's `audit_log` actions for platform events (security-relevant decisions only). */
export const DREAMSTREAM_AUDIT_ACTIONS = ['platform.guard.blocked', 'platform.consent.recorded', 'platform.capability.toggled'] as const;
export type DreamStreamAuditAction = (typeof DREAMSTREAM_AUDIT_ACTIONS)[number];

/**
 * `blocked` codes that are SECURITY decisions (plan §5.10: `audit_log` holds these only): a policy deny, a forged,
 * foreign, edited or replayed approval, an external write that could not be prepared, and every consent refusal
 * (`executeExternalWrite`).
 */
export const SECURITY_GUARD_CODES = [
  'gate-deny',
  'plan-malformed',
  'plan-signature',
  'plan-lifetime',
  'plan-not-yet-valid',
  'plan-subject',
  'plan-plan',
  'plan-params',
  'reservation-unknown',
  'external-write',
  'no-consent',
  'wrong-action',
  'wrong-user',
  'payload-changed',
  'consent-expired',
] as const;

/**
 * `blocked` codes that are ROUTINE budget and lifecycle refusals: a structured log line, never `audit_log` (they would
 * flood it). Any other `blocked` code is treated as a security decision.
 */
export const ROUTINE_GUARD_CODES = ['quota', 'ledger-down', 'max-per-turn', 'reservation-used', 'estimate-changed', 'plan-expired', 'plan-stale'] as const;

/** A hold the ledger could not close: logged with `stranded: true` so reconciliation finds it. */
export const LEDGER_PROBLEM_CODES = ['settle-failed', 'release-failed'] as const;

export type DreamStreamAuditSink =
  | { sink: 'audit_log'; action: DreamStreamAuditAction }
  | { sink: 'cost_metadata' }
  | { sink: 'log'; stranded?: true };

/**
 * Where DreamStream files an event:
 * - a recorded consent or a capability toggle → `audit_log`;
 * - a stranded hold (`settle-failed` / `release-failed`) → a log line with `stranded: true` (its cost row never
 *   settled, so it cannot carry it);
 * - a `blocked` security guard (`SECURITY_GUARD_CODES`, or any code not known to be routine) → `audit_log` as
 *   `platform.guard.blocked`; a routine refusal (`ROUTINE_GUARD_CODES`: quota, ledger down, per-turn cap, a used
 *   reservation, a changed estimate, an expired or stale plan) → a log line;
 * - a call that cost something → the cost row's `metadata.platform` (through reserve/settle; a paid flow run too);
 * - anything else → one structured log line.
 */
export const dreamstreamAuditSink = (event: PlatformAuditEvent): DreamStreamAuditSink => {
  if (event.kind === 'consent') return { sink: 'audit_log', action: 'platform.consent.recorded' };
  if (event.kind === 'toggle') return { sink: 'audit_log', action: 'platform.capability.toggled' };
  if (has(LEDGER_PROBLEM_CODES, event.errorCode)) return { sink: 'log', stranded: true };
  if (event.decision === 'blocked') return has(ROUTINE_GUARD_CODES, event.errorCode) ? { sink: 'log' } : { sink: 'audit_log', action: 'platform.guard.blocked' };
  if (typeof event.costMicros === 'number' && event.costMicros > 0) return { sink: 'cost_metadata' };
  return { sink: 'log' };
};
