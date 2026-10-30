/**
 * The client's request core: validate the call, sign it, send it with the injected `fetch`, read the answer. It
 * never throws: every failure (a refused call, the network, the gateway's error, a malformed answer, a failing
 * injected crypto or clock) comes back as a `WireFailure`.
 */
import { PLATFORM_HEADERS, parseCostMicros, parseWarnings, signedRequestHeaders } from '../wire/headers.js';
import { encodeQuery, isIdempotencyKey } from '../wire/canonical.js';
import { isUsableSecret } from '../wire/crypto.js';
import { failureFromResponse, inputFailure, internalFailure, networkFailure, wireFailure } from '../wire/errors.js';
import { isBytes, toArrayBuffer, utf8Decode, utf8Encode } from '../wire/bytes.js';
import type { FetchLike, FetchResponseLike, WireClock, WireCrypto, WireFailure } from '../wire/types.js';
import { APP_ID_PATTERN, KEY_ID_PATTERN, WIRE_LIMITS } from '../wire/types.js';

/** What a host hands the client. Server-side only: it holds the app secret. */
export interface PlatformClientConfig {
  /** The gateway origin, `https://host[:port]` (no path); `http://localhost` / `http://127.0.0.1` for local tests. */
  baseUrl: string;
  /** X-Platform-App. */
  app: string;
  /** X-Platform-Key-Id: which of the app's keys `secret` is. */
  keyId: string;
  /** The app secret for `keyId` (at least 32 bytes; `decodeSecret` reads its configured text form). */
  secret: Uint8Array;
  crypto: WireCrypto;
  fetch: FetchLike;
  now: WireClock;
  /** Makes an X-Request-Id per call (echoed back by the gateway, for correlating logs). */
  requestId?: () => string;
  /**
   * The biggest response body the client accepts (default `WIRE_LIMITS.maxResponseBytes`). It is refused before
   * reading when Content-Length says so, and while reading when the response has a body stream (fetch's own Response
   * does); a response that offers only `arrayBuffer()` is read whole first and checked after, so a host whose fetch
   * has no stream should wrap it with a size-limiting reader.
   */
  maxResponseBytes?: number;
}

/** What every successful call also reports. */
export interface ResponseMeta {
  status: number;
  /** X-Platform-Engine, e.g. `pdfcraft@0.15.0`. */
  engine?: string;
  /** X-Platform-Warnings. */
  warnings: string[];
  /** X-Platform-Cost-Micros (server-to-server only; never shown to a governed user). */
  costMicros?: number;
  /** X-Request-Id as echoed. */
  requestId?: string;
}

/** A call that needs a claim and an Idempotency-Key (every POST that carries a body). */
export interface SignedPost {
  /** The claim the host minted after its own auth (`mintUserClaim` / `mintServiceClaim`). */
  claim: string;
  /** Required on every POST; the same key with the same body returns the first result. */
  idempotencyKey: string;
}

/** The client's own state, checked once. */
export interface ClientContext {
  config: PlatformClientConfig;
  /** Why the config is unusable, or null. */
  configError: string | null;
  origin: string;
}

const APP_ID = new RegExp(APP_ID_PATTERN);
const KEY_ID = new RegExp(KEY_ID_PATTERN);
const ORIGIN = /^(https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?|http:\/\/(localhost|127\.0\.0\.1)(:[0-9]{1,5})?)$/;
const ENGINE = /^[A-Za-z0-9._@+-]{1,100}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** A media type we send: printable ASCII, no line breaks. */
const MEDIA_TYPE = /^[\x20-\x7e]{1,200}$/;
/** Any other header value we send (a percent-encoded file name can reach about 3 KB): printable ASCII, no line breaks. */
const HEADER_VALUE = /^[\x20-\x7e]{1,4096}$/;

export const createContext = (config: PlatformClientConfig): ClientContext => {
  try {
    return checkContext(config);
  } catch {
    return { config, configError: 'the client config cannot be read', origin: '' };
  }
};

