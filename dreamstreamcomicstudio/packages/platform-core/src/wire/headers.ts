/**
 * The wire headers (plan §5.8) and the checks a verifier runs on them.
 *
 * A signed request carries X-Platform-App, X-Platform-Key-Id, X-Platform-Timestamp, X-Platform-Signature and
 * X-Platform-Contract; X-Platform-Claim on every POST that carries a body (and wherever an endpoint wants one);
 * Idempotency-Key on every POST; X-Request-Id optionally (echoed back).
 *
 * Verifying runs in two phases, so a gateway never writes a byte of an unauthenticated body anywhere:
 *   1. `preflightRequest` — everything that does not need the body: the headers' shape, the app allowlist and key
 *      id, the contract, the timestamp skew, the method, the Idempotency-Key, the Content-Length cap and the claim
 *      (MAC, app, time window, purpose, capability). Its result (`stage: 'preflight'`) is NOT authenticated: the
 *      signature has not been checked yet;
 *   2. `verifyRequestSignature` — the signature, once the body has been hashed (while streaming it to staging; a
 *      mismatch means the staged copy is deleted), and the hashed byte count against Content-Length. Only its result
 *      (`stage: 'verified'`, a `VerifiedRequest`) is an authenticated request.
 * `verifyRequest` runs both for a body already in memory (a GET, a small POST, the fake platform).
 */
import { signRequest, verifySignature } from './canonical.js';
import type { CanonicalFields, RequestToSign } from './canonical.js';
import { claimOwner, verifyClaim } from './claim.js';
import type { ClaimRequirement } from './claim.js';
import { isBytes } from './bytes.js';
import { isUsableSecret, sha256Hex } from './crypto.js';
import { inputFailure, internalFailure, wireFailure } from './errors.js';
import type { HeaderBag, PlatformClaim, WireClock, WireCrypto, WireFailure } from './types.js';
import { APP_ID_PATTERN, KEY_ID_PATTERN, PLATFORM_CONTRACT, WIRE_LIMITS } from './types.js';

/** Every header the wire names. */
export const PLATFORM_HEADERS = {
  app: 'X-Platform-App',
  keyId: 'X-Platform-Key-Id',
  timestamp: 'X-Platform-Timestamp',
  signature: 'X-Platform-Signature',
  claim: 'X-Platform-Claim',
  contract: 'X-Platform-Contract',
  idempotencyKey: 'Idempotency-Key',
  requestId: 'X-Request-Id',
  /** Response: the engine that did the work, e.g. `pdfcraft@0.15.0`. */
  engine: 'X-Platform-Engine',
  /** Response: a URL-encoded JSON array of warning strings. */
  warnings: 'X-Platform-Warnings',
  /** Response, server-to-server only: what the call cost, in micro-dollars. */
  costMicros: 'X-Platform-Cost-Micros',
  /** `POST /v1/files`: the file's name, RFC 3986 percent-encoded UTF-8. */
  fileName: 'X-Platform-File-Name',
  /** `POST /v1/convert` keeps its established wire format (plan §5.9): the source file's name, percent-encoded. */
  convertFileName: 'X-Atlas-File-Name',
  /** `POST /v1/convert`: `html` or `pdf`. */
  convertTargetFormat: 'X-Atlas-Target-Format',
} as const;

const APP_ID = new RegExp(APP_ID_PATTERN);
const KEY_ID = new RegExp(KEY_ID_PATTERN);
const CONTENT_LENGTH = /^(0|[1-9][0-9]{0,15})$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

/** True for the only two methods a signed request may use. */
const isSignedMethod = (method: unknown): method is 'GET' | 'POST' => method === 'GET' || method === 'POST';

/** A header from a `Headers`-like getter or a plain record (case-insensitive); null when absent. */
export const readHeader = (bag: HeaderBag | null | undefined, name: string): string | null => {
  if (!bag || typeof bag !== 'object') return null;
  const getter = (bag as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const v = (bag as { get(name: string): string | null }).get(name);
    return typeof v === 'string' ? v : null;
  }
  const lower = name.toLowerCase();
  const keys = Object.keys(bag);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === lower) {
      const v = (bag as { readonly [name: string]: string | undefined })[keys[i]];
      return typeof v === 'string' ? v : null;
    }
  }
  return null;
};

// ── Signing ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SignedHeadersInput extends RequestToSign {
  app: string;
  keyId: string;
  secret: Uint8Array;
  crypto: WireCrypto;
  requestId?: string;
  /**
   * Only for the gateway's own completion callback to a host, which carries no claim (`verifyCallback` refuses one).
   * Every request TO the gateway leaves it unset, so a body POST without a claim is never built.
   */
  callback?: true;
}

