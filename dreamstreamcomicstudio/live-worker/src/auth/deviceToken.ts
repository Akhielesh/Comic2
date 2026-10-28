/**
 * Device grants, device access tokens and DS-Proof (ADR 0006 D4.4) — how a watch (and later a
 * native app) talks to us without ever holding an account token.
 *
 *   enroll   a signed-in phone (parent or caregiver) registers the watch's hardware key
 *            (live_device_enroll) and receives a GRANT for it: an ES256 JWT bound to the key's
 *            RFC 7638 thumbprint (`cnf.jkt`), 30 days.
 *   token    the watch trades the grant (+ a DS-Proof made with its hardware key) for a
 *            10-minute ACCESS token. The Worker checks live_device_active first, so a revoked
 *            device stops getting tokens at once; one already issued lapses within 10 minutes.
 *   use      every request carries the access token and a fresh DS-Proof. A stolen token without
 *            the Secure Enclave / Keystore key is useless; a captured request can't be replayed
 *            (±60 s window, nonce seen once).
 *
 * Key: the Worker secret DEVICE_TOKEN_JWK — a P-256 private JWK from
 * scripts/ops/genDeviceTokenKey.mjs, or `{"keys":[new, old]}` while rotating (the first key signs,
 * all of them verify). Without it, nothing here mints anything: the routes stay dormant.
 *
 * DS-Proof v1 (header `DS-Proof`), five dot-separated fields:
 *     v1.<ts>.<nonce>.<key>.<sig>
 *   ts     unix seconds
 *   nonce  16–64 base64url characters, fresh per request
 *   key    the device's P-256 public key, uncompressed point (65 bytes), base64url
 *   sig    ES256 (raw r‖s, 64 bytes, base64url) over the UTF-8 string
 *            "ds-proof-v1\n" + METHOD + "\n" + path + "\n" + ts + "\n" + nonce + "\n" + b64url(SHA-256(body))
 *          where path is the request path as the Worker routes it (from /api/…, query included,
 *          no /live-api prefix) and body is the raw request body (empty for GET).
 *   The ADR's "signature over method\npath\nts\nsha256(body)" plus a domain tag and the nonce:
 *   the nonce must be signed, or a replay could simply swap it.
 *   Golden vector: ./fixtures/ds-proof-v1.json (for the Swift and Kotlin implementations).
 */

import { b64url, constantTimeEqual, ecJwkFromRaw, importVerifyKey, jwkThumbprint, parseJwt, publicEcJwk, sha256, signEs256Jwt, unb64url, utf8, verifySignature, type PublicJwk } from './jose';

export interface DeviceTokenEnv {
  /** Secret: P-256 private JWK, or {"keys":[…]} while rotating. */
  DEVICE_TOKEN_JWK?: string;
}

export const ISSUER = 'dreamstream-live';
export const GRANT_TTL_S = 30 * 24 * 3600;
export const ACCESS_TTL_S = 10 * 60;
export const PROOF_WINDOW_S = 60;
const SKEW_S = 30;

/** What a device token may do. Mirrors the Glance `can` bits (D2): ack, soothe, listen, talk, peek, duty, log. */
export const SCOPES = ['glance', 'ack', 'soothe', 'listen', 'talk', 'peek', 'duty', 'log'] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * A device's ceiling from its owner's role: never above caregiver (D4.4). Viewer devices get
 * glance, peek and listen.
 */
export function scopesForRole(role: 'parent' | 'caregiver' | 'viewer'): Scope[] {
  if (role === 'viewer') return ['glance', 'peek', 'listen'];
  return ['glance', 'ack', 'soothe', 'listen', 'talk', 'peek', 'duty', 'log'];
}

/** What a token may do in one nursery right now: its scopes, cut down to the person's current role there. */
export function effectiveScopes(scp: readonly string[], role: 'parent' | 'caregiver' | 'viewer' | null): Scope[] {
  if (!role) return [];
  const cap = new Set<string>(scopesForRole(role));
  return SCOPES.filter((s) => scp.includes(s) && cap.has(s));
}

