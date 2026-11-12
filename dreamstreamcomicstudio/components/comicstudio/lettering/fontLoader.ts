// Lettering font loader (lettering.md §6.5, master plan §2.6 / §2.8). Client only; the shared registry
// (shared/comic/lettering/fonts.ts) holds the metadata, this module loads the files.
//
// - Every face is self-hosted (@fontsource, pinned in package.json); nothing is fetched from another host.
// - Latin faces (the 12 base faces, FONT_FILES, and the 28 Pro faces) are registered with the FontFace API under
//   PRIVATE family names ('DSL Comic Neue', 'DSL Bungee', …) so they never collide with the legacy Google
//   'Comic Neue'/'Bangers' link in index.html. Board, print and export use byte-identical files.
// - Script faces (the 14 Noto families) keep their Noto names. Their files are unicode-range slices (a CJK weight is
//   about 125 of them): the loader registers the slices of the asked weight and lets `document.fonts.load(font, sample)`
//   fetch only the ones the text touches, as a stylesheet would.
// - On demand only: importing this module loads nothing. A face's table (fontFiles.ts LAZY_FONT_FILES, one chunk per Pro
//   or script table) and its files load the first time `ensureFonts` asks for that face, once (memoized per face file).
// - Never rejects and works (as a no-op) without a DOM.
// - `fontLoadGeneration()` bumps whenever a face finishes loading so measuring hooks can re-plan with
//   real metrics (useLetteringFontsReady).

import { FONT_IDS, type FontId, type LatinFontId } from '../../../shared/comic/lettering/style';
import { PRO_FONT_IDS, isProFontId, type AnyFontId } from '../../../shared/comic/lettering/proFonts';
import { fontFaceMeta, fontString } from '../../../shared/comic/lettering/fonts';
import { FONT_FILES, LAZY_FONT_FILES, type FontFile } from './fontFiles';

export interface EnsureFontsResult<T extends AnyFontId = FontId> {
  /** Faces that are ready to measure and draw. */
  loaded: T[];
  /** Faces that failed or timed out (a fallback face will be used; never silent — callers may tell the user). */
  failed: T[];
}

const ALL_IDS: readonly AnyFontId[] = [...FONT_IDS, ...PRO_FONT_IDS];
const isLatin = (id: AnyFontId): id is LatinFontId => Object.prototype.hasOwnProperty.call(FONT_FILES, id);
const known = (id: unknown): id is AnyFontId => typeof id === 'string' && (ALL_IDS as readonly string[]).includes(id);
/** Script faces load as unicode-range slices; Latin and Pro faces load file by file. */
const isSliced = (id: AnyFontId): boolean => !isLatin(id) && !isProFontId(id);

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

// ── Face tables (the base Latin table is eager; Pro and script tables load on first use) ─────────────────────────

const tables = new Map<AnyFontId, FontFile[]>();
const tableLoads = new Map<AnyFontId, Promise<FontFile[]>>();

/** The files of a face, loading its table chunk the first time (an empty list when it cannot load; retried next time). */
const loadTable = (id: AnyFontId): Promise<FontFile[]> => {
  if (isLatin(id)) return Promise.resolve(FONT_FILES[id] || []);
  const ready = tables.get(id);
  if (ready) return Promise.resolve(ready);
  const pending = tableLoads.get(id);
  if (pending) return pending;
  // Settles on a later tick, so the pending entry below is always set before it is cleared.
  const p = Promise.resolve()
    .then(async () => {
      const load = LAZY_FONT_FILES[id as keyof typeof LAZY_FONT_FILES];
      const files = load ? await load() : [];
      if (files?.length) tables.set(id, files);
      return files || [];
    })
    .catch(() => [] as FontFile[]) // retried on the next ask
    .finally(() => tableLoads.delete(id));
  tableLoads.set(id, p);
  return p;
};
/** The files of a face whose table is already here (the eager Latin table, or a table an earlier load fetched). */
const tableNow = (id: AnyFontId): FontFile[] => (isLatin(id) ? FONT_FILES[id] || [] : tables.get(id) || []);

/** Load the tables (not the font files) of these faces, so `fontFaceCss` can list them. Never rejects. */
export async function preloadFontFiles(ids: readonly AnyFontId[]): Promise<void> {
  await Promise.all([...new Set(ids.filter(known))].map(loadTable));
}

/** The files a style needs from `files`: the nearest shipped weight, italic only when the face ships it. */
const pick = (files: readonly FontFile[], weight: number, italic: boolean): FontFile[] => {
  if (!files.length) return [];
  const weights = [...new Set(files.map((f) => f.weight))];
  const target = Number.isFinite(weight) ? weight : 400;
  const w = weights.reduce((best, x) => (Math.abs(x - target) < Math.abs(best - target) ? x : best), weights[0]);
  const style = italic && files.some((f) => f.style === 'italic') ? 'italic' : 'normal';
  return files.filter((f) => f.weight === w && f.style === style);
};

/** Face files a style needs: the nearest shipped weight, italic only when the face ships it. */
export const filesFor = (id: LatinFontId, weight = 400, italic = false): FontFile[] => pick(FONT_FILES[id] || [], weight, italic);

// ── Latin and Pro faces (FontFace API, file by file) ──────────────────────────

const faceLoads = new Map<string, Promise<boolean>>();
const loadedFiles = new Set<string>();

const fontFace = (family: string, file: FontFile, display: FontDisplay): FontFace =>
  new FontFace(family, `url(${JSON.stringify(file.url)}) format("woff2")`, {
    weight: String(file.weight),
    style: file.style,
    unicodeRange: file.unicodeRange || undefined,
    display
  });