const checkContext = (config: PlatformClientConfig): ClientContext => {
  let configError: string | null = null;
  let origin = '';
  if (!config || typeof config !== 'object') configError = 'no client config';
  else {
    origin = typeof config.baseUrl === 'string' ? config.baseUrl.replace(/\/+$/, '') : '';
    if (!ORIGIN.test(origin)) configError = 'baseUrl must be an https origin with no path';
    else if (typeof config.app !== 'string' || !APP_ID.test(config.app)) configError = 'app must be a platform app id';
    else if (typeof config.keyId !== 'string' || !KEY_ID.test(config.keyId)) configError = 'keyId must be a platform key id';
    else if (!isUsableSecret(config.secret)) configError = `the secret must be at least ${WIRE_LIMITS.secretMinBytes} bytes`;
    else if (!config.crypto || typeof config.crypto.sha256 !== 'function' || typeof config.crypto.hmacSha256 !== 'function') configError = 'crypto must be a WireCrypto';
    else if (typeof config.fetch !== 'function') configError = 'fetch must be a function';
    else if (typeof config.now !== 'function') configError = 'now must be a clock';
  }
  return { config, configError, origin };
};

/** One request as an endpoint module describes it. */
export interface SendSpec {
  method: 'GET' | 'POST';
  /** A path the endpoint built from validated parts (already canonical). */
  path: string;
  query?: { readonly [key: string]: string | number | undefined };
  body?: Uint8Array;
  contentType?: string;
  headers?: Record<string, string>;
  claim?: string;
  idempotencyKey?: string;
  /** A tighter response cap for this endpoint (e.g. `/v1/render`'s 10 MB); the config's cap still applies. */
  maxResponseBytes?: number;
}

export interface RawResponse {
  ok: true;
  status: number;
  body: Uint8Array;
  contentType: string | null;
  meta: ResponseMeta;
  /** The SHA-256 hex of the request body that was signed and sent. */
  requestBodySha256Hex: string;
}

const responseMeta = (res: FetchResponseLike): ResponseMeta => {
  const get = (name: string): string | null => {
    try {
      return res.headers.get(name);
    } catch {
      return null;
    }
  };
  const meta: ResponseMeta = { status: res.status, warnings: parseWarnings(get(PLATFORM_HEADERS.warnings)) };
  const engine = get(PLATFORM_HEADERS.engine);
  if (engine !== null && ENGINE.test(engine)) meta.engine = engine;
  const cost = parseCostMicros(get(PLATFORM_HEADERS.costMicros));
  if (cost !== undefined) meta.costMicros = cost;
  const rid = get(PLATFORM_HEADERS.requestId);
  if (rid !== null && REQUEST_ID.test(rid)) meta.requestId = rid;
  return meta;
};

/**
 * Validate, sign, send and read one request. Refused before anything is sent: a bad config, a POST without an
 * Idempotency-Key, a POST with a body but no claim, a body over `WIRE_LIMITS.maxRequestBytes`, a header value that
 * is not printable ASCII.
 */
