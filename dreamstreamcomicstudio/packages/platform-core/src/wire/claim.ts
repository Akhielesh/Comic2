/**
 * Claims (plan §5.8): who a signed request acts for, for what purpose, with which capabilities, until when.
 *
 *   claim = base64url(json) + "." + base64url(HMAC-SHA256(claimKey, base64url(json)))
 *   claimKey = HMAC-SHA256(appSecret, "platform-claim-v1")
 *
 * - A **user** claim is minted by a host only after its own auth; `sub` is pseudonymous (`pseudonymousSub`) and
 *   `tier` drives the gateway's count quotas.
 * - A **service** claim carries no user: purpose `preview` and the preview capabilities only. Minting refuses
 *   anything else, and so does verifying (a buggy or compromised minter cannot widen it).
 * - `exp` is Unix seconds, after now and at most `WIRE_LIMITS.claimTtlMaxSeconds` ahead, both at mint and at verify.
 * - The MAC is checked (in constant time) before the payload is even decoded; the payload is then validated with the
 *   schema DSL (exact fields, caps, unknown keys rejected).
 */
import { check, s } from '../schema/index.js';
import { base64urlDecode, base64urlEncode, constantTimeEqualText, toHex, utf8Decode, utf8Encode } from './bytes.js';
import { deriveWireKey, hmac, isUsableSecret } from './crypto.js';
import { inputFailure, internalFailure, wireFailure } from './errors.js';
import type {
  ClaimCapability,
  ClaimPurpose,
  ClaimTier,
  PlatformClaim,
  PreviewCapability,
  ServiceClaim,
  UserClaim,
  UserClaimPurpose,
  WireClock,
  WireCrypto,
  WireFailure,
} from './types.js';
import {
  APP_ID_PATTERN,
  CAPABILITY_ID_PATTERN,
  CLAIM_TIERS,
  PREVIEW_CAPABILITIES,
  PRODUCT_ID_PATTERN,
  SUB_PATTERN,
  USER_CLAIM_PURPOSES,
  WIRE_LIMITS,
} from './types.js';

// ── Schema ──────────────────────────────────────────────────────────────────────────────────────────────────────

const appId = s.text({ max: 32, pattern: APP_ID_PATTERN, singleLine: true });
const productId = s.text({ max: 32, pattern: PRODUCT_ID_PATTERN, singleLine: true });
const capability = s.text({ max: 64, pattern: CAPABILITY_ID_PATTERN, singleLine: true });
/** Unix seconds up to the year 2286; a claim's window is checked against the clock separately. */
const unixSeconds = s.int({ min: 0, max: 9999999999 });
const ALL_PURPOSES: readonly ClaimPurpose[] = [...USER_CLAIM_PURPOSES, 'preview'];

const UserClaimS = s.object({
  v: s.literal(1),
  kind: s.literal('user'),
  app: appId,
  product: productId,
  sub: s.text({ max: 32, pattern: SUB_PATTERN, singleLine: true }),
  ws: s.optional(s.id()),
  tier: s.enum(CLAIM_TIERS),
  purpose: s.enum(USER_CLAIM_PURPOSES),
  caps: s.array(capability, { max: WIRE_LIMITS.claimCapsMax }),
  exp: unixSeconds,
  jti: s.id(),
});

/**
 * A service claim's purpose and caps are read with the GENERAL shapes here and narrowed by `serviceScopeError`, so a
 * well-formed service claim that reaches beyond preview is reported as `service-scope` (forbidden), not as a
 * malformed token.
 */
const ServiceClaimS = s.object({
  v: s.literal(1),
  kind: s.literal('service'),
  app: appId,
  product: productId,
  purpose: s.enum(ALL_PURPOSES),
  caps: s.array(capability, { min: 1, max: WIRE_LIMITS.claimCapsMax }),
  exp: unixSeconds,
  jti: s.id(),
});

const ClaimS = s.union('kind', [UserClaimS, ServiceClaimS]);

const isPreviewCapability = (cap: string): cap is PreviewCapability => (PREVIEW_CAPABILITIES as readonly string[]).indexOf(cap) !== -1;

/** Why a service claim reaches beyond preview, or null when it does not. */
const serviceScopeError = (purpose: unknown, caps: readonly unknown[]): string | null => {
  if (purpose !== 'preview') return `a service claim's purpose is preview, not ${String(purpose).slice(0, 40)}`;
  for (let i = 0; i < caps.length; i++) {
    if (typeof caps[i] !== 'string' || !isPreviewCapability(caps[i] as string)) {
      return `a service claim carries only ${PREVIEW_CAPABILITIES.join(', ')}, not ${String(caps[i]).slice(0, 64)}`;
    }
  }
  return null;
};

// ── Mint ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a host's identity port knows after its own auth. */
export interface UserClaimInput {
  app: string;
  product: string;
  /** `pseudonymousSub(…)`, never the host's user id. */
  sub: string;
  ws?: string;
  tier: ClaimTier;
  purpose: UserClaimPurpose;
  caps: readonly ClaimCapability[];
  /** Default `WIRE_LIMITS.claimTtlDefaultSeconds`; at most `WIRE_LIMITS.claimTtlMaxSeconds`. */
  ttlSeconds?: number;
  /** An id (`ID_PATTERN`) for audit correlation; random (`WireCrypto.randomBytes`) when absent. */
  jti?: string;
}

