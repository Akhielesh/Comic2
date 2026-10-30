/**
 * The wire's types and limits (plan §5.8, §5.9, §9): what crosses HTTPS between a host (DreamStream, an external
 * consumer) and the platform gateway, and what the gateway, the client and the fake platform must agree on.
 *
 * Nothing here reaches a global: crypto (`WireCrypto`), the clock (`WireClock`) and `fetch` (`FetchLike`) are
 * injected by the host, so the same code runs in browsers, the backend, a Worker and an external Node server.
 *
 * Results never throw. With `strict` off (the backend), narrow with `r.ok === false` (`if (!r.ok)` does not narrow
 * there).
 */
import type { PlatformFailure } from '../errors.js';

// ── Injected capabilities ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The crypto the wire needs, injected by the host. `wireCryptoFromSubtle()` (./crypto.ts) builds one from WebCrypto
 * (browsers, Workers, Node's `crypto.subtle`); a Node host may wrap `node:crypto` (`createHash`, `createHmac`).
 * Either may answer synchronously or with a promise.
 */
export interface WireCrypto {
  /** SHA-256 of `data` (32 bytes). */
  sha256(data: Uint8Array): Uint8Array | PromiseLike<Uint8Array>;
  /** HMAC-SHA256 of `data` under `key` (32 bytes). */
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array | PromiseLike<Uint8Array>;
  /** `length` cryptographically random bytes; only needed to mint a claim without an explicit `jti`. */
  randomBytes?(length: number): Uint8Array;
}

/** Milliseconds since the Unix epoch, e.g. `Date.now`. Injected: nothing in the wire reads a global clock. */
export type WireClock = () => number;

/** Request headers, as a `Headers`-like getter or a plain record (looked up case-insensitively). */
export type HeaderBag = { get(name: string): string | null } | { readonly [name: string]: string | undefined };

/**
 * The slice of `fetch` the client uses. The platform's own `fetch` (browsers, Node 18+, Workers) satisfies it; a
 * host wraps it to add a timeout (`AbortSignal.timeout`) or a proxy. The client always sends `redirect: 'error'`:
 * the gateway never redirects, and a redirect must not carry a signed request to another host.
 */
export type FetchLike = (url: string, init: FetchInitLike) => PromiseLike<FetchResponseLike>;

export interface FetchInitLike {
  method: string;
  headers: Record<string, string>;
  /** Exactly the bytes that were signed; absent on a GET. */
  body?: ArrayBuffer;
  redirect: 'error';
}

export interface FetchResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): PromiseLike<ArrayBuffer>;
}

// ── Limits ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every bound the wire enforces. MB is 10^6 bytes, as everywhere in the contract. */
export const WIRE_LIMITS = {
  /** `X-Platform-Timestamp` may differ from the verifier's clock by at most this many seconds (plan §5.8). */
  skewSeconds: 300,
  /** A claim's `exp` is at most this far ahead of the verifier's clock (user and service claims alike). */
  claimTtlMaxSeconds: 300,
  /**
   * The lifetime `mintUserClaim` / `mintServiceClaim` give by default. Shorter than the maximum on purpose: a
   * minter whose clock runs up to 180 s ahead of the verifier's still mints an `exp` the verifier accepts.
   */
  claimTtlDefaultSeconds: 120,
  /** A poll token lives at most one hour. */
  pollTtlMaxSeconds: 3600,
  pollTtlDefaultSeconds: 900,
  /** `Idempotency-Key`: 1 to 128 characters of `[A-Za-z0-9._:-]`. */
  idempotencyKeyMax: 128,
  /** The longest claim token a verifier reads (it refuses longer ones before any crypto). */
  claimTokenMax: 4096,
  /** The longest poll token a verifier reads. */
  pollTokenMax: 2048,
  /** Capabilities one claim may carry. */
  claimCapsMax: 32,
  /** A secret (an app's signing key) has at least this many bytes. */
  secretMinBytes: 32,
  /** The longest request path, and the longest raw query, the signer accepts. */
  pathMax: 1024,
  queryMax: 2048,
  /** Query parameters per request. */
  queryParamsMax: 64,
  /** The biggest request body the client sends (plan §5.9: convert, extract and files take at most 50 MB). */
  maxRequestBytes: 50000000,
  /** The biggest response body the client reads, unless its config says otherwise. */
  maxResponseBytes: 64000000,
  /** `?maxPages=` on `/v1/extract`: default 24, at most 300. */
  extractDefaultPages: 24,
  extractMaxPages: 300,
  /** `X-Platform-Warnings`: at most this many warnings of at most this many characters are read. */
  warningsMax: 32,
  warningMax: 500,
  /** A file name sent in `X-Platform-File-Name` (before percent-encoding). */
  fileNameMax: 255,
  /** The longest gateway error message the client keeps. */
  errorMessageMax: 2000,
  /** The biggest callback body `verifyCallback` reads. */
  callbackBodyMax: 65536,
} as const;

/** The contract major every request carries in `X-Platform-Contract`. */
export const PLATFORM_CONTRACT = '1';

// ── Identifiers (ECMAScript sources, matched with the `u` flag; anchors written out) ──────────────────────────