export const send = async (ctx: ClientContext, spec: SendSpec): Promise<RawResponse | WireFailure> => {
  if (ctx.configError !== null) return inputFailure('input', `platform client config: ${ctx.configError}`);
  const cfg = ctx.config;
  const body = spec.body || null;
  if (spec.method === 'POST') {
    if (!isIdempotencyKey(spec.idempotencyKey)) {
      return inputFailure('idempotency-key', 'every POST needs an Idempotency-Key of 1 to 128 characters of [A-Za-z0-9._:-]');
    }
    if (body && body.length && (typeof spec.claim !== 'string' || !spec.claim.length)) return inputFailure('claim-required', 'a POST that carries a body needs a claim');
  }
  if (body && body.length > WIRE_LIMITS.maxRequestBytes) return wireFailure('too-large', `the body is over ${WIRE_LIMITS.maxRequestBytes} bytes`);
  if (spec.contentType !== undefined && !MEDIA_TYPE.test(spec.contentType)) return inputFailure('input', 'contentType must be printable ASCII');
  const extra = spec.headers || {};
  const extraNames = Object.keys(extra);
  for (let i = 0; i < extraNames.length; i++) if (!HEADER_VALUE.test(extra[extraNames[i]])) return inputFailure('input', `${extraNames[i]} must be printable ASCII`);

  let query = '';
  if (spec.query) {
    const q = encodeQuery(spec.query);
    if (q === null) return inputFailure('query', 'the query cannot be signed');
    query = q;
  }
  const target = query ? `${spec.path}?${query}` : spec.path;

  let timestamp: number;
  let requestId: string | undefined;
  try {
    const ms = cfg.now();
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return internalFailure('the clock gave no time');
    timestamp = Math.floor(ms / 1000);
    requestId = cfg.requestId ? cfg.requestId() : undefined;
  } catch (e) {
    return internalFailure(e instanceof Error ? e.message : 'the clock failed');
  }

  const signed = await signedRequestHeaders({
    app: cfg.app,
    keyId: cfg.keyId,
    secret: cfg.secret,
    crypto: cfg.crypto,
    method: spec.method,
    target,
    timestamp,
    body,
    claim: spec.claim === undefined ? null : spec.claim,
    idempotencyKey: spec.idempotencyKey === undefined ? null : spec.idempotencyKey,
    requestId,
  });
  if (signed.ok === false) return signed;
  const bodyHex = signed.fields.bodySha256Hex;
  const headers: Record<string, string> = { ...extra, ...signed.headers };
  if (spec.contentType !== undefined) headers['Content-Type'] = spec.contentType;

  let res: FetchResponseLike;
  try {
    const init = body ? { method: spec.method, headers, body: toArrayBuffer(body), redirect: 'error' as const } : { method: spec.method, headers, redirect: 'error' as const };
    res = await cfg.fetch(`${ctx.origin}${target}`, init);
  } catch (e) {
    return networkFailure(e instanceof Error ? e.message : undefined);
  }
  if (!res || typeof res.status !== 'number') return wireFailure('response', 'fetch gave no response');

  const configMax = typeof cfg.maxResponseBytes === 'number' && cfg.maxResponseBytes > 0 ? cfg.maxResponseBytes : WIRE_LIMITS.maxResponseBytes;
  const max = spec.maxResponseBytes !== undefined && spec.maxResponseBytes < configMax ? spec.maxResponseBytes : configMax;
  let declared: string | null = null;
  try {
    declared = res.headers.get('Content-Length');
  } catch {
    declared = null;
  }
  if (declared !== null && /^[0-9]{1,16}$/.test(declared) && Number(declared) > max) {
    return wireFailure('response', `the platform's answer is over ${max} bytes`, { status: res.status });
  }
  let read: Uint8Array | 'too-large' | 'not-bytes';
  try {
    read = await readBody(res, max);
  } catch (e) {
    return networkFailure(e instanceof Error ? e.message : 'the answer was cut off');
  }
  if (read === 'too-large') return wireFailure('response', `the platform's answer is over ${max} bytes`, { status: res.status });
  if (read === 'not-bytes') return wireFailure('response', "the platform's answer stream gave something other than bytes", { status: res.status });
  const bytes = read;

  const meta = responseMeta(res);
  if (res.status < 200 || res.status > 299) {
    const failure = failureFromResponse(res.status, bytes, meta.requestId);
    return failure;
  }
  let contentType: string | null = null;
  try {
    contentType = res.headers.get('Content-Type');
  } catch {
    contentType = null;
  }
  return { ok: true, status: res.status, body: bytes, contentType, meta, requestBodySha256Hex: bodyHex };
};

/** The reader a WHATWG body stream hands out (only what `readBody` uses). */
interface BodyReader {
  read(): PromiseLike<{ done?: boolean; value?: unknown }>;
  cancel?(reason?: unknown): unknown;
}