export type SignedHeadersResult = { ok: true; headers: Record<string, string>; canonical: string; fields: CanonicalFields } | WireFailure;

/**
 * The headers of a signed request. Refuses (`invalid`) any method but GET and POST (in `canonicalRequest`), a POST
 * without an Idempotency-Key and a POST with a body but no claim, so such a request is never built, let alone sent.
 */
export const signedRequestHeaders = async (input: SignedHeadersInput): Promise<SignedHeadersResult> => {
  if (typeof input !== 'object' || input === null) return inputFailure('input', 'no request to sign');
  if (typeof input.app !== 'string' || !APP_ID.test(input.app)) return inputFailure('input', 'app must be a platform app id');
  if (typeof input.keyId !== 'string' || !KEY_ID.test(input.keyId)) return inputFailure('input', 'keyId must be a platform key id');
  const hasKey = input.idempotencyKey !== undefined && input.idempotencyKey !== null;
  const hasClaim = input.claim !== undefined && input.claim !== null;
  if (input.method === 'POST') {
    if (!hasKey) return inputFailure('idempotency-key', 'every POST needs an Idempotency-Key');
    const bodyBytes = isBytes(input.body) ? input.body.length : input.bodySha256Hex !== undefined ? -1 : 0;
    if (input.callback === true) {
      if (hasClaim) return inputFailure('malformed', 'a callback carries no claim');
    } else if (bodyBytes !== 0 && !hasClaim) return inputFailure('claim-required', 'a POST that carries a body needs a claim');
  }
  if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId))) {
    return inputFailure('input', 'X-Request-Id must be 1 to 128 characters of [A-Za-z0-9._:-]');
  }
  const signed = await signRequest(input.crypto, input.secret, input);
  if (signed.ok === false) return signed;
  const headers: Record<string, string> = {
    [PLATFORM_HEADERS.app]: input.app,
    [PLATFORM_HEADERS.keyId]: input.keyId,
    [PLATFORM_HEADERS.timestamp]: signed.fields.timestamp,
    [PLATFORM_HEADERS.signature]: signed.signature,
    [PLATFORM_HEADERS.contract]: PLATFORM_CONTRACT,
  };
  if (hasClaim) headers[PLATFORM_HEADERS.claim] = input.claim as string;
  if (signed.fields.idempotencyKey) headers[PLATFORM_HEADERS.idempotencyKey] = signed.fields.idempotencyKey;
  if (input.requestId !== undefined) headers[PLATFORM_HEADERS.requestId] = input.requestId;
  return { ok: true, headers, canonical: signed.canonical, fields: signed.fields };
};

// ── Verifying ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A request as the verifier received it. */
export interface IncomingRequest {
  method: string;
  /** The path and, after `?`, the raw query, as received (`url.pathname + url.search`). */
  target: string;
  headers: HeaderBag;
}

export interface PreflightOptions {
  crypto: WireCrypto;
  now: WireClock;
  /** The app allowlist and key ring: the secret for (app, kid), or nothing when either is unknown. */
  keys: (app: string, kid: string) => Uint8Array | null | undefined;
  /**
   * What the endpoint accepts. A `ClaimRequirement` makes a claim mandatory on a POST with a body (and on any
   * request when `claimRequired`); `'none'` is for a callback, which carries no claim.
   */
  claim: ClaimRequirement | 'none';
  /** A claim is required even without a body (a GET that must know its owner). */
  claimRequired?: boolean;
  /** The Content-Length cap for a POST body (default `WIRE_LIMITS.maxRequestBytes`, so leaving it out never uncaps). */
  maxBodyBytes?: number;
  /** The contract majors this side serves (default: the current one). */
  contracts?: readonly string[];
}

/** What the two phases establish about a request. */
export interface SignedRequestFacts {
  app: string;
  kid: string;
  /** The key the request must be signed with (kept for phase 2; never log it). */
  secret: Uint8Array;
  method: string;
  target: string;
  timestamp: string;
  signature: string;
  claimToken: string | null;
  claim: PlatformClaim | null;
  /** `sub` for a user claim, `svc` otherwise: the partition the request's jobs and files live in. */
  owner: string;
  idempotencyKey: string | null;
  /** The declared body size (0 for a GET). */
  contentLength: number;
}

/**
 * What phase 1 established. NOT authenticated until `verifyRequestSignature` (phase 2) has checked the signature:
 * the claim's MAC holds, but anyone who has seen one claim can attach it to a request with a made-up signature.
 * Never act on a `Preflight` beyond staging the body for phase 2; gateway code downstream takes a `VerifiedRequest`.
 */
export interface Preflight extends SignedRequestFacts {
  ok: true;
  stage: 'preflight';
}