export interface DeviceClaims {
  iss: string;
  aud: 'ds-device-grant' | 'ds-device';
  /** The account (Supabase user id). */
  sub: string;
  /** live_devices.id */
  dev: string;
  cnf: { jkt: string };
  /** Nurseries this device may see. */
  nid: string[];
  scp: Scope[];
  iat: number;
  exp: number;
  jti: string;
}

interface Keys {
  kid: string;
  sign: CryptoKey;
  verify: Map<string, CryptoKey>;
}

let loaded: { src: string; keys: Promise<Keys | null> } | null = null;

async function load(src: string): Promise<Keys | null> {
  try {
    const parsed = JSON.parse(src) as (JsonWebKey & { kid?: string }) | { keys?: (JsonWebKey & { kid?: string })[] };
    const list = 'keys' in parsed && Array.isArray(parsed.keys) ? parsed.keys : [parsed as JsonWebKey & { kid?: string }];
    if (!list.length) return null;
    const verify = new Map<string, CryptoKey>();
    let first: { kid: string; sign: CryptoKey } | null = null;
    for (const jwk of list) {
      if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) return null;
      const pub = publicEcJwk(jwk);
      const kid = jwk.kid || (await jwkThumbprint(pub));
      const vk = await importVerifyKey(pub, 'ES256');
      if (!vk) return null;
      verify.set(kid, vk);
      if (!first) {
        const sign = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        first = { kid, sign };
      }
    }
    return first ? { ...first, verify } : null;
  } catch {
    return null;
  }
}

function keysFor(env: DeviceTokenEnv): Promise<Keys | null> {
  const src = (env.DEVICE_TOKEN_JWK || '').trim();
  if (!src) return Promise.resolve(null);
  if (!loaded || loaded.src !== src) loaded = { src, keys: load(src) };
  return loaded.keys;
}

