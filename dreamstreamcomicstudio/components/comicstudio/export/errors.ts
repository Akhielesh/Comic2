// The one error type every export throws: its message is written for the person exporting
// (what happened, what to do), so callers can show it as is.

/** Machine-readable reasons a caller may act on (offer another format, a language at a time…). */
export type ExportErrorCode = 'too_big' | 'downloads_off' | 'no_language';

export class ExportError extends Error {
  readonly code?: ExportErrorCode;
  constructor(message: string, code?: ExportErrorCode) {
    super(message);
    this.name = 'ExportError';
    if (code) this.code = code;
  }
}

/** The code of an export failure (undefined for anything else). */
export const exportErrorCode = (err: unknown): ExportErrorCode | undefined => (err instanceof ExportError ? err.code : undefined);

/** A user-facing message for anything an export step threw. */
export const friendlyExportError = (err: unknown): string =>
  err instanceof ExportError ? err.message : (err as Error)?.message ? `Something went wrong: ${(err as Error).message}` : 'Something went wrong.';

export const CANCELLED = 'Export cancelled.';