export type PreflightResult = Preflight | WireFailure;

/** A request whose signature verified over the body actually received: the only authenticated request. */
export interface VerifiedRequest extends SignedRequestFacts {
  ok: true;
  stage: 'verified';
}

export type VerifiedRequestResult = VerifiedRequest | WireFailure;

/** Phase 2's input: the body's bytes, or the SHA-256 hex and the byte count measured while streaming it. */
export type ReceivedBody = { bytes: Uint8Array } | { sha256Hex: string; length: number };

/**
 * Phase 1: every check that does not need the body. Run it before staging a single byte. The order is: headers
 * present and well formed, key ring (app allowlist and key id), contract, timestamp skew (±300 s), method,
 * Idempotency-Key and Content-Length (POST), the body cap (`maxBodyBytes`, by default `WIRE_LIMITS.maxRequestBytes`),
 * then the claim. The result is not authenticated yet: see `Preflight`.
 */
export const preflightRequest = async (req: IncomingRequest, opts: PreflightOptions): Promise<PreflightResult> => {
  if (!req || typeof req !== 'object' || !opts || typeof opts.keys !== 'function') return inputFailure('input', 'preflightRequest needs a request and options');
  const cap = opts.maxBodyBytes !== undefined ? opts.maxBodyBytes : WIRE_LIMITS.maxRequestBytes;
  if (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap < 0) return inputFailure('input', 'maxBodyBytes must be a whole number of bytes');
  const h = (name: string) => readHeader(req.headers, name);
  const app = h(PLATFORM_HEADERS.app);
  const kid = h(PLATFORM_HEADERS.keyId);
  const ts = h(PLATFORM_HEADERS.timestamp);
  const signature = h(PLATFORM_HEADERS.signature);
  if (app === null || kid === null || ts === null || signature === null) return wireFailure('missing-header', 'the request is not signed');
  if (!APP_ID.test(app) || !KEY_ID.test(kid) || !/^(0|[1-9][0-9]{0,11})$/.test(ts) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    return wireFailure('malformed', 'a signing header is malformed');
  }
  let secret: Uint8Array | null | undefined;
  try {
    secret = opts.keys(app, kid);
  } catch {
    secret = null;
  }
  if (!isUsableSecret(secret)) return wireFailure('unknown-key', 'unknown app or key id');

  const contract = h(PLATFORM_HEADERS.contract);
  const contracts = opts.contracts && opts.contracts.length ? opts.contracts : [PLATFORM_CONTRACT];
  if (contract === null || contracts.indexOf(contract) === -1) return wireFailure('contract', `X-Platform-Contract must be one of ${contracts.join(', ')}`);

  let nowMs: number;
  try {
    nowMs = opts.now();
  } catch (e) {
    return internalFailure(e instanceof Error ? e.message : 'the clock failed');
  }
  if (typeof nowMs !== 'number' || !isFinite(nowMs)) return internalFailure('the clock gave no time');
  if (Math.abs(Math.floor(nowMs / 1000) - Number(ts)) > WIRE_LIMITS.skewSeconds) {
    return wireFailure('skew', `X-Platform-Timestamp is more than ${WIRE_LIMITS.skewSeconds} seconds from now`);
  }

  const method = req.method;
  if (!isSignedMethod(method)) return wireFailure('input', 'only GET and POST are signed requests', { code: 'invalid' });
  const keyHeader = h(PLATFORM_HEADERS.idempotencyKey);
  let contentLength = 0;
  if (method === 'POST') {
    if (keyHeader === null || !IDEMPOTENCY_KEY.test(keyHeader)) return wireFailure('idempotency-key', 'every POST needs a valid Idempotency-Key');
    const cl = h('Content-Length');
    if (cl === null || !CONTENT_LENGTH.test(cl)) return wireFailure('length-required', 'a POST needs a decimal Content-Length');
    contentLength = Number(cl);
    if (contentLength > cap) return wireFailure('too-large', `the body is over ${cap} bytes`);
  } else if (keyHeader !== null && !IDEMPOTENCY_KEY.test(keyHeader)) {
    return wireFailure('idempotency-key', 'Idempotency-Key is malformed');
  }

  const claimToken = h(PLATFORM_HEADERS.claim);
  let claim: PlatformClaim | null = null;
  if (opts.claim === 'none') {
    if (claimToken !== null) return wireFailure('malformed', 'this endpoint takes no claim');
  } else {
    const needsClaim = (method === 'POST' && contentLength > 0) || opts.claimRequired === true;
    if (claimToken === null) {
      if (needsClaim) return wireFailure('claim-required', method === 'POST' ? 'a POST that carries a body needs a claim' : 'this endpoint needs a claim');
    } else {
      const v = await verifyClaim(claimToken, { ...opts.claim, app, secret, crypto: opts.crypto, now: opts.now });
      if (v.ok === false) return v;
      claim = v.claim;
    }
  }

  return {
    ok: true,
    stage: 'preflight',
    app,
    kid,
    secret,
    method,
    target: req.target,
    timestamp: ts,
    signature,
    claimToken,
    claim,
    owner: claimOwner(claim),
    idempotencyKey: keyHeader,
    contentLength,
  };
};

