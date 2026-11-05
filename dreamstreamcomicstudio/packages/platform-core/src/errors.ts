/**
 * The platform's error vocabulary (plan §5.9): one set of codes for the gateway's error body, the client's
 * never-throwing results and the fake platform, plus the error a bad schema DEFINITION throws (bad VALUES never
 * throw: `check()` returns errors). Pure; the wire helpers that read and write HTTP live in `src/wire/errors.ts`.
 */

/** Every error code the platform answers with. */
export const PLATFORM_ERROR_CODES = [
  'invalid',
  'unauthorized',
  'forbidden',
  'not-found',
  'conflict',
  'too-large',
  'unsupported',
  'input-rejected',
  'quota',
  'engine-failed',
  'disabled',
  'timeout',
] as const;

export type PlatformErrorCode = (typeof PLATFORM_ERROR_CODES)[number];

/** How a caller may retry: never, after the quota window resets, once, or with backoff. */
export type RetryPolicy = 'no' | 'after-reset' | 'once' | 'yes';

export interface PlatformErrorSpec {
  /** The HTTP status the gateway answers with. */
  status: number;
  /** `retry !== 'no'`: what the error body's `retryable` says. */
  retryable: boolean;
  retry: RetryPolicy;
}

/** Plan §5.9, row by row. */
export const PLATFORM_ERRORS: { readonly [C in PlatformErrorCode]: Readonly<PlatformErrorSpec> } = {
  invalid: { status: 400, retryable: false, retry: 'no' },
  unauthorized: { status: 401, retryable: false, retry: 'no' },
  forbidden: { status: 403, retryable: false, retry: 'no' },
  'not-found': { status: 404, retryable: false, retry: 'no' },
  /** An `Idempotency-Key` reused with a different body, a stale op, or an already-used plan reservation. */
  conflict: { status: 409, retryable: false, retry: 'no' },
  'too-large': { status: 413, retryable: false, retry: 'no' },
  unsupported: { status: 415, retryable: false, retry: 'no' },
  /** The engine's preflight refused the input (a zip bomb, a 60 MP image, a broken PDF). */
  'input-rejected': { status: 422, retryable: false, retry: 'no' },
  quota: { status: 429, retryable: true, retry: 'after-reset' },
  'engine-failed': { status: 502, retryable: true, retry: 'once' },
  /** A capability switched off (`DISABLED_CAPS`) or draining. */
  disabled: { status: 503, retryable: true, retry: 'yes' },
  timeout: { status: 504, retryable: true, retry: 'yes' },
};

export const isPlatformErrorCode = (value: unknown): value is PlatformErrorCode =>
  typeof value === 'string' && (PLATFORM_ERROR_CODES as readonly string[]).indexOf(value) !== -1;

/**
 * The code for an HTTP status the gateway (or something in front of it) answered with. A status the table does not
 * name maps by class: other 4xx → `invalid`, other 5xx → `engine-failed`; anything else is not an error and gets
 * `engine-failed` too, because a caller only asks when the call failed.
 */
export const platformErrorCodeForStatus = (status: number): PlatformErrorCode => {
  for (const code of PLATFORM_ERROR_CODES) if (PLATFORM_ERRORS[code].status === status) return code;
  return status >= 400 && status < 500 ? 'invalid' : 'engine-failed';
};

/** The gateway's error body: `{error: {code, message, retryable, requestId}}`. */
export interface PlatformErrorBody {
  error: {
    code: PlatformErrorCode;
    message: string;
    retryable: boolean;
    requestId: string;
  };
}

export const platformErrorBody = (code: PlatformErrorCode, message: string, requestId: string): PlatformErrorBody => ({
  error: { code, message, retryable: PLATFORM_ERRORS[code].retryable, requestId },
});

/** A failed call, as the client and the fake platform return it (they never throw). */
export interface PlatformFailure {
  ok: false;
  code: PlatformErrorCode;
  message: string;
  retryable: boolean;
  /** The HTTP status, when there was a response. */
  status?: number;
  requestId?: string;
}

export const platformFailure = (
  code: PlatformErrorCode,
  message: string,
  extra: { status?: number; requestId?: string; retryable?: boolean } = {},
): PlatformFailure => {
  const out: PlatformFailure = { ok: false, code, message, retryable: extra.retryable !== undefined ? extra.retryable : PLATFORM_ERRORS[code].retryable };
  if (extra.status !== undefined) out.status = extra.status;
  if (extra.requestId !== undefined) out.requestId = extra.requestId;
  return out;
};

/**
 * Thrown by `s.*`, `check()` and `toJsonSchema()` when a schema is badly DEFINED (a string or array without a cap,
 * a union without its tag, an optional outside an object…). A programming error, caught by tests at import time;
 * a bad VALUE never throws.
 */
export class SchemaDefinitionError extends Error {
  /** Where in the schema tree: `''` for the node itself, else the field / item path. */
  readonly path: string;

  constructor(message: string, path = '') {
    super(path ? `${path}: ${message}` : message);
    this.name = 'SchemaDefinitionError';
    this.path = path;
  }
}
