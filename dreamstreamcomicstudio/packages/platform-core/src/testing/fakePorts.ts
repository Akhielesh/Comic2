/**
 * In-memory host ports for tests (plan §6): a fake ledger with reservations and a "down" switch, a fake identity
 * port that refuses to mint without a session, an audit sink that collects events, an approver that collects draft
 * actions, a controllable clock, deterministic ids and a scripted model. Every host can run its own code and the
 * conformance kit against these, and swap one port at a time for its real implementation.
 */
import type { CapabilityId } from '../capabilities.js';
import type { AuditPort, PlatformAuditEvent } from '../audit/event.js';
import { hmacSha256, sha256, toHex, utf8Bytes } from '../audit/inputHash.js';
import type { DraftAction } from '../gates/consent.js';
import type { ApproverPort, ClaimPurpose, IdentityPort, MeterClaimResult, MeterPort, MeterReserveResult, MeterSettleResult, PlatformCostMetadata, ServicePreviewCap } from '../gates/ports.js';
import type { FlowModelReply, FlowModelRequest } from '../flows/types.js';
import { WIRE_KEY_LABELS, mintServiceClaim, mintUserClaim, pseudonymousSub } from '../wire/index.js';
import type { ClaimTier, WireCrypto } from '../wire/index.js';

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
 * (exempt users are not metered) but `claim`, `settle` and `release` cannot reach the ledger: they answer
 * `unavailable` and never throw.
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
      if (ledger.down) return 'unavailable'; // a claim never throws (MeterPort)
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

// ── The wire's crypto and keys, for tests ───────────────────────────────────────────────────────────────────────

/** The wire's `WireCrypto` over this package's own pure SHA-256 / HMAC (no WebCrypto, no node:crypto; synchronous). */
export const FAKE_WIRE_CRYPTO: WireCrypto = {
  sha256: (data) => sha256(data),
  hmacSha256: (key, data) => hmacSha256(key, data),
};

/** The app secret every fake signs with by default (tests only; at least 32 bytes). */
export const FAKE_APP_SECRET = 'fake-app-secret-for-tests-only-0123456789';
/** The key id the fake platform's default key ring and `fakeClientConfig` use. */
export const FAKE_KEY_ID = 'fake-1';
/** The host's sub secret in the fakes: distinct from every signing secret, as the wire requires (tests only). */
export const FAKE_SUB_SECRET = 'fake-sub-secret-for-tests-only-0123456789abcdef';

/**
 * The pseudonymous subject the fake identity puts in a user claim, computed synchronously: the wire's
 * `pseudonymousSub` derivation (`hex(HMAC(HMAC(subSecret, "platform-sub-v1"), userId))[0..32]`) over the same pure
 * HMAC. `conformance/kit.test.ts` pins it to `pseudonymousSub` itself.
 */
export const fakeSub = (userId: string, subSecret: string = FAKE_SUB_SECRET): string =>
  toHex(hmacSha256(hmacSha256(utf8Bytes(subSecret), WIRE_KEY_LABELS.sub), userId)).slice(0, 32);

// ── Identity ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FakeIdentityOptions {
  /** The authenticated request's user, or null for a request with no session. */
  session: { userId: string } | null;
  app?: string;
  product?: string;
  /** The app secret the claims are signed with (tests only; default `FAKE_APP_SECRET`). */
  appSecret?: string;
  /** The host's sub secret (tests only; default `FAKE_SUB_SECRET`). */
  subSecret?: string;
  tier?: ClaimTier;
  clock?: () => number;
  ids?: () => string;
}

/**
 * An identity port bound to one fake request, minting with the wire's own `mintUserClaim` / `mintServiceClaim`
 * (src/wire), so its claims are exactly what a gateway verifies: `base64url(json) "." base64url(HMAC(claimKey,
 * base64url(json)))`, the wire's default lifetime (120 s), a pseudonymous `sub` from `pseudonymousSub`.
 * `mintUserClaim` rejects without a session; `mintServiceClaim` rejects any purpose but `preview` and any capability
 * outside the preview capabilities (the wire refuses them).
 */
export const createFakeIdentity = (options: FakeIdentityOptions): IdentityPort => {
  const app = options.app || 'dreamstream';
  const product = options.product || 'chat';
  const secret = utf8Bytes(options.appSecret || FAKE_APP_SECRET);
  const subSecret = utf8Bytes(options.subSecret || FAKE_SUB_SECRET);
  const clock = options.clock || (() => Date.now());
  const ids = options.ids || createIdSequence('jti');
  const keys = { secret, crypto: FAKE_WIRE_CRYPTO, now: clock };
  return {
    async mintUserClaim(purpose: ClaimPurpose, caps: readonly CapabilityId[]): Promise<string> {
      if (!options.session || !options.session.userId) throw new Error('No authenticated session: a user claim needs the host to have signed the user in.');
      const sub = await pseudonymousSub(FAKE_WIRE_CRYPTO, subSecret, options.session.userId);
      if (sub === null) throw new Error('No pseudonymous subject for that user.');
      const r = await mintUserClaim(keys, { app, product, sub, tier: options.tier || 'free', purpose, caps, jti: ids() });
      if (r.ok === false) throw new Error(r.message);
      return r.token;
    },
    async mintServiceClaim(purpose: 'preview', caps: readonly ServicePreviewCap[]): Promise<string> {
      if (purpose !== 'preview') throw new Error('A service claim is for previews only.');
      const r = await mintServiceClaim(keys, { app, product, purpose, caps, jti: ids() });
      if (r.ok === false) throw new Error(r.message);
      return r.token;
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
    sub: session ? fakeSub(session.userId) : 'anonymous',
  };
};
