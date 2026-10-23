// The one error type every export throws: its message is written for the person exporting
// (what happened, what to do), so callers can show it as is.

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

/** A user-facing message for anything an export step threw. */
export const friendlyExportError = (err: unknown): string =>
  err instanceof ExportError ? err.message : (err as Error)?.message ? `Something went wrong: ${(err as Error).message}` : 'Something went wrong.';

export const CANCELLED = 'Export cancelled.';