/** Cancel a stream we stopped reading, ignoring whatever cancel does or throws. */
const cancelQuietly = (reader: BodyReader): void => {
  try {
    const p = typeof reader.cancel === 'function' ? reader.cancel() : undefined;
    if (p && typeof (p as PromiseLike<unknown>).then === 'function') (p as PromiseLike<unknown>).then(undefined, () => undefined);
  } catch {
    // Nothing to do: the answer is refused either way.
  }
};

/**
 * The answer's body, at most `max` bytes. When the response has a WHATWG body stream (`res.body.getReader()`, as
 * fetch's own Response does), reading stops and the stream is cancelled as soon as the cap is passed, so a chunked
 * answer without Content-Length never fills memory. A response that offers only `arrayBuffer()` is read whole, then
 * checked. Throws only what the stream or `arrayBuffer()` throws (a network failure).
 */
const readBody = async (res: FetchResponseLike, max: number): Promise<Uint8Array | 'too-large' | 'not-bytes'> => {
  const stream = (res as { body?: unknown }).body;
  const getReader = typeof stream === 'object' && stream !== null ? (stream as { getReader?: unknown }).getReader : undefined;
  if (typeof getReader !== 'function') {
    const whole = new Uint8Array(await res.arrayBuffer());
    return whole.length > max ? 'too-large' : whole;
  }
  const reader = (getReader as (this: unknown) => BodyReader).call(stream);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (!step || step.done) break;
    const chunk = step.value;
    if (!isBytes(chunk)) {
      cancelQuietly(reader);
      return 'not-bytes';
    }
    total += chunk.length;
    if (total > max) {
      cancelQuietly(reader);
      return 'too-large';
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (let i = 0; i < chunks.length; i++) {
    out.set(chunks[i], at);
    at += chunks[i].length;
  }
  return out;
};

/** Run a client call; anything it throws becomes an `internal` failure, so a call never throws. */
export const guard = async <T>(run: () => Promise<T | WireFailure>): Promise<T | WireFailure> => {
  try {
    return await run();
  } catch (e) {
    return internalFailure(e instanceof Error ? e.message : 'unexpected failure');
  }
};

/** UTF-8 JSON bytes for a request body, or a refusal (a value JSON cannot hold: a cycle, a BigInt). */
export const jsonBody = (value: unknown): Uint8Array | WireFailure => {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return inputFailure('input', 'the request is not JSON-serialisable');
  }
  if (typeof text !== 'string') return inputFailure('input', 'the request is not JSON-serialisable');
  return utf8Encode(text);
};

/** The answer's JSON, or undefined when it is not UTF-8 JSON. */
export const readJson = (bytes: Uint8Array): unknown => {
  const text = utf8Decode(bytes);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A malformed answer from the gateway. */
export const badResponse = (what: string, meta: ResponseMeta): WireFailure => {
  const extra: { status: number; requestId?: string } = { status: meta.status };
  if (meta.requestId !== undefined) extra.requestId = meta.requestId;
  return wireFailure('response', `the platform's answer is not a valid ${what}`, extra);
};

// ── Tiny validators for answers (shape and caps; the gateway is trusted for content, not for size) ──────────────

export const isRecord = (v: unknown): v is { [key: string]: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isText = (v: unknown, max: number, pattern?: RegExp): v is string =>
  typeof v === 'string' && v.length <= max && (pattern === undefined || pattern.test(v));
export const isWhole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

/** The media type of a Content-Type header, lower-cased, without parameters. */
export const mediaType = (contentType: string | null): string => (contentType || '').split(';')[0].trim().toLowerCase();

/** A header-safe, percent-encoded file name, or null when it is empty, too long or holds a control character. */
export const encodeFileName = (name: unknown, encode: (text: string) => string): string | null => {
  if (typeof name !== 'string' || !name.length || name.length > WIRE_LIMITS.fileNameMax) return null;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return null;
  }
  return encode(name);
};
