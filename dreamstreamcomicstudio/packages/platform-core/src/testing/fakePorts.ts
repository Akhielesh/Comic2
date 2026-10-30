/**
 * In-memory host ports for tests (plan §6): a fake ledger with reservations and a "down" switch, a fake identity
 * port that refuses to mint without a session, an audit sink that collects events, an approver that collects draft
 * actions, a controllable clock, deterministic ids and a scripted model. Every host can run its own code and the
 * conformance kit against these, and swap one port at a time for its real implementation.
 */
import type { CapabilityId } from '../capabilities.js';
import type { AuditPort, PlatformAuditEvent } from '../audit/event.js';
import { base64urlEncode, canonicalJson, hmacSha256, toHex } from '../audit/inputHash.js';
import type { DraftAction } from '../gates/consent.js';
import type { ApproverPort, ClaimPurpose, IdentityPort, MeterClaimResult, MeterPort, MeterReserveResult, MeterSettleResult, PlatformCostMetadata, ServicePreviewCap } from '../gates/ports.js';
import { SERVICE_PREVIEW_CAPS } from '../gates/ports.js';
import type { FlowModelReply, FlowModelRequest } from '../flows/types.js';

// ── Clock and ids ───────────────────────────────────────────────────────────────────────────────────────────────

export interface FakeClock {
  (): number;
  now(): number;
  advance(ms: number): void;
  set(ms: number): void;
}

/** A clock that only moves when told (Unix ms; default 2026-11-02T09:00:00Z). */
export const createFakeClock = (startMs = 1793610000000): FakeClock => {
  let t = startMs;
  const clock = (() => t) as FakeClock;
  clock.now = () => t;
  clock.advance = (ms: number) => {
    t += ms;
  };
  clock.set = (ms: number) => {
    t = ms;
  };
  return clock;
};

/** `prefix-1`, `prefix-2`, … (valid `ID_PATTERN` ids). */
export const createIdSequence = (prefix = 'id'): (() => string) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

// ── Ledger ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type FakeReservationStatus = 'reserved' | 'claimed' | 'settled' | 'released';

export interface FakeReservation {
  id: string;
  operation: string;
  estimateUsd: number;
  status: FakeReservationStatus;
  actualUsd?: number;
  metadata: { platform: PlatformCostMetadata };
}

export interface FakeLedger extends MeterPort {
  readonly reservations: FakeReservation[];
  /** While down, every call fails the way an unreachable ledger does. */
  down: boolean;
  setDown(down: boolean): void;
  /** Settled spend (USD). */
  spentUsd(): number;
  /** What a governed user has left: the budget minus settled and open holds. */
  remainingUsd(): number;
  readonly calls: { reserve: number; claim: number; settle: number; release: number };
}

export interface FakeLedgerOptions {
  /** Default true: the shared allowance applies, and an unreachable ledger fails closed. */
  governed?: boolean;
  /** A governed user's allowance (USD; default 10). */
  budgetUsd?: number;
  idPrefix?: string;
}

/**
 * A reservation ledger with the platform's semantics. Governed: holds count against the budget, and with the ledger
 * down `reserve` answers `unavailable` (fail closed). Ungoverned: no budget; while down `reserve` still answers
 * (exempt users are not metered) but `claim`, `settle` and `release` cannot reach the ledger.
 */