export interface ServiceClaimInput {
  app: string;
  product: string;
  /** Always `preview`; anything else is refused. */
  purpose?: 'preview';
  caps: readonly PreviewCapability[];
  ttlSeconds?: number;
  jti?: string;
}

/** The secret, crypto and clock a minter or verifier is handed. */
export interface ClaimKeyring {
  /** The app secret for the key id the request is signed with. */
  secret: Uint8Array;
  crypto: WireCrypto;
  now: WireClock;
}

export type MintClaimResult<C extends PlatformClaim> = { ok: true; token: string; claim: C } | WireFailure;

const nowSeconds = (now: WireClock): number | null => {
  const ms = now();
  return typeof ms === 'number' && isFinite(ms) && ms >= 0 ? Math.floor(ms / 1000) : null;
};

const ttlOf = (ttl: unknown): number | null => {
  if (ttl === undefined) return WIRE_LIMITS.claimTtlDefaultSeconds;
  return typeof ttl === 'number' && Number.isSafeInteger(ttl) && ttl >= 1 && ttl <= WIRE_LIMITS.claimTtlMaxSeconds ? ttl : null;
};

const jtiOf = (crypto: WireCrypto, jti: unknown): string | null => {
  if (jti !== undefined) return typeof jti === 'string' ? jti : null;
  if (typeof crypto.randomBytes !== 'function') return null;
  const bytes = crypto.randomBytes(16);
  return bytes instanceof Uint8Array && bytes.length === 16 ? toHex(bytes) : null;
};

/** `base64url(json).base64url(HMAC(key, base64url(json)))`. */
export const sealToken = async (crypto: WireCrypto, key: Uint8Array, payload: object): Promise<string> => {
  const body = base64urlEncode(utf8Encode(JSON.stringify(payload)));
  return `${body}.${base64urlEncode(await hmac(crypto, key, utf8Encode(body)))}`;
};

const mint = async <C extends PlatformClaim>(keys: ClaimKeyring, payload: C): Promise<MintClaimResult<C>> => {
  const r = check(ClaimS, payload);
  if (r.ok === false) {
    const e = r.errors[0];
    return inputFailure('input', `the claim is not valid: ${e.path || 'claim'} ${e.message}`);
  }
  try {
    const key = await deriveWireKey(keys.crypto, keys.secret, 'claim');
    return { ok: true, token: await sealToken(keys.crypto, key, payload), claim: payload };
  } catch (e) {
    return internalFailure(e instanceof Error ? e.message : 'crypto failed');
  }
};

const preamble = (keys: ClaimKeyring, ttlSeconds: unknown, jtiInput: unknown): { exp: number; jti: string } | WireFailure => {
  if (!keys || !isUsableSecret(keys.secret)) return inputFailure('input', `the app secret must be at least ${WIRE_LIMITS.secretMinBytes} bytes`);
  let now: number | null;
  try {
    now = nowSeconds(keys.now);
  } catch (e) {
    return internalFailure(e instanceof Error ? e.message : 'the clock failed');
  }
  if (now === null) return internalFailure('the clock gave no time');
  const ttl = ttlOf(ttlSeconds);
  if (ttl === null) return inputFailure('exp-too-far', `a claim lives 1 to ${WIRE_LIMITS.claimTtlMaxSeconds} seconds`);
  let jti: string | null;
  try {
    jti = jtiOf(keys.crypto, jtiInput);
  } catch (e) {
    return internalFailure(e instanceof Error ? e.message : 'randomBytes failed');
  }
  if (jti === null) return inputFailure('input', 'a claim needs a jti: pass one, or give WireCrypto a randomBytes');
  return { exp: now + ttl, jti };
};

/** Mint a user claim. Call it only after the host's own auth. */
export const mintUserClaim = async (keys: ClaimKeyring, input: UserClaimInput): Promise<MintClaimResult<UserClaim>> => {
  if (typeof input !== 'object' || input === null) return inputFailure('input', 'no claim input');
  const pre = preamble(keys, input.ttlSeconds, input.jti);
  if ('ok' in pre) return pre;
  // Fields are added in the documented order (the golden vectors pin the bytes); `ws` only when given.
  const claim = { v: 1, kind: 'user', app: input.app, product: input.product, sub: input.sub } as UserClaim;
  if (input.ws !== undefined) claim.ws = input.ws;
  claim.tier = input.tier;
  claim.purpose = input.purpose;
  claim.caps = Array.isArray(input.caps) ? input.caps.slice() : (input.caps as unknown as string[]);
  claim.exp = pre.exp;
  claim.jti = pre.jti;
  return mint(keys, claim);
};

