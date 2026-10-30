/**
 * The wire's side of the error vocabulary (plan §5.9): refusals with a reason, the gateway's error body read
 * defensively, and an HTTP answer mapped to a `PlatformFailure`. The codes, statuses and retry rules themselves live
 * in `src/errors.ts`.
 */
import type { PlatformErrorBody, PlatformErrorCode, PlatformFailure } from '../errors.js';
import { PLATFORM_ERRORS, isPlatformErrorCode, platformErrorBody, platformErrorCodeForStatus, platformFailure } from '../errors.js';
import { utf8Decode } from './bytes.js';
import type { WireFailure, WireReason } from './types.js';
import { WIRE_LIMITS } from './types.js';

/** The error code each refusal reason answers with. */
export const WIRE_REASON_CODES: { readonly [R in WireReason]: PlatformErrorCode } = {
  'missing-header': 'unauthorized',
  malformed: 'unauthorized',
  'unknown-key': 'unauthorized',
  'bad-signature': 'unauthorized',
  skew: 'unauthorized',
  expired: 'unauthorized',
  'exp-too-far': 'unauthorized',
  'claim-required': 'unauthorized',
  'wrong-app': 'unauthorized',
  'wrong-purpose': 'forbidden',
  capability: 'forbidden',
  'wrong-product': 'forbidden',
  'service-scope': 'forbidden',
  'wrong-job': 'forbidden',
  method: 'forbidden',
  'idempotency-key': 'invalid',
  'length-required': 'invalid',
  path: 'invalid',
  query: 'invalid',
  contract: 'invalid',
  input: 'invalid',
  'too-large': 'too-large',
  network: 'engine-failed',
  response: 'engine-failed',
  internal: 'engine-failed',
  gateway: 'engine-failed',
};

/** A refusal for `reason`, with its code and retry rule. */
export const wireFailure = (
  reason: WireReason,
  message: string,
  extra: { code?: PlatformErrorCode; status?: number; requestId?: string; retryable?: boolean } = {},
): WireFailure => {
  const code = extra.code !== undefined ? extra.code : WIRE_REASON_CODES[reason];
  const base: PlatformFailure = platformFailure(code, message, extra);
  return { ...base, reason };
};

/**
 * Minting or signing refuses bad input with `invalid`, whatever the verifier would answer for the same fault: the
 * caller is the one at fault, not an attacker.
 */
export const inputFailure = (reason: WireReason, message: string): WireFailure => wireFailure(reason, message, { code: 'invalid' });

/** A network failure: fetch rejected (DNS, TLS, reset, a refused redirect, an abort). Retryable. */
export const networkFailure = (detail?: string): WireFailure =>
  wireFailure('network', detail ? `the platform could not be reached: ${clip(detail, 300)}` : 'the platform could not be reached', {
    code: 'engine-failed',
    retryable: true,
  });

/** An unexpected local failure (an injected crypto or clock threw). Not retried: it would fail the same way. */
export const internalFailure = (detail: string): WireFailure =>
  wireFailure('internal', `platform client: ${clip(detail, 300)}`, { code: 'engine-failed', retryable: false });

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The gateway's error body, read defensively: `{error: {code, message, retryable, requestId}}` with a known code, or
 * null for anything else (an HTML page from a proxy, an empty body, a body over 64 KB).
 */
export const parseErrorBody = (body: Uint8Array | string | null | undefined): PlatformErrorBody['error'] | null => {
  if (body === null || body === undefined) return null;
  const text = typeof body === 'string' ? body : body.length <= 65536 ? utf8Decode(body) : null;
  if (text === null || text.length > 65536) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const e = error as { code?: unknown; message?: unknown; requestId?: unknown };
  if (!isPlatformErrorCode(e.code)) return null;
  return {
    code: e.code,
    message: typeof e.message === 'string' ? clip(e.message, WIRE_LIMITS.errorMessageMax) : '',
    retryable: PLATFORM_ERRORS[e.code].retryable,
    requestId: typeof e.requestId === 'string' && REQUEST_ID.test(e.requestId) ? e.requestId : '',
  };
};

/**
 * A non-2xx answer as a failure. A well-formed platform error body names the code; otherwise the status does (413 →
 * `too-large`, 415 → `unsupported`, 504 → `timeout`, other 4xx → `invalid`, other 5xx and 3xx → `engine-failed`), so
 * an edge proxy's own 413 or 504 page maps the same way. `retryable` always follows the code's rule.
 */
export const failureFromResponse = (status: number, body: Uint8Array | null, requestIdHeader?: string | null): WireFailure => {
  const parsed = parseErrorBody(body);
  const code: PlatformErrorCode = parsed ? parsed.code : status >= 400 ? platformErrorCodeForStatus(status) : 'engine-failed';
  const requestId = parsed && parsed.requestId ? parsed.requestId : requestIdHeader && REQUEST_ID.test(requestIdHeader) ? requestIdHeader : undefined;
  const message = parsed && parsed.message ? parsed.message : `the platform answered HTTP ${status}`;
  const extra: { code: PlatformErrorCode; status: number; requestId?: string } = { code, status };
  if (requestId !== undefined) extra.requestId = requestId;
  return wireFailure('gateway', message, extra);
};

/** The gateway's side: the status and JSON body for a refusal (the fake platform answers with this too). */
export const errorResponse = (failure: PlatformFailure, requestId: string): { status: number; body: string } => ({
  status: PLATFORM_ERRORS[failure.code].status,
  body: JSON.stringify(platformErrorBody(failure.code, failure.message, requestId)),
});