/** True when DEVICE_TOKEN_JWK is set and usable. */
export async function deviceTokensConfigured(env: DeviceTokenEnv): Promise<boolean> {
  return !!(await keysFor(env));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JKT_RE = /^[A-Za-z0-9_-]{43}$/;
const jti = () => b64url(crypto.getRandomValues(new Uint8Array(12)));

export interface GrantInput {
  uid: string;
  dev: string;
  jkt: string;
  nids: string[];
  scp: readonly Scope[];
}

async function mint(env: DeviceTokenEnv, aud: DeviceClaims['aud'], typ: string, o: GrantInput, ttl: number, now: number): Promise<{ token: string; exp: number; claims: DeviceClaims } | null> {
  const keys = await keysFor(env);
  if (!keys) return null;
  if (!UUID_RE.test(o.uid) || !UUID_RE.test(o.dev) || !JKT_RE.test(o.jkt)) return null;
  const iat = Math.floor(now / 1000);
  const claims: DeviceClaims = {
    iss: ISSUER,
    aud,
    sub: o.uid.toLowerCase(),
    dev: o.dev.toLowerCase(),
    cnf: { jkt: o.jkt },
    nid: [...new Set(o.nids.filter((n) => UUID_RE.test(n)).map((n) => n.toLowerCase()))].slice(0, 10),
    scp: SCOPES.filter((s) => o.scp.includes(s)),
    iat,
    exp: iat + ttl,
    jti: jti(),
  };
  const token = await signEs256Jwt({ kid: keys.kid, typ }, claims as unknown as Record<string, unknown>, keys.sign);
  return { token, exp: claims.exp, claims };
}

/** A 30-day grant for an enrolled device's hardware key. Null when tokens aren't configured or the input is malformed. */
export function mintDeviceGrant(env: DeviceTokenEnv, o: GrantInput, now = Date.now()) {
  return mint(env, 'ds-device-grant', 'ds-grant+jwt', o, GRANT_TTL_S, now);
}

/** A 10-minute access token from a verified grant (never more nurseries or scopes than the grant). */
export function mintDeviceAccess(env: DeviceTokenEnv, grant: DeviceClaims, now = Date.now()) {
  return mint(env, 'ds-device', 'ds-access+jwt', { uid: grant.sub, dev: grant.dev, jkt: grant.cnf.jkt, nids: grant.nid, scp: grant.scp }, ACCESS_TTL_S, now);
}

export type DeviceTokenFailure = 'unavailable' | 'malformed' | 'invalid' | 'expired' | 'wrong_kind';

/** Verify a grant or an access token we issued. */
export async function verifyDeviceToken(
  env: DeviceTokenEnv,
  token: string,
  kind: 'grant' | 'access',
  now = Date.now(),
): Promise<{ ok: true; claims: DeviceClaims } | { ok: false; reason: DeviceTokenFailure }> {
  const keys = await keysFor(env);
  if (!keys) return { ok: false, reason: 'unavailable' };
  const jwt = parseJwt(token);
  if (!jwt) return { ok: false, reason: 'malformed' };
  if (jwt.header.alg !== 'ES256' || typeof jwt.header.kid !== 'string') return { ok: false, reason: 'invalid' };
  const key = keys.verify.get(jwt.header.kid);
  if (!key || !(await verifySignature('ES256', key, jwt.signature, jwt.signingInput))) return { ok: false, reason: 'invalid' };
  const c = jwt.payload as Partial<DeviceClaims>;
  const wantAud = kind === 'grant' ? 'ds-device-grant' : 'ds-device';
  const wantTyp = kind === 'grant' ? 'ds-grant+jwt' : 'ds-access+jwt';
  if (c.aud !== wantAud || jwt.header.typ !== wantTyp) return { ok: false, reason: 'wrong_kind' };
  if (
    c.iss !== ISSUER ||
    typeof c.sub !== 'string' ||
    !UUID_RE.test(c.sub) ||
    typeof c.dev !== 'string' ||
    !UUID_RE.test(c.dev) ||
    !c.cnf ||
    typeof c.cnf.jkt !== 'string' ||
    !JKT_RE.test(c.cnf.jkt) ||
    !Array.isArray(c.nid) ||
    !Array.isArray(c.scp) ||
    typeof c.exp !== 'number' ||
    typeof c.iat !== 'number'
  ) {
    return { ok: false, reason: 'invalid' };
  }
  const nowS = Math.floor(now / 1000);
  if (c.iat - SKEW_S > nowS) return { ok: false, reason: 'invalid' };
  if (c.exp + SKEW_S <= nowS) return { ok: false, reason: 'expired' };
  const scp = SCOPES.filter((s) => (c.scp as string[]).includes(s));
  const nid = (c.nid as unknown[]).filter((n): n is string => typeof n === 'string' && UUID_RE.test(n));
  return { ok: true, claims: { ...(c as DeviceClaims), scp, nid } };
}

/* ------------------------------------------------------------------ DS-Proof */

/** Remembers DS-Proof nonces (and single-use action tokens) until they could no longer be valid. */
export interface NonceStore {
  /** Record `key` until `until` (epoch ms). True when it was already recorded (a replay). */
  checkAndSet(key: string, until: number, now: number): boolean | Promise<boolean>;
}

/** Per-isolate nonce memory. Rooms use their SQLite instead, so a replay can't dodge it by landing on a fresh isolate. */
export class MemoryNonceStore implements NonceStore {
  private seen = new Map<string, number>();
  constructor(private max = 20_000) {}
  checkAndSet(key: string, until: number, now: number): boolean {
    const hit = this.seen.get(key);
    if (hit != null && hit > now) return true;
    if (this.seen.size >= this.max) {
      for (const [k, t] of this.seen) if (t <= now) this.seen.delete(k);
      // Still full of live entries: refuse to grow (a flood), but never forget a live one.
      if (this.seen.size >= this.max) return true;
    }
    this.seen.set(key, until);
    return false;
  }
}

/** The path a proof signs: as the Worker routes it (no /live-api prefix), with the query. */
export function proofPath(url: URL): string {
  return url.pathname.replace(/^\/live-api(?=\/)/, '') + url.search;
}

export function proofMessage(method: string, path: string, ts: number, nonce: string, bodyHash: string): string {
  return `ds-proof-v1\n${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
}

const bodyBytes = async (body: Uint8Array | string | ArrayBuffer | null | undefined): Promise<Uint8Array> =>
  body == null ? new Uint8Array(0) : typeof body === 'string' ? utf8(body) : body instanceof Uint8Array ? body : new Uint8Array(body);

/** Make a DS-Proof header value (clients; tests; the golden fixture). */
export async function signDsProof(o: {
  privateKey: CryptoKey;
  /** 65-byte uncompressed public point. */
  publicRaw: Uint8Array;
  method: string;
  path: string;
  body?: Uint8Array | string | null;
  ts?: number;
  nonce?: string;
}): Promise<string> {
  const ts = o.ts ?? Math.floor(Date.now() / 1000);
  const nonce = o.nonce ?? b64url(crypto.getRandomValues(new Uint8Array(16)));
  const bh = b64url(await sha256(await bodyBytes(o.body)));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, o.privateKey, utf8(proofMessage(o.method, o.path, ts, nonce, bh)));
  return `v1.${ts}.${nonce}.${b64url(o.publicRaw)}.${b64url(sig)}`;
}

export type ProofFailure = 'missing' | 'malformed' | 'stale' | 'key_mismatch' | 'bad_signature' | 'replay';

/**
 * Check a request's DS-Proof against the key its token is bound to (`jkt`). Pass `body` when
 * the caller has already read it; otherwise the request is cloned and read here.
 */
export async function verifyDsProof(
  req: Request,
  jkt: string,
  nonces: NonceStore,
  opts: { now?: number; body?: Uint8Array | string | ArrayBuffer | null; path?: string } = {},
): Promise<{ ok: true } | { ok: false; reason: ProofFailure }> {
  const now = opts.now ?? Date.now();
  const header = req.headers.get('ds-proof');
  if (!header) return { ok: false, reason: 'missing' };
  const parts = header.trim().split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return { ok: false, reason: 'malformed' };
  const [, tsRaw, nonce, keyRaw, sigRaw] = parts;
  if (!/^\d{9,11}$/.test(tsRaw) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return { ok: false, reason: 'malformed' };
  const key = unb64url(keyRaw);
  const sig = unb64url(sigRaw);
  const jwk: PublicJwk | null = key ? ecJwkFromRaw(key) : null;
  if (!jwk || !sig || sig.length !== 64) return { ok: false, reason: 'malformed' };
  const ts = Number(tsRaw);
  if (Math.abs(Math.floor(now / 1000) - ts) > PROOF_WINDOW_S) return { ok: false, reason: 'stale' };
  if (!constantTimeEqual(await jwkThumbprint(jwk), jkt)) return { ok: false, reason: 'key_mismatch' };
  const vk = await importVerifyKey(jwk, 'ES256');
  if (!vk) return { ok: false, reason: 'malformed' };
  const body = opts.body !== undefined ? await bodyBytes(opts.body) : new Uint8Array(await req.clone().arrayBuffer());
  const path = opts.path ?? proofPath(new URL(req.url));
  const msg = proofMessage(req.method, path, ts, nonce, b64url(await sha256(body)));
  if (!(await verifySignature('ES256', vk, sig, utf8(msg)))) return { ok: false, reason: 'bad_signature' };
  // Only a correctly signed proof reaches the nonce memory, so junk can't fill it.
  if (await nonces.checkAndSet(`p:${jkt}:${nonce}`, (ts + PROOF_WINDOW_S + 1) * 1000, now)) return { ok: false, reason: 'replay' };
  return { ok: true };
}

/** Tests only. */
export function resetDeviceKeyCache(): void {
  loaded = null;
}
