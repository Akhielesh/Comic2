/**
 * Host ports (plan §5.6): the interfaces core needs from every host. Each host implements them over its OWN auth,
 * ledger, consent UI, audit sinks and model, so the platform never logs anyone in, holds a token, spends money or
 * calls a model. The conformance kit (src/testing/conformance.ts) fails when an implementation breaks a rule below.
 */
import type { CapabilityId } from '../capabilities.js';
import type { Schema } from '../contract/schema.js';
import type { DraftAction } from './consent.js';

// AuditPort and PlatformAuditEvent live in src/audit/event.ts (re-exported by ./gates).

/** What a user claim lets the gateway do (wire claims, plan §5.8). */
export const CLAIM_PURPOSES = ['compose', 'render', 'extract', 'pdf', 'export', 'job-read'] as const;
export type ClaimPurpose = (typeof CLAIM_PURPOSES)[number];

/** The only capabilities a service claim (no user: background previews) may ever carry. */
export const SERVICE_PREVIEW_CAPS = ['doc.convert', 'doc.extract', 'doc.thumbnail'] as const;
export type ServicePreviewCap = (typeof SERVICE_PREVIEW_CAPS)[number];

/**
 * Mints the short-lived signed claims the gateway accepts. Bound to ONE incoming request by the host.
 * - `mintUserClaim` rejects (throws) unless the host's own auth has authenticated that request.
 * - `mintServiceClaim` exists only where a host previews files in the background; its caps are a subset of
 *   `SERVICE_PREVIEW_CAPS` and anything else is rejected.
 */
export interface IdentityPort {
  mintUserClaim(purpose: ClaimPurpose, caps: readonly CapabilityId[]): Promise<string>;
  mintServiceClaim?(purpose: 'preview', caps: readonly ServicePreviewCap[]): Promise<string>;
}

/** What a platform cost row records (`metadata.platform`): ids only, never content. */
export interface PlatformCostMetadata {
  app: string;
  product: string;
  tool?: string;
  capability?: string;
  flow?: string;
  engine?: string;
  inputHash?: string;
}

export type MeterReserveResult =
  | { ok: true; reservationId: string }
  /** `quota`: the budget says no. `unavailable`: the ledger could not be asked (fail closed for governed users). */
  | { ok: false; code: 'quota' | 'unavailable'; message: string };

/**
 * `claimed`: this caller now owns the open reservation. `used`: it was claimed, settled or released before.
 * `unknown`: the ledger has no such reservation. `unavailable`: the ledger could not be asked (fail closed: 503).
 */
export type MeterClaimResult = 'claimed' | 'used' | 'unknown' | 'unavailable';

export type MeterSettleResult = { ok: true } | { ok: false; code: 'conflict' | 'unavailable'; message: string };

/** Light engine jobs reserve this much for a governed user (plan §5.6), heavy ones `JOB_FLOOR_HEAVY_USD`. */
export const JOB_FLOOR_USD = 0.002;
export const JOB_FLOOR_HEAVY_USD = 0.003;

/**
 * The host's usage ledger. DreamStream: reserve/settle/release over its existing reservation API, with
 * `operation: 'platform_<tool>'` or `'platform_flow'`.
 * - `reserve` NEVER throws: with the ledger down it answers `{ok:false, code:'unavailable'}` for a governed user
 *   (fail closed).
 * - `claim` NEVER throws either: it atomically turns an OPEN reservation into one owned by this caller (the single-use
 *   guard behind a plan token), a second claim of the same id answers `used`, and with the ledger down it answers
 *   `unavailable` (core still treats a throw as `unavailable`).
 * - `settle` / `release` close it; closing twice answers `conflict`. A close that throws or answers `{ok:false}` leaves
 *   a stranded hold: core reports it (`settleFailed`, audit `settle-failed` / `release-failed`) and never retries.
 * - A sweep of open holds must RELEASE an unclaimed `platform_flow` or `platform_<tool>` hold, never settle it at its
 *   held cost: an unclaimed hold is a plan nobody approved or a call that never ran.
 */
export interface MeterPort {
  /** Whether this user's spend is governed (the shared allowance; never shown in dollars). */
  readonly governed: boolean;
  reserve(input: { operation: string; estimateFloorUsd: number; metadata: { platform: PlatformCostMetadata } }): Promise<MeterReserveResult>;
  claim(reservationId: string): Promise<MeterClaimResult>;
  settle(reservationId: string, input: { actualUsd: number; metadata?: { platform: PlatformCostMetadata } }): Promise<MeterSettleResult>;
  release(reservationId: string, input?: { reason?: string }): Promise<MeterSettleResult>;
}

/** Records a draft action a person may later approve with a click in the host (consent.ts). */
export interface ApproverPort {
  draft(action: DraftAction): void | Promise<void>;
}

/** One JSON completion on the host's own model. The platform never calls a model itself. */
export interface LlmCompleteRequest<T> {
  /** A versioned prompt pack name (`emailDraft.v1`). */
  promptPack: string;
  input: unknown;
  schema: Schema<T>;
  maxTokens: number;
}

export type LlmCompleteResult<T> =
  | { ok: true; value: T; usd?: number }
  | { ok: false; code: 'invalid' | 'engine-failed' | 'timeout' | 'quota'; message: string; usd?: number };

export interface LlmPort {
  complete<T>(request: LlmCompleteRequest<T>): Promise<LlmCompleteResult<T>>;
}