/**
 * Phase 2: the signature over the request as received, given the body's bytes or the SHA-256 hex and byte count
 * measured while streaming them. The body must be exactly the declared Content-Length (0 for a GET), so the cap
 * phase 1 checked is the size of what was hashed. Constant-time compare. On success, the request is authenticated.
 */
export const verifyRequestSignature = async (pre: Preflight, crypto: WireCrypto, body: ReceivedBody): Promise<VerifiedRequestResult> => {
  if (!pre || pre.ok !== true || pre.stage !== 'preflight') return inputFailure('input', 'run preflightRequest first');
  if (!body || typeof body !== 'object') return inputFailure('input', 'phase 2 needs the body or its streamed hash and length');
  const bytes = 'bytes' in body ? body.bytes : null;
  let length: number;
  if (bytes !== null) {
    if (!isBytes(bytes)) return inputFailure('input', 'the body must be bytes');
    length = bytes.length;
  } else {
    // The hash itself is checked (64 lower-case hex characters) when the signed string is rebuilt.
    const streamed = body as { length: unknown };
    if (typeof streamed.length !== 'number' || !Number.isSafeInteger(streamed.length) || streamed.length < 0) {
      return inputFailure('input', 'a streamed body needs the number of bytes that were hashed');
    }
    length = streamed.length;
  }
  // The cap phase 1 checked was the declared length: what was hashed must be exactly that many bytes.
  if (length !== pre.contentLength) return wireFailure('bad-signature', 'the body is not the declared length');
  let bodySha256Hex: string;
  try {
    bodySha256Hex = bytes !== null ? await sha256Hex(crypto, bytes) : (body as { sha256Hex: string }).sha256Hex;
  } catch (e) {
    return internalFailure(e instanceof Error ? e.message : 'crypto failed');
  }
  const v = await verifySignature(
    crypto,
    pre.secret,
    { method: pre.method, target: pre.target, timestamp: pre.timestamp, bodySha256Hex, claim: pre.claimToken, idempotencyKey: pre.idempotencyKey },
    pre.signature,
  );
  if (v.ok === false) return v;
  return {
    ok: true,
    stage: 'verified',
    app: pre.app,
    kid: pre.kid,
    secret: pre.secret,
    method: pre.method,
    target: pre.target,
    timestamp: pre.timestamp,
    signature: pre.signature,
    claimToken: pre.claimToken,
    claim: pre.claim,
    owner: pre.owner,
    idempotencyKey: pre.idempotencyKey,
    contentLength: pre.contentLength,
  };
};

/** Both phases for a body already in memory (a GET, a small POST, the fake platform). */
export const verifyRequest = async (req: IncomingRequest, body: Uint8Array | null, opts: PreflightOptions): Promise<VerifiedRequestResult> => {
  const pre = await preflightRequest(req, opts);
  if (pre.ok === false) return pre;
  return verifyRequestSignature(pre, opts.crypto, { bytes: body || new Uint8Array(0) });
};

// ── Response headers ────────────────────────────────────────────────────────────────────────────────────────────

/** `X-Platform-Warnings`: a URL-encoded JSON array of strings. Never throws; anything malformed reads as none. */
export const parseWarnings = (value: string | null | undefined): string[] => {
  if (typeof value !== 'string' || !value.length || value.length > 32768) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(value));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (let i = 0; i < parsed.length && out.length < WIRE_LIMITS.warningsMax; i++) {
    const w = parsed[i];
    if (typeof w === 'string' && w.length) out.push(w.length > WIRE_LIMITS.warningMax ? `${w.slice(0, WIRE_LIMITS.warningMax - 1)}…` : w);
  }
  return out;
};

/** The gateway's side of `X-Platform-Warnings`. */
export const encodeWarnings = (warnings: readonly string[]): string => encodeURIComponent(JSON.stringify(warnings.slice(0, WIRE_LIMITS.warningsMax)));

/** `X-Platform-Cost-Micros`: a non-negative whole number, or undefined. */
export const parseCostMicros = (value: string | null | undefined): number | undefined => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,14})$/.test(value)) return undefined;
  return Number(value);
};