export const createFakeLedger = (options: FakeLedgerOptions = {}): FakeLedger => {
  const governed = options.governed !== false;
  const budget = options.budgetUsd === undefined ? 10 : options.budgetUsd;
  const next = createIdSequence(options.idPrefix || 'res');
  const reservations: FakeReservation[] = [];
  const calls = { reserve: 0, claim: 0, settle: 0, release: 0 };
  const find = (id: string): FakeReservation | undefined => {
    for (const r of reservations) if (r.id === id) return r;
    return undefined;
  };
  const spentUsd = (): number => reservations.reduce((n, r) => n + (r.status === 'settled' ? r.actualUsd || 0 : 0), 0);
  const heldUsd = (): number => reservations.reduce((n, r) => n + (r.status === 'reserved' || r.status === 'claimed' ? r.estimateUsd : 0), 0);
  const unavailable = (): { ok: false; code: 'unavailable'; message: string } => ({ ok: false, code: 'unavailable', message: 'The usage ledger is unreachable.' });
  const close = (id: string, to: 'settled' | 'released', actualUsd?: number): MeterSettleResult => {
    if (ledger.down) return unavailable();
    const r = find(id);
    if (!r || (r.status !== 'reserved' && r.status !== 'claimed')) return { ok: false, code: 'conflict', message: 'That reservation is already closed.' };
    r.status = to;
    if (to === 'settled') r.actualUsd = actualUsd !== undefined && isFinite(actualUsd) && actualUsd > 0 ? actualUsd : 0;
    return { ok: true };
  };
  const ledger: FakeLedger = {
    governed,
    reservations,
    down: false,
    calls,
    setDown(down: boolean) {
      ledger.down = down;
    },
    spentUsd,
    remainingUsd: () => Math.max(0, budget - spentUsd() - heldUsd()),
    async reserve(input): Promise<MeterReserveResult> {
      calls.reserve++;
      const estimate = typeof input.estimateFloorUsd === 'number' && isFinite(input.estimateFloorUsd) && input.estimateFloorUsd > 0 ? input.estimateFloorUsd : 0;
      if (ledger.down && governed) return unavailable();
      if (governed && estimate > ledger.remainingUsd() + 1e-12) return { ok: false, code: 'quota', message: 'Not enough usage left.' };
      const r: FakeReservation = { id: next(), operation: input.operation, estimateUsd: estimate, status: 'reserved', metadata: input.metadata };
      reservations.push(r);
      return { ok: true, reservationId: r.id };
    },
    async claim(id: string): Promise<MeterClaimResult> {
      calls.claim++;
      if (ledger.down) throw new Error('The usage ledger is unreachable.');
      const r = find(id);
      if (!r) return 'unknown';
      if (r.status !== 'reserved') return 'used';
      r.status = 'claimed';
      return 'claimed';
    },
    async settle(id, input) {
      calls.settle++;
      return close(id, 'settled', input && input.actualUsd);
    },
    async release(id) {
      calls.release++;
      return close(id, 'released');
    },
  };
  return ledger;
};

// ── Identity ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FakeIdentityOptions {
  /** The authenticated request's user, or null for a request with no session. */
  session: { userId: string } | null;
  app?: string;
  product?: string;
  /** The app secret the claims are signed with (tests only). */
  appSecret?: string;
  tier?: 'free' | 'creator' | 'studio' | 'admin' | 'atlas-beta';
  clock?: () => number;
  ids?: () => string;
}

const CLAIM_TTL_S = 300;

/** A claim in the wire's shape: `base64url(json) "." base64url(HMAC(claimKey, base64url(json)))`. */
const signClaim = (payload: object, appSecret: string): string => {
  const body = base64urlEncode(canonicalJson(payload));
  const claimKey = hmacSha256(appSecret, 'platform-claim-v1');
  return `${body}.${base64urlEncode(hmacSha256(claimKey, body))}`;
};

/**
 * An identity port bound to one fake request. `mintUserClaim` rejects without a session; `mintServiceClaim` rejects
 * any capability outside `SERVICE_PREVIEW_CAPS` and any purpose but `preview`. The subject is pseudonymous:
 * `hex(HMAC(appSecret, userId))[0..32]`.
 */
