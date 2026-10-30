/**
 * The one error every renderer throws. `code` is stable and machine-readable; `message` names what was refused and
 * why, so the host can show it or map it (services/platformExport.ts maps it to the app's `ExportError`).
 */

export type RenderErrorCode =
  /** An image that is not a `data:` image we hold (a path, an `http:`/`https:`/`file:` URL, SVG) or an unsafe link. */
  | 'blocked'
  /** Two `content` elements of a deck slide overlap (`details` lists them); export is refused until they are moved. */
  | 'overlap'
  /** The document is not shaped like the contract says. */
  | 'invalid'
  /** An image format the file cannot carry and the host gave no transcoder for (WebP). */
  | 'unsupported'
  /** A host asset id the host could not resolve to a `data:` image. */
  | 'asset-missing'
  /** An input over its cap (a `data:` image over 5 MB, Markdown over its character cap). */
  | 'too-large';

export const RENDER_ERROR_CODES: readonly RenderErrorCode[] = ['blocked', 'overlap', 'invalid', 'unsupported', 'asset-missing', 'too-large'];

/** One overlapping pair on one slide, as `RenderError('overlap').details` lists them. */
export interface SlideOverlap {
  slideId: string;
  /** 1-based, as people count slides. */
  slideNumber: number;
  a: string;
  b: string;
  /** The overlap as a fraction of the slide (0 for a line through a box). */
  area: number;
}

export class RenderError extends Error {
  readonly code: RenderErrorCode;
  /** For `overlap`: every overlapping pair. */
  readonly overlaps?: SlideOverlap[];

  constructor(code: RenderErrorCode, message: string, overlaps?: SlideOverlap[]) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
    if (overlaps) this.overlaps = overlaps;
  }
}

export const isRenderError = (err: unknown): err is RenderError =>
  err instanceof RenderError ||
  (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'RenderError' &&
    RENDER_ERROR_CODES.indexOf((err as { code?: RenderErrorCode }).code as RenderErrorCode) !== -1);
