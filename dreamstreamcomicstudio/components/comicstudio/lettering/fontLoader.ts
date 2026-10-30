// Lettering font loader (lettering.md §6.5). Client only; the shared registry
// (shared/comic/lettering/fonts.ts) holds the metadata, this module loads the files.
//
// - Latin faces are the self-hosted @fontsource files (fontFiles.ts), registered with the FontFace API
//   under PRIVATE family names ('DSL Comic Neue', …) so they never collide with the legacy Google
//   'Comic Neue'/'Bangers' link in index.html. Board, print and export use byte-identical files.
// - Script faces (Noto Sans Telugu, …) come lazily from Google Fonts CSS2 (one <link> per family set),
//   only when a page actually letters in that script.
// - Everything is memoized per face file, never rejects and works (as a no-op) without a DOM.
// - `fontLoadGeneration()` bumps whenever a face finishes loading so measuring hooks can re-plan with
//   real metrics (useLetteringFontsReady).

import { FONT_IDS, type FontId, type LatinFontId } from '../../../shared/comic/lettering/style';
import { FONT_REGISTRY, fontString, googleFontsHref } from '../../../shared/comic/lettering/fonts';
import { FONT_FILES, type FontFile } from './fontFiles';

export interface EnsureFontsResult {
  /** Faces that are ready to measure and draw. */
  loaded: FontId[];
  /** Faces that failed or timed out (a fallback face will be used; never silent — callers may tell the user). */
  failed: FontId[];
}

const isLatin = (id: FontId): id is LatinFontId => Object.prototype.hasOwnProperty.call(FONT_FILES, id);
const known = (id: unknown): id is FontId => typeof id === 'string' && (FONT_IDS as readonly string[]).includes(id);

const hasFontApi = (): boolean =>
  typeof document !== 'undefined' && !!(document as Document & { fonts?: FontFaceSet }).fonts && typeof FontFace !== 'undefined';

// ── Generation (re-plan signal) ───────────────────────────────────────────────

let generation = 0;
const listeners = new Set<() => void>();
const bump = () => {
  generation += 1;
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* a listener must never break font loading */
    }
  }
};
/** Increments every time a lettering face finishes loading (or the browser reports loadingdone). */
export const fontLoadGeneration = (): number => generation;
export const subscribeFontLoads = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

let docListener = false;
const listenToDocumentFonts = () => {
  if (docListener || !hasFontApi()) return;
  docListener = true;
  try {
    document.fonts.addEventListener('loadingdone', () => bump());
  } catch {
    /* older engines: our own promises still bump */
  }
};

// ── Latin faces (FontFace API) ────────────────────────────────────────────────

/** Face files a style needs: the nearest shipped weight, italic only when the face ships it. */
export const filesFor = (id: LatinFontId, weight = 400, italic = false): FontFile[] => {
  const files = FONT_FILES[id] || [];
  if (!files.length) return [];
  const weights = [...new Set(files.map((f) => f.weight))];
  const w = weights.reduce((best, x) => (Math.abs(x - weight) < Math.abs(best - weight) ? x : best), weights[0]);
  const style = italic && files.some((f) => f.style === 'italic') ? 'italic' : 'normal';
  return files.filter((f) => f.weight === w && f.style === style);
};

const faceLoads = new Map<string, Promise<boolean>>();
const loadedFiles = new Set<string>();

