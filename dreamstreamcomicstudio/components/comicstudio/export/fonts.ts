// Fonts for exports (lettering.md §6.5, i18n.md §6.1). A canvas measures and draws with whatever face
// is ready at that moment, so every export loads the exact faces its lettering uses BEFORE planning:
//   1. plan every exported page once with the registry estimates to learn the faces, weights, italics
//      and the real text each face will draw (Indic and CJK faces are split into unicode-range slices —
//      the sample must hold the actual characters);
//   2. `ensureFonts` (self-hosted Latin faces + lazily loaded script faces) and `ensureFontsFor` (each
//      language's dialogue / SFX / legible role faces, after their stylesheet has loaded);
//   3. hand back a FRESH measure: canvas metrics for faces that loaded, estimates for the rest.
// Never rejects. `degraded` is true only when the browser could load fonts and a face did not arrive
// in time — then the file may use a fallback face, and callers say so (FONT_NOTICE) instead of failing.

import type { ComicDoc } from '../../../shared/comic/doc';
import { estimateMeasure, letteringAspect, planLettering, type Measure } from '../../../shared/comic/lettering/layout';
import { fontByFamily, resolveLetteringFont } from '../../../shared/comic/lettering/fonts';
import type { FontId } from '../../../shared/comic/lettering/style';
import { scriptOf } from '../../../shared/comic/languages';
import { graphemes } from '../../../shared/comic/textLayout';
import { planCoverTitle } from '../lettering/CoverTitleLayer';
import { ensureFonts } from '../lettering/fontLoader';
import { createMeasure, parseFont } from '../lettering/measure';
import { ensureFontsFor } from '../i18n/scriptFonts';

export const FONT_NOTICE = 'Some lettering fonts didn’t load, so the file may use a fallback font. Try again in a moment for the exact lettering.';

/** Per-face wait (the export path always allowed 5 s). */
export const EXPORT_FONT_TIMEOUT_MS = 5000;
const SAMPLE_MAX = 4000;

export interface ExportFonts {
  /** Measure to plan with now (canvas metrics for faces that loaded). */
  measure: Measure;
  /** A face the export needs did not load in time (a fallback face may be used). */
  degraded: boolean;
  failed: FontId[];
  /** User-facing note when degraded. */
  notice?: string;
}

export interface ExportFace {
  id: FontId;
  weights: number[];
  italic: boolean;
  /** Every distinct grapheme this face draws (unicode-range slices load from it). */
  sample: string;
}

interface FaceAcc {
  id: FontId;
  weights: Set<number>;
  italic: boolean;
  chars: Set<string>;
}

const hasFontApi = (): boolean =>
  typeof document !== 'undefined' && !!(document as Document & { fonts?: FontFaceSet }).fonts && typeof FontFace !== 'undefined';

/** Faces, languages and sample text an export of these (localized) docs draws. Pure. */
export function exportFaces(
  docs: readonly ComicDoc[],
  extra: readonly { id: FontId; weight: number; italic?: boolean; text?: string }[] = []
): { faces: ExportFace[]; langs: string[]; sample: string } {
  const faces = new Map<FontId, FaceAcc>();
  const langs = new Set<string>();
  const all = new Set<string>();
  const add = (font: string, fallbackId: FontId | undefined, text: string, lang: string) => {
    const parsed = parseFont(font);
    const id = (parsed && fontByFamily(parsed.family)?.id) || fallbackId;
    if (!id) return;
    const acc = faces.get(id) ?? { id, weights: new Set<number>(), italic: false, chars: new Set<string>() };
    acc.weights.add(parsed?.weight ?? 400);
    acc.italic = acc.italic || !!parsed?.italic;
    for (const g of graphemes(text, lang)) {
      if (/\s/.test(g)) continue;
      acc.chars.add(g);
      all.add(g);
    }
    faces.set(id, acc);
  };
  for (const doc of docs) {
    const lang = doc.format?.language || 'en';
    langs.add(lang);
    if (doc.format?.lettering === 'overlay') {
      for (const page of doc.pages || []) {
        if (!page.render?.asset?.path) continue;
        for (const plan of planLettering(doc, page, letteringAspect(doc, page), estimateMeasure)) {
          if (plan.lang) langs.add(plan.lang);
          add(plan.font, plan.fontId, plan.runs.map((r) => r.text).join(' '), plan.lang || lang);
        }
      }
    }
    if (doc.cover?.lettering === 'overlay') {
      const a = doc.cover.render?.asset;
      const aspect = a?.w && a?.h ? a.w / a.h : letteringAspect(doc, null);
      const plan = planCoverTitle(doc, aspect, estimateMeasure);
      for (const blk of [plan.title, plan.tagline]) if (blk) add(blk.font, undefined, blk.text, blk.lang);
    }
  }
  for (const e of extra) {
    const acc = faces.get(e.id) ?? { id: e.id, weights: new Set<number>(), italic: false, chars: new Set<string>() };
    acc.weights.add(e.weight);
    acc.italic = acc.italic || !!e.italic;
    for (const g of graphemes(e.text || '')) if (!/\s/.test(g)) acc.chars.add(g);
    faces.set(e.id, acc);
  }
  const cut = (s: Set<string>) => [...s].join('').slice(0, SAMPLE_MAX);
  return {
    faces: [...faces.values()].map((f) => ({ id: f.id, weights: [...f.weights].sort((a, b) => a - b), italic: f.italic, sample: cut(f.chars) })),
    langs: [...langs],
    sample: cut(all)
  };
}

/** The display face a language's titles use (motion-comic title cards): the SFX role face. */
export const titleFaceFor = (lang: string): { id: FontId; weight: number; font: (px: number) => string } => {
  const r = resolveLetteringFont('bangers', 'sfx', lang, { weight: 400 });
  const family = `"${r.family}"`;
  return { id: r.fontId, weight: r.weight, font: (px) => `${r.weight} ${Math.round(px * 100) / 100}px ${family}, Impact, "Noto Sans", system-ui, sans-serif` };
};

/**
 * Load every face these docs' lettering draws, then return a fresh measure. Never rejects.
 * `extra` adds faces drawn outside the lettering (the motion comic's title card).
 */
export async function prepareExportFonts(
  docs: readonly ComicDoc[],
  opts: { timeoutMs?: number; extra?: readonly { id: FontId; weight: number; italic?: boolean; text?: string }[] } = {}
): Promise<ExportFonts> {
  const timeoutMs = opts.timeoutMs ?? EXPORT_FONT_TIMEOUT_MS;
  const { faces, langs, sample } = exportFaces(docs, opts.extra);
  if (!faces.length || !hasFontApi()) return { measure: createMeasure(), degraded: false, failed: [] };
  const failed = new Set<FontId>();
  const loads = faces.map((f) =>
    ensureFonts([f.id], { weights: f.weights, italic: f.italic, sample: f.sample, timeoutMs })
      .then((r) => r.failed.forEach((id) => failed.add(id)))
      .catch(() => failed.add(f.id))
  );
  const needsScripts = langs.some((l) => scriptOf(l).id !== 'Latn');
  const scripts = needsScripts
    ? ensureFontsFor(langs, ['dialogue', 'sfx', 'legible'], sample, timeoutMs).then(
        (r) => r.degraded,
        () => true
      )
    : Promise.resolve(false);
  const [, scriptDegraded] = await Promise.all([Promise.all(loads), scripts]);
  const degraded = failed.size > 0 || scriptDegraded;
  return { measure: createMeasure(), degraded, failed: [...failed], ...(degraded ? { notice: FONT_NOTICE } : {}) };
}