const loadFile = (family: string, file: FontFile, timeoutMs: number): Promise<boolean> => {
  const key = `${family}|${file.url}`;
  const existing = faceLoads.get(key);
  if (existing) return existing;
  const p = (async () => {
    if (!hasFontApi()) return false;
    try {
      const face = fontFace(family, file, 'block');
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

// ── Script faces (self-hosted unicode-range slices) ───────────────────────────

const registered = new Set<string>();
/** Add a slice to document.fonts without fetching it: the browser fetches it when text in its range needs it. */
const registerSlice = (family: string, file: FontFile) => {
  const key = `${family}|${file.url}`;
  if (registered.has(key)) return;
  try {
    document.fonts.add(fontFace(family, file, 'swap'));
    registered.add(key);
  } catch {
    /* an engine without FontFace descriptors: the load below reports the face as failed */
  }
};

const scriptLoads = new Map<string, Promise<boolean>>();
const loadScriptFace = (id: AnyFontId, family: string, files: readonly FontFile[], weight: number, sample: string, timeoutMs: number): Promise<boolean> => {
  const key = `${id}|${weight}|${sample}`;
  const existing = scriptLoads.get(key);
  if (existing) return existing;
  const p = (async () => {
    if (!hasFontApi()) return false;
    const slices = pick(files, weight, false);
    if (!slices.length) return false;
    try {
      for (const f of slices) registerSlice(family, f);
      const font = fontString(id, 16, weight, false);
      // One budget for every slice the sample needs (the exporter waits at most `timeoutMs`).
      const ok = await Promise.race([
        document.fonts.load(font, sample || undefined).then((faces) => faces.length > 0, () => false),
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

/**
 * Load lettering faces (base or Pro ids) on demand; resolves with what is ready (never rejects). Each face file is
 * fetched once; a face nobody asks for is never fetched.
 */
export async function ensureFonts<T extends AnyFontId = FontId>(ids: readonly T[], opts: EnsureFontsOptions = {}): Promise<EnsureFontsResult<T>> {
  listenToDocumentFonts();
  const unique = [...new Set(ids.filter((id): id is T => known(id)))];
  const weights = opts.weights?.length ? opts.weights : [400, 700];
  const timeoutMs = opts.timeoutMs ?? 5000;
  const loaded: T[] = [];
  const failed: T[] = [];
  if (!hasFontApi()) return { loaded, failed: unique };
  await Promise.all(
    unique.map(async (id) => {
      const meta = fontFaceMeta(id);
      const files = meta ? await loadTable(id) : [];
      const jobs: Promise<boolean>[] = [];
      if (meta && files.length) {
        if (isSliced(id)) {
          for (const w of weights) jobs.push(loadScriptFace(id, meta.family, files, w, opts.sample || '', timeoutMs));
        } else {
          for (const w of weights) {
            for (const file of pick(files, w, false)) jobs.push(loadFile(meta.family, file, timeoutMs));
            if (opts.italic && meta.italic) for (const file of pick(files, w, true)) jobs.push(loadFile(meta.family, file, timeoutMs));
          }
        }
      }
      const results = await Promise.all(jobs);
      (results.length && results.some(Boolean) ? loaded : failed).push(id);
    })
  );
  const order = (list: T[]) => ALL_IDS.filter((id) => (list as readonly AnyFontId[]).includes(id)) as T[];
  return { loaded: order(loaded), failed: order(failed) };
}

/** True when a face file for (id, weight, italic) has loaded (script faces: a loaded slice and document.fonts.check). */
export function isFontReady(id: AnyFontId, weight = 400, italic = false): boolean {
  if (!known(id)) return false;
  const meta = fontFaceMeta(id);
  if (!meta) return false;
  if (!isSliced(id)) {
    const files = pick(tableNow(id), weight, italic);
    return files.length > 0 && files.some((f) => loadedFiles.has(`${meta.family}|${f.url}`));
  }
  if (!hasFontApi()) return false;
  try {
    // document.fonts.check() is also true when NO face of the family is known yet, which would measure with a
    // fallback face: require a loaded face of the family too.
    let ready = false;
    document.fonts.forEach((f) => {
      if (!ready && f.status === 'loaded' && f.family.replace(/["']/g, '').trim() === meta.family) ready = true;
    });
    return ready && document.fonts.check(fontString(id, 16, weight, false));
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
 * `@font-face` CSS for the used faces with absolute URLs, for the print window: every shipped weight and style (or only
 * the nearest shipped weights to `weights`); unicode-range keeps the unneeded slices idle. Base Latin faces are always
 * included; a Pro or script face once its table is loaded (`ensureFonts` or `preloadFontFiles` loads it; the export
 * path runs `prepareExportFonts` first). No third-party stylesheet is ever needed.
 */
export function fontFaceCss(ids: readonly AnyFontId[], origin: string, weights?: readonly number[]): string {
  const rules: string[] = [];
  for (const id of [...new Set(ids.filter(known))]) {
    const meta = fontFaceMeta(id);
    if (!meta) continue;
    let files = tableNow(id);
    if (weights?.length) {
      const keep = new Set(weights.map((w) => pick(files, w, false)[0]?.weight).filter((w): w is number => w !== undefined));
      files = files.filter((f) => keep.has(f.weight));
    }
    for (const f of files) {
      rules.push(
        `@font-face{font-family:${cssString(meta.family)};font-style:${f.style};font-weight:${f.weight};font-display:block;` +
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
  registered.clear();
  tables.clear();
  tableLoads.clear();
  generation = 0;
}