/** An app id: `dreamstream`, `atlas`. */
export const APP_ID_PATTERN = '^[a-z][a-z0-9-]{1,31}$';
/** A key id (`X-Platform-Key-Id`), e.g. `ds-2026-11`. */
export const KEY_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$';
/** A product id inside a claim: `comic`, `chat`, `atlas`. */
export const PRODUCT_ID_PATTERN = '^[a-z][a-z0-9_-]{0,31}$';
/** A pseudonymous subject: 32 lower-case hex characters (`pseudonymousSub`). */
export const SUB_PATTERN = '^[0-9a-f]{32}$';
/** A capability id: `doc.extract`, `richdoc.export`. */
export const CAPABILITY_ID_PATTERN = '^[a-z][a-z0-9]*(\\.[a-z][a-z0-9-]*)+$';
/** `Idempotency-Key`. */
export const IDEMPOTENCY_KEY_PATTERN = '^[A-Za-z0-9._:-]{1,128}$';
/** A file reference the gateway hands out (`/v1/files`), also a path segment. */
export const FILE_REF_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$';
/** A job id, also a path segment. */
export const JOB_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$';

// ── Claims (plan §5.8) ──────────────────────────────────────────────────────────────────────────────────────────

/** Host-set tiers, for the gateway's count quotas. */
export const CLAIM_TIERS = ['free', 'creator', 'studio', 'admin', 'atlas-beta'] as const;
export type ClaimTier = (typeof CLAIM_TIERS)[number];

/** What a user claim is for. */
export const USER_CLAIM_PURPOSES = ['compose', 'render', 'extract', 'pdf', 'export', 'job-read'] as const;
export type UserClaimPurpose = (typeof USER_CLAIM_PURPOSES)[number];

/** Every purpose a claim can name: the user purposes and the service-only `preview`. */
export type ClaimPurpose = UserClaimPurpose | 'preview';

/**
 * The only capabilities a service claim can carry. A service claim (a host's background preview pipeline, no user)
 * can never reach PDF editing, render or jobs: `mintServiceClaim` and `verifyClaim` both refuse anything else.
 */
export const PREVIEW_CAPABILITIES = ['doc.convert', 'doc.extract', 'doc.thumbnail'] as const;
export type PreviewCapability = (typeof PREVIEW_CAPABILITIES)[number];

/**
 * A capability id inside a claim. The wire does not know the capability registry (src/capabilities.ts); it checks
 * the shape (`CAPABILITY_ID_PATTERN`) and the gateway checks the id against the endpoint.
 */
export type ClaimCapability = string;

/** A user claim: minted only after the host's own auth. `sub` is pseudonymous (`pseudonymousSub`). */
export interface UserClaim {
  v: 1;
  kind: 'user';
  app: string;
  product: string;
  sub: string;
  /** The host's workspace id, when the user acts inside one. */
  ws?: string;
  tier: ClaimTier;
  purpose: UserClaimPurpose;
  caps: ClaimCapability[];
  /** Unix seconds; at most `WIRE_LIMITS.claimTtlMaxSeconds` ahead of the verifier's clock. */
  exp: number;
  /** For audit correlation only; replay safety comes from `Idempotency-Key`. */
  jti: string;
}

/** A service claim: no user, `preview` only, preview capabilities only, app-level quotas. */
export interface ServiceClaim {
  v: 1;
  kind: 'service';
  app: string;
  product: string;
  purpose: 'preview';
  caps: PreviewCapability[];
  exp: number;
  jti: string;
}

export type PlatformClaim = UserClaim | ServiceClaim;

// ── Poll tokens (plan §5.8) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * What a poll token proves: GET access to one job of one (app, sub) until `exp`. `kid` names the app key that
 * signed it, so a verifier finds the key during a rotation overlap.
 */
export interface PollTokenPayload {
  v: 1;
  kind: 'poll';
  app: string;
  kid: string;
  sub: string;
  jobId: string;
  /** Unix seconds; at most `WIRE_LIMITS.pollTtlMaxSeconds` ahead. */
  exp: number;
}

// ── Failures ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Why the wire refused something; `code` (the HTTP-facing class) is derived from it, see `WIRE_REASON_CODES`. */
export const WIRE_REASONS = [
  // unauthorized (401)
  'missing-header', // a required X-Platform-* header is absent
  'malformed', // a header, claim or token is not in its exact form
  'unknown-key', // the (app, key id) pair is not in the key ring, or its secret is unusable
  'bad-signature', // the request signature, claim MAC or token MAC does not verify
  'skew', // X-Platform-Timestamp is more than WIRE_LIMITS.skewSeconds away from now
  'expired', // a claim's or token's exp has passed
  'exp-too-far', // a claim's or token's exp is further ahead than its maximum lifetime
  'claim-required', // a POST that carries a body (or an endpoint that requires one) has no claim
  'wrong-app', // the claim's app is not the app the request is signed for
  // forbidden (403)
  'wrong-purpose', // the claim's purpose is not one the endpoint accepts
  'capability', // the claim does not carry the endpoint's capability
  'wrong-product', // the claim's product is not one the endpoint accepts
  'service-scope', // a service claim with a purpose other than preview or a non-preview capability
  'wrong-job', // a poll token for another job
  'method', // a poll token on anything but GET
  // invalid (400)
  'idempotency-key', // a POST without a valid Idempotency-Key
  'length-required', // a POST without a decimal Content-Length
  'path', // a request path that is not in canonical form
  'query', // a malformed query (bad escape, duplicate or empty key, too long)
  'contract', // X-Platform-Contract names a contract this side does not speak
  'input', // a bad argument to a signing, minting or client call
  // too-large (413)
  'too-large', // a body over its cap
  // engine-failed (502)
  'network', // fetch failed (DNS, TLS, reset, redirect refused)
  'response', // the gateway's answer is not what the contract says
  'internal', // an injected crypto or clock failed
  // the gateway answered with an error (the code comes from it)
  'gateway',
] as const;

export type WireReason = (typeof WIRE_REASONS)[number];

/** A refusal: a `PlatformFailure` plus why. */
export interface WireFailure extends PlatformFailure {
  reason: WireReason;
}