export const createFakeIdentity = (options: FakeIdentityOptions): IdentityPort => {
  const app = options.app || 'dreamstream';
  const product = options.product || 'chat';
  const secret = options.appSecret || 'fake-app-secret-for-tests-only-0123456789';
  const clock = options.clock || (() => Date.now());
  const ids = options.ids || createIdSequence('jti');
  return {
    async mintUserClaim(purpose: ClaimPurpose, caps: readonly CapabilityId[]): Promise<string> {
      if (!options.session || !options.session.userId) throw new Error('No authenticated session: a user claim needs the host to have signed the user in.');
      const now = Math.floor(clock() / 1000);
      const sub = toHex(hmacSha256(secret, options.session.userId)).slice(0, 32);
      return signClaim({ v: 1, kind: 'user', app, product, sub, tier: options.tier || 'free', purpose, caps: caps.slice(), exp: now + CLAIM_TTL_S, jti: ids() }, secret);
    },
    async mintServiceClaim(purpose: 'preview', caps: readonly ServicePreviewCap[]): Promise<string> {
      if (purpose !== 'preview') throw new Error('A service claim is for previews only.');
      for (const c of caps) if ((SERVICE_PREVIEW_CAPS as readonly string[]).indexOf(c) === -1) throw new Error(`A service claim cannot carry ${String(c)}.`);
      const now = Math.floor(clock() / 1000);
      return signClaim({ v: 1, kind: 'service', app, product, purpose, caps: caps.slice(), exp: now + CLAIM_TTL_S, jti: ids() }, secret);
    },
  };
};

// ── Audit and approval ──────────────────────────────────────────────────────────────────────────────────────────

export interface FakeAudit extends AuditPort {
  readonly events: PlatformAuditEvent[];
}

export const createFakeAudit = (): FakeAudit => {
  const events: PlatformAuditEvent[] = [];
  return {
    events,
    record(event: PlatformAuditEvent) {
      events.push(event);
    },
  };
};

export interface FakeApprover extends ApproverPort {
  readonly drafts: DraftAction[];
}

export const createFakeApprover = (): FakeApprover => {
  const drafts: DraftAction[] = [];
  return {
    drafts,
    draft(action: DraftAction) {
      drafts.push(action);
    },
  };
};

// ── A scripted model ────────────────────────────────────────────────────────────────────────────────────────────

export interface ScriptedModel {
  (request: FlowModelRequest): Promise<FlowModelReply>;
  readonly requests: FlowModelRequest[];
}

/** Answers with `replies` in order; past the end it answers an error. Records every request. */
export const scriptedModel = (replies: readonly FlowModelReply[]): ScriptedModel => {
  const requests: FlowModelRequest[] = [];
  const model = (async (request: FlowModelRequest) => {
    requests.push(request);
    const reply = replies[requests.length - 1];
    return reply || { kind: 'error', code: 'engine-failed', message: 'The script has no more replies.' };
  }) as ScriptedModel;
  Object.defineProperty(model, 'requests', { value: requests });
  return model;
};

// ── Everything at once ──────────────────────────────────────────────────────────────────────────────────────────

/** A plan-token key for tests only (32+ bytes). */
export const FAKE_PLAN_KEY = 'fake-plan-key-for-tests-only-0123456789abcdef';

export interface FakePorts {
  clock: FakeClock;
  newId: () => string;
  ledger: FakeLedger;
  audit: FakeAudit;
  approver: FakeApprover;
  identity: IdentityPort;
  planKey: string;
  sub: string;
}

export const createFakePorts = (options: { governed?: boolean; budgetUsd?: number; session?: { userId: string } | null; startMs?: number } = {}): FakePorts => {
  const clock = createFakeClock(options.startMs);
  const session = options.session === undefined ? { userId: 'user-1' } : options.session;
  return {
    clock,
    newId: createIdSequence('evt'),
    ledger: createFakeLedger({ governed: options.governed, budgetUsd: options.budgetUsd }),
    audit: createFakeAudit(),
    approver: createFakeApprover(),
    identity: createFakeIdentity({ session, clock }),
    planKey: FAKE_PLAN_KEY,
    sub: session ? toHex(hmacSha256('fake-app-secret-for-tests-only-0123456789', session.userId)).slice(0, 32) : 'anonymous',
  };
};
