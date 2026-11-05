/**
 * The classic wizard's PDF tools, loaded only when someone exports (PROGRAM3 PF-1; perf lens F1 + V.2).
 *
 * jsPDF 2.5.1 and html2canvas 1.4.1 used to be two `defer` tags in index.html. Deferred classic scripts run
 * before the deferred module entry, so every page — the landing page, the studio, the public reader — waited
 * for 133 KB (brotli) of third-party code that only the classic wizard's export buttons use: 8.6 s → 5.9 s
 * DOMContentLoaded on a throttled phone without them. Now the three legacy call sites (ReferenceBuilder,
 * ReviewExport, ProjectInfoModal) await this loader first, and it injects the SAME pinned cdnjs files:
 *
 * - same URLs and versions, same Subresource Integrity (the SHA-512 cdnjs publishes for these exact bytes),
 *   `crossorigin="anonymous"` and `referrerpolicy="no-referrer"`, so the browser refuses any other bytes;
 * - once per page: concurrent and later calls share one in-flight load, and a library that is already on
 *   `window` (a tag that loaded it some other way) is used as it is, with nothing injected;
 * - with a timeout (LEGACY_PDF_LOAD_TIMEOUT_MS) and a calm error (LegacyPdfLoadError, whose message is
 *   written for the person, not for the console). A failed or timed-out tag is removed, so "try again"
 *   injects a fresh one.
 *
 * The CSP still has to allow https://cdnjs.cloudflare.com in script-src (functions/_middleware.ts mainCsp,
 * functions/_shared/csp.ts buildCsp): a script inserted from code is governed by script-src(-elem) exactly
 * like a parsed tag. tests/edge/supplyChain.test.ts keeps these pins, the licence records in
 * scripts/licence-policy.json and that CSP allowance in step, and checks index.html loads neither script.
 *
 * The only timer is the one-shot load timeout, cleared on load or error; nothing here calls /api.
 */

/** One pinned third-party script. */
export interface LegacyPdfScript {
  /** The licence record's name (scripts/licence-policy.json externalScripts). */
  readonly name: LegacyPdfLib;
  readonly version: string;
  readonly src: string;
  /** Subresource Integrity: the SHA-512 cdnjs publishes for this exact file. */
  readonly integrity: string;
}

export type LegacyPdfLib = 'jspdf' | 'html2canvas';

/** The pins, byte-for-byte the ones index.html carried (and scripts/licence-policy.json records). */
export const LEGACY_PDF_SCRIPTS: Readonly<Record<LegacyPdfLib, LegacyPdfScript>> = Object.freeze({
  jspdf: Object.freeze({
    name: 'jspdf',
    version: '2.5.1',
    src: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    integrity: 'sha512-qZvrmS2ekKPF2mSznTQsxqPgnpkI4DNTlrdUmTzrDgektczlKNRRhy5X5AAOnx5S09ydFYWWNSfcEqDTTHgtNA=='
  }),
  html2canvas: Object.freeze({
    name: 'html2canvas',
    version: '1.4.1',
    src: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
    integrity: 'sha512-BNaRQnYJYiPSqHHDb58B0yaPfCu+Wgds8Gp/gU33kqBtgNS4tSPHuGibyoeqMV/TJlSKda6FXzoEyYGjTe+vXA=='
  })
});

/** How long one script may take before the export gives up calmly (generous for a slow phone link). */
export const LEGACY_PDF_LOAD_TIMEOUT_MS = 20_000;

/** Marks the tags this loader adds (and lets it find its own in-flight tag). */
export const LEGACY_PDF_SCRIPT_ATTR = 'data-legacy-pdf';

/** The slice of jsPDF the legacy call sites use. */
export interface LegacyJsPdfDoc {
  internal: { pageSize: { getWidth(): number; getHeight(): number } };
  addImage(imageData: string, format: string, x: number, y: number, width: number, height: number): unknown;
  addPage(): unknown;
  save(filename: string): unknown;
  output(type: 'blob'): Blob;
}
export type LegacyJsPdf = new (orientation?: 'p' | 'l' | 'portrait' | 'landscape', unit?: string, format?: string) => LegacyJsPdfDoc;

/** The html2canvas options the legacy call sites pass. */
export interface LegacyHtml2CanvasOptions {
  scale?: number;
  backgroundColor?: string | null;
  ignoreElements?: (element: HTMLElement) => boolean;
  useCORS?: boolean;
}
export type LegacyHtml2Canvas = (element: HTMLElement, options?: LegacyHtml2CanvasOptions) => Promise<HTMLCanvasElement>;

export interface LegacyPdfLibs {
  jsPDF: LegacyJsPdf;
  html2canvas: LegacyHtml2Canvas;
}

/** What the UMD builds put on window: `window.jspdf.jsPDF` and `window.html2canvas`. */
interface LegacyPdfGlobals {
  jspdf?: { jsPDF?: LegacyJsPdf };
  html2canvas?: LegacyHtml2Canvas;
}