/** Mint a service claim: purpose `preview` and preview capabilities only, or a `service-scope` refusal. */
export const mintServiceClaim = async (keys: ClaimKeyring, input: ServiceClaimInput): Promise<MintClaimResult<ServiceClaim>> => {
  if (typeof input !== 'object' || input === null) return inputFailure('input', 'no claim input');
  const purpose = input.purpose === undefined ? 'preview' : input.purpose;
  const caps = Array.isArray(input.caps) ? input.caps.slice() : null;
  if (caps === null || !caps.length) return inputFailure('input', 'a service claim needs at least one preview capability');
  const scope = serviceScopeError(purpose, caps);
  if (scope !== null) return inputFailure('service-scope', scope);
  const pre = preamble(keys, input.ttlSeconds, input.jti);
  if ('ok' in pre) return pre;
  return mint<ServiceClaim>(keys, { v: 1, kind: 'service', app: input.app, product: input.product, purpose: 'preview', caps, exp: pre.exp, jti: pre.jti });
};

// ── Verify ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** What an endpoint accepts. */
export interface ClaimRequirement {
  /** The purposes the endpoint accepts (a service claim's is always `preview`). Required: never "any". */
  purposes: readonly ClaimPurpose[];
  /** A capability the claim must carry. */
  capability?: ClaimCapability;
  /** The products the endpoint serves for this app. */
  products?: readonly string[];
}

export interface VerifyClaimOptions extends ClaimKeyring, ClaimRequirement {
  /** The app the request is signed for (X-Platform-App); the claim must name it. */
  app: string;
}

export type VerifyClaimResult = { ok: true; claim: PlatformClaim } | WireFailure;

/**
 * Verify a claim: shape and size, MAC (constant time), payload schema, service scope, app, time window (`exp` after
 * now and at most `WIRE_LIMITS.claimTtlMaxSeconds` ahead), purpose, capability and product, in that order.
 */
export const verifyClaim = async (token: string, opts: VerifyClaimOptions): Promise<VerifyClaimResult> => {
  if (!opts || !isUsableSecret(opts.secret)) return wireFailure('unknown-key', 'the key ring holds no usable secret for this key id');
  if (!Array.isArray(opts.purposes) || !opts.purposes.length) return inputFailure('input', 'verifyClaim needs the purposes the endpoint accepts');
  if (typeof token !== 'string' || token.length > WIRE_LIMITS.claimTokenMax) return wireFailure('malformed', 'X-Platform-Claim is missing or too long');
  const dot = token.indexOf('.');
  const body = dot === -1 ? '' : token.slice(0, dot);
  const mac = dot === -1 ? '' : token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]{43}$/.test(mac)) return wireFailure('malformed', 'X-Platform-Claim is not a claim token');

  let expected: string;
  try {
    const key = await deriveWireKey(opts.crypto, opts.secret, 'claim');
    expected = base64urlEncode(await hmac(opts.crypto, key, utf8Encode(body)));
  } catch (e) {
    return internalFailure(e instanceof Error ? e.message : 'crypto failed');
  }
  if (!constantTimeEqualText(expected, mac)) return wireFailure('bad-signature', 'the claim does not verify');

  const bytes = base64urlDecode(body);
  const json = bytes ? utf8Decode(bytes) : null;
  let parsed: unknown;
  try {
    parsed = json === null ? undefined : JSON.parse(json);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) return wireFailure('malformed', 'the claim payload is not JSON');
  const r = check(ClaimS, parsed);
  if (r.ok === false) {
    const e = r.errors[0];
    return wireFailure('malformed', `the claim payload is not valid: ${e.path || 'claim'} ${e.message}`);
  }
  const claim = r.value as PlatformClaim;

  if (claim.kind === 'service') {
    const scope = serviceScopeError(claim.purpose, claim.caps);
    if (scope !== null) return wireFailure('service-scope', scope);
  }
  if (claim.app !== opts.app) return wireFailure('wrong-app', 'the claim is for another app');

  let now: number | null;
  try {
    now = nowSeconds(opts.now);
  } catch (e) {
    return internalFailure(e instanceof Error ? e.message : 'the clock failed');
  }
  if (now === null) return internalFailure('the clock gave no time');
  if (claim.exp <= now) return wireFailure('expired', 'the claim has expired');
  if (claim.exp > now + WIRE_LIMITS.claimTtlMaxSeconds) {
    return wireFailure('exp-too-far', `the claim expires more than ${WIRE_LIMITS.claimTtlMaxSeconds} seconds from now`);
  }

  if (opts.purposes.indexOf(claim.purpose) === -1) return wireFailure('wrong-purpose', `this endpoint does not accept a ${claim.purpose} claim`);
  if (opts.capability !== undefined && (claim.caps as readonly string[]).indexOf(opts.capability) === -1) {
    return wireFailure('capability', `the claim does not carry ${opts.capability}`);
  }
  if (opts.products !== undefined && opts.products.indexOf(claim.product) === -1) return wireFailure('wrong-product', 'this endpoint does not serve that product');
  return { ok: true, claim };
};

/** The owner a request acts for: the user's pseudonymous sub, or `svc` for a service claim (plan §2, §9). */
export const claimOwner = (claim: PlatformClaim | null): string => (claim && claim.kind === 'user' ? claim.sub : 'svc');