const loadFile = (family: string, file: FontFile, timeoutMs: number): Promise<boolean> => {
  const key = `${family}|${file.url}`;
  const existing = faceLoads.get(key);
  if (existing) return existing;
  const p = (async () => {
    if (!hasFontApi()) return false;
    try {
      const face = new FontFace(family, `url(${JSON.stringify(file.url)}) format("woff2")`, {
        weight: String(file.weight),
        style: file.style,
        unicodeRange: file.unicodeRange || undefined,
        display: 'block'
      });
      document.fonts.add(face);
      const ok = await Promise.race([
        face.load().then(() => true, () => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
      ]);
      if (ok) {
        loadedFiles.add(key);
        bump();
      } else faceLoads.delete(key); // allow a retry next time
      return ok;
    } catch {
      faceLoads.delete(key);
      return false;
    }
  })();
  faceLoads.set(key, p);
  return p;
};

// ── Script faces (Google Fonts CSS2) ──────────────────────────────────────────

const injectedHrefs = new Map<string, Promise<void>>();
/**
 * Add the Google Fonts CSS2 stylesheet once; resolves when it has loaded (or failed / timed out), so
 * `document.fonts.load` runs only after its @font-face rules exist — otherwise the load resolves with
 * no faces and the face is wrongly reported as failed.
 */
const injectGoogleCss = (href: string, timeoutMs: number): Promise<void> => {
  if (typeof document === 'undefined') return Promise.resolve();
  const known = injectedHrefs.get(href);
  if (known) return known;
  const ready = new Promise<void>((resolve) => {
    let existing: HTMLLinkElement | null = null;
    try {
      existing = [...document.querySelectorAll<HTMLLinkElement>('link[data-ds-lettering-fonts]')].find((l) => l.getAttribute('href') === href) ?? null;
    } catch {
      existing = null;
    }
    if (existing?.sheet) return resolve();
    const link = existing ?? document.createElement('link');
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    if (!existing) {
      link.rel = 'stylesheet';
      link.href = href;
      link.setAttribute('data-ds-lettering-fonts', '');
      document.head.appendChild(link);
    }
  });
  injectedHrefs.set(href, ready);
  return ready;
};

const scriptLoads = new Map<string, Promise<boolean>>();
const loadScriptFace = (id: FontId, weight: number, sample: string, timeoutMs: number): Promise<boolean> => {
  const key = `${id}|${weight}|${sample}`;
  const existing = scriptLoads.get(key);
  if (existing) return existing;
  const p = (async () => {
    if (!hasFontApi()) return false;
    const href = googleFontsHref([id], [400, 700, weight]);
    try {
      const font = fontString(id, 16, weight, false);
      // One budget for the stylesheet AND the face (the exporter waits at most `timeoutMs`).
      const ok = await Promise.race([
        (async () => {
          if (href) await injectGoogleCss(href, timeoutMs);
          return document.fonts.load(font, sample || undefined).then((faces) => faces.length > 0, () => false);
        })(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
      ]);
      if (ok) bump();
      else scriptLoads.delete(key);
      return ok;
    } catch {
      scriptLoads.delete(key);
      return false;
    }
  })();
  scriptLoads.set(key, p);
  return p;
};

// ── Public API ────────────────────────────────────────────────────────────────

export interface EnsureFontsOptions {
  /** Weights to load per face (snapped to shipped weights). Default [400, 700]. */
  weights?: number[];
  /** Also load italics where the face ships them. */
  italic?: boolean;
  /** Sample text (script faces load only the unicode-range slices the text needs). */
  sample?: string;
  /** Per-face timeout; default 5 s (as the export path always did). */
  timeoutMs?: number;
}

/** Load lettering faces; resolves with what is ready (never rejects). */
export async function ensureFonts(ids: readonly FontId[], opts: EnsureFontsOptions = {}): Promise<EnsureFontsResult> {
  listenToDocumentFonts();
  const unique = [...new Set(ids.filter(known))];
  const weights = opts.weights?.length ? opts.weights : [400, 700];
  const timeoutMs = opts.timeoutMs ?? 5000;
  const loaded: FontId[] = [];
  const failed: FontId[] = [];
  if (!hasFontApi()) return { loaded, failed: unique };
  await Promise.all(
    unique.map(async (id) => {
      const meta = FONT_REGISTRY[id];
      const jobs: Promise<boolean>[] = [];
      if (isLatin(id)) {
        for (const w of weights) {
          for (const file of filesFor(id, w, false)) jobs.push(loadFile(meta.family, file, timeoutMs));
          if (opts.italic && meta.italic) for (const file of filesFor(id, w, true)) jobs.push(loadFile(meta.family, file, timeoutMs));
        }
      } else {
        for (const w of weights) jobs.push(loadScriptFace(id, w, opts.sample || '', timeoutMs));
      }
      const results = await Promise.all(jobs);
      (results.length && results.some(Boolean) ? loaded : failed).push(id);
    })
  );
  return { loaded: FONT_IDS.filter((id) => loaded.includes(id)), failed: FONT_IDS.filter((id) => failed.includes(id)) };
}

/** True when a Latin face file for (id, weight, italic) has loaded (script faces: document.fonts.check). */
export function isFontReady(id: FontId, weight = 400, italic = false): boolean {
  if (!known(id)) return false;
  const meta = FONT_REGISTRY[id];
  if (isLatin(id)) {
    const files = filesFor(id, weight, italic);
    return files.length > 0 && files.some((f) => loadedFiles.has(`${meta.family}|${f.url}`));
  }
  if (!hasFontApi()) return false;
  try {
    // document.fonts.check() is also true when NO face of the family is known yet (the Google CSS has
    // not arrived), which would measure with a fallback face: require a loaded face of the family too.
    let loaded = false;
    document.fonts.forEach((f) => {
      if (!loaded && f.status === 'loaded' && f.family.replace(/["']/g, '').trim() === meta.family) loaded = true;
    });
    return loaded && document.fonts.check(fontString(id, 16, weight, false));
  } catch {
    return false;
  }
}

/** Absolute URL for a face file (print windows load fonts from the opener's origin). */
const absolute = (url: string, origin: string): string => {
  if (/^(data:|https?:)/i.test(url)) return url;
  try {
    return new URL(url, origin.endsWith('/') ? origin : `${origin}/`).toString();
  } catch {
    return url;
  }
};
const cssString = (s: string) => `"${s.replace(/["\\\n\r]/g, '')}"`;

/**
 * `@font-face` CSS for the used Latin faces (all shipped weights/styles; unicode-range keeps the
 * unneeded slices idle) with absolute URLs — for the print window. Script faces are not included:
 * use `googleFontsHref(ids)` for those.
 */
export function fontFaceCss(ids: readonly FontId[], origin: string): string {
  const rules: string[] = [];
  for (const id of [...new Set(ids.filter(known))]) {
    if (!isLatin(id)) continue;
    const family = FONT_REGISTRY[id].family;
    for (const f of FONT_FILES[id]) {
      rules.push(
        `@font-face{font-family:${cssString(family)};font-style:${f.style};font-weight:${f.weight};font-display:block;` +
          `src:url(${cssString(absolute(f.url, origin))}) format("woff2");${f.unicodeRange ? `unicode-range:${f.unicodeRange};` : ''}}`
      );
    }
  }
  return rules.join('\n');
}

/** Test hook: forget every load (module state is per page load in the app). */
export function resetFontLoaderForTests(): void {
  faceLoads.clear();
  loadedFiles.clear();
  scriptLoads.clear();
  injectedHrefs.clear();
  generation = 0;
}