export type LegacyPdfLoadFailure = 'timeout' | 'network' | 'missing' | 'unavailable';

/** Calm, person-facing copy for each way the tools can fail to arrive. Nothing was downloaded in any of them. */
export const LEGACY_PDF_MESSAGES: Readonly<Record<LegacyPdfLoadFailure, string>> = Object.freeze({
  timeout: 'The download tools are taking too long to load, so nothing was downloaded. Check your connection, then try again.',
  network: "The download tools didn't load, so nothing was downloaded. Check your connection, then try again.",
  missing: "The download tools didn't start, so nothing was downloaded. Reload the page, then try again.",
  unavailable: "Downloads aren't available here. Open this comic in your browser to download it."
});

/** For a failure that isn't the loader's (html2canvas or jsPDF stumbling on the page itself). */
export const LEGACY_PDF_EXPORT_FAILED = "That download didn't finish, so nothing was saved. Try again in a moment.";

export class LegacyPdfLoadError extends Error {
  readonly kind: LegacyPdfLoadFailure;
  readonly lib: LegacyPdfLib | null;
  constructor(kind: LegacyPdfLoadFailure, lib: LegacyPdfLib | null) {
    super(LEGACY_PDF_MESSAGES[kind]);
    this.name = 'LegacyPdfLoadError';
    this.kind = kind;
    this.lib = lib;
  }
}

/** The sentence to show for an export that threw: the loader's own calm copy, else a generic calm line. */
export function legacyPdfErrorMessage(error: unknown): string {
  return error instanceof LegacyPdfLoadError ? error.message : LEGACY_PDF_EXPORT_FAILED;
}

const globals = (): LegacyPdfGlobals => window as unknown as LegacyPdfGlobals;

/** The library if it is already on window (index.html's old tag, or an earlier load), else null. */
function present(lib: LegacyPdfLib): LegacyJsPdf | LegacyHtml2Canvas | null {
  const g = globals();
  if (lib === 'jspdf') return typeof g.jspdf?.jsPDF === 'function' ? g.jspdf.jsPDF : null;
  return typeof g.html2canvas === 'function' ? g.html2canvas : null;
}

const inFlight = new Map<LegacyPdfLib, Promise<void>>();

function inject(lib: LegacyPdfLib): Promise<void> {
  const pin = LEGACY_PDF_SCRIPTS[lib];
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    // Attributes, not IDL properties: every engine reflects these, and the fetch starts only on insertion.
    script.setAttribute('integrity', pin.integrity);
    script.setAttribute('crossorigin', 'anonymous');
    script.setAttribute('referrerpolicy', 'no-referrer');
    script.setAttribute(LEGACY_PDF_SCRIPT_ATTR, lib);
    script.async = true;
    script.src = pin.src;

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: LegacyPdfLoadError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (error) {
        // A failed tag can't run again; drop it so the next try injects a fresh one.
        script.remove();
        reject(error);
      } else resolve();
    };
    timer = setTimeout(() => finish(new LegacyPdfLoadError('timeout', lib)), LEGACY_PDF_LOAD_TIMEOUT_MS);
    script.onload = () => finish(present(lib) ? null : new LegacyPdfLoadError('missing', lib));
    // A network failure, a refused SRI check and a CSP block all arrive here.
    script.onerror = () => finish(new LegacyPdfLoadError('network', lib));
    document.head.appendChild(script);
  });
}

/** Load one library (once), resolving to it. Rejects with LegacyPdfLoadError, never with a raw event. */
async function loadLib(lib: LegacyPdfLib): Promise<LegacyJsPdf | LegacyHtml2Canvas> {
  if (typeof window === 'undefined' || typeof document === 'undefined') throw new LegacyPdfLoadError('unavailable', lib);
  const ready = present(lib);
  if (ready) return ready;
  let pending = inFlight.get(lib);
  if (!pending) {
    pending = inject(lib).finally(() => inFlight.delete(lib));
    inFlight.set(lib, pending);
  }
  await pending;
  const loaded = present(lib);
  if (!loaded) throw new LegacyPdfLoadError('missing', lib);
  return loaded;
}

/** jsPDF's constructor (`new jsPDF(orientation, unit, format)`), loading it on first use. */
export const loadJsPdf = (): Promise<LegacyJsPdf> => loadLib('jspdf') as Promise<LegacyJsPdf>;

/** html2canvas, loading it on first use. */
export const loadHtml2Canvas = (): Promise<LegacyHtml2Canvas> => loadLib('html2canvas') as Promise<LegacyHtml2Canvas>;

/** Both libraries, loaded in parallel on first use. */
export async function loadLegacyPdf(): Promise<LegacyPdfLibs> {
  const [jsPDF, html2canvas] = await Promise.all([loadJsPdf(), loadHtml2Canvas()]);
  return { jsPDF, html2canvas };
}

/** Tests only: forget in-flight loads (the tags and the window globals are the test's to clean). */
export function resetLegacyPdfLoaderForTests(): void {
  inFlight.clear();
}
