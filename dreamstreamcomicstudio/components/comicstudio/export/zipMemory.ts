// ZIP memory guard (P2-EXPORT review, OPEN "memory"; the owner has not chosen a streaming ZIP, so this
// is the conservative option). A PNG ZIP is built in the browser and the browser has to hold the whole
// archive until it is saved. A 30-page book in 6 languages at ~2K is well over 1 GB — enough to crash a
// phone tab, losing the reader's place and the export.
//
// Two defences:
//   1. zipExport writes the archive into Blob slices (zipToBlob) instead of one big output buffer plus
//      a Blob copy of it. The PNGs themselves are still held once each (JSZip reads every PNG Blob into
//      an ArrayBuffer when it is added), so the browser holds about twice the PNG bytes at the end:
//      the PNGs and the written archive.
//   2. This guard, before anything is fetched or drawn: estimate the PNG bytes the archive will hold
//      (images × languages × long edge²) against a budget for THIS device:
//        fits               → full size, as before;
//        too big            → every image is drawn smaller (never below MIN_ZIP_EDGE) and the result
//                             says so honestly (`notice`), e.g. "saved at up to 1,472 px (full size is 2,048 px)";
//        too big even then  → an honest ExportError (code 'too_big') before any work: for every
//                             language, "download one language at a time" — only when one language
//                             really fits; otherwise (and for one language) "use the PDF".
// The estimate is pessimistic (painted art compresses poorly as PNG) and the budget is a fraction of the
// device's memory. Numbers are judgement calls (no owner decision yet); they live here, in one place.

import { MAX_EXPORT_EDGE, DEFAULT_PLATE_WIDTH } from './rasterize';
import type { ExportSlot } from './sequence';

/** Painted, lettered art as PNG: ~2.5 bytes per pixel (canvas PNGs of AI art run ~1.8–2.5). Conservative. */
export const PNG_BYTES_PER_PIXEL = 2.5;
/** Software plates are flat colour and text: they compress far better. */
export const PLATE_BYTES_PER_PIXEL = 0.6;
/** Never shrink pages below this long edge to make a ZIP fit (a page must stay comfortably readable). */
export const MIN_ZIP_EDGE = 1280;
/** Art whose size is unknown is assumed to be this big (the default image models' long edge). */
export const ASSUMED_ART_EDGE = 2048;

const MB = 1024 * 1024;
/**
 * Budgets for the PNG bytes one archive holds (the browser briefly holds about twice this: the PNGs
 * and the written archive). `phone` / `computer` apply when the device's memory is unknown (Safari,
 * Firefox); otherwise ~8 % of navigator.deviceMemory, between `min` and `max`.
 */
export const ZIP_BUDGET = { min: 128 * MB, phone: 256 * MB, computer: 768 * MB, max: 1024 * MB } as const;

export interface ZipMemoryEnv {
  /** navigator.deviceMemory (GB; Chromium only, capped at 8). */
  deviceMemoryGb?: number;
  /** A touch-first device (phone / tablet) — used when deviceMemory is unknown (Safari, Firefox). */
  coarse?: boolean;
}

const readEnv = (): ZipMemoryEnv => {
  if (typeof navigator === 'undefined') return {};
  const dm = (navigator as Navigator & { deviceMemory?: unknown }).deviceMemory;
  let coarse = false;
  try {
    coarse = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    coarse = false;
  }
  return { ...(typeof dm === 'number' && Number.isFinite(dm) && dm > 0 ? { deviceMemoryGb: dm } : {}), coarse };
};

/** How many PNG bytes this device should hold for one ZIP. */
export function zipMemoryBudget(env: ZipMemoryEnv = readEnv()): number {
  if (env.deviceMemoryGb && env.deviceMemoryGb > 0) {
    // ~8 % of the device's memory: 8 GB → ~655 MB, 4 GB → ~328 MB, 2 GB → ~164 MB; 128 MB … 1 GB.
    return Math.round(Math.min(ZIP_BUDGET.max, Math.max(ZIP_BUDGET.min, env.deviceMemoryGb * 1024 * MB * 0.08)));
  }
  return env.coarse ? ZIP_BUDGET.phone : ZIP_BUDGET.computer;
}

export interface ZipMemoryPlan {
  /** Estimated PNG bytes at full size (all languages). */
  fullBytes: number;
  /** Estimated PNG bytes as planned (after any reduction). */
  bytes: number;
  budget: number;
  /** The largest art long edge at full size (px). */
  fullEdge: number;
  /** Cap on every image's long edge (px) — set only when the ZIP had to be made smaller. */
  maxEdge?: number;
  /** false: too big even at MIN_ZIP_EDGE — the export refuses honestly instead of crashing the tab. */
  fits: boolean;
}

const ratioOf = (aspect: number): number => {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 2 / 3;
  return a < 1 ? a : 1 / a; // short edge / long edge
};

/** The long edge (px) an art slot is drawn at, as rasterSize would (before any cap). */
const artEdge = (slot: ExportSlot, longEdge?: number): number => {
  const natural = slot.asset?.w && slot.asset?.h && slot.asset.w > 0 && slot.asset.h > 0 ? Math.max(slot.asset.w, slot.asset.h) : ASSUMED_ART_EDGE;
  return Math.min(MAX_EXPORT_EDGE, longEdge && longEdge > 0 ? longEdge : natural);
};

/** The long edge (px) of a software plate (width = plateWidth, height from the trim aspect). */
const plateEdge = (slot: ExportSlot, plateWidth: number): number => {
  const a = Number.isFinite(slot.aspect) && slot.aspect > 0 ? slot.aspect : 2 / 3;
  return Math.min(MAX_EXPORT_EDGE, Math.max(plateWidth, plateWidth / a));
};

/** Estimated PNG bytes for one copy of every slot, with every long edge capped at `cap`. */
const bytesFor = (slots: readonly ExportSlot[], longEdge: number | undefined, plateWidth: number, cap: number): number => {
  let total = 0;
  for (const s of slots) {
    const plate = !!s.plate;
    const edge = Math.min(cap, plate ? plateEdge(s, plateWidth) : artEdge(s, longEdge));
    total += edge * edge * ratioOf(s.aspect) * (plate ? PLATE_BYTES_PER_PIXEL : PNG_BYTES_PER_PIXEL);
  }
  return total;
};

/**
 * Plan a ZIP of `slots` in `languages` copies within the device budget: full size when it fits,
 * else the largest long-edge cap (≥ MIN_ZIP_EDGE, a multiple of 16) that fits, else `fits: false`.
 */
export function planZipMemory(
  slots: readonly ExportSlot[],
  languages: number,
  opts: { longEdge?: number; plateWidth?: number; budget?: number } = {}
): ZipMemoryPlan {
  const copies = Math.max(1, Math.floor(languages) || 1);
  const budget = opts.budget && opts.budget > 0 ? opts.budget : zipMemoryBudget();
  const plateWidth = opts.plateWidth && opts.plateWidth > 0 ? opts.plateWidth : DEFAULT_PLATE_WIDTH;
  const art = slots.filter((s) => !s.plate);
  const fullEdge = Math.round(
    Math.max(0, ...art.map((s) => artEdge(s, opts.longEdge)), ...slots.filter((s) => s.plate).map((s) => plateEdge(s, plateWidth)))
  );
  const at = (cap: number) => bytesFor(slots, opts.longEdge, plateWidth, cap) * copies;
  const fullBytes = at(Infinity);
  if (fullBytes <= budget || fullEdge <= 0) return { fullBytes, bytes: fullBytes, budget, fullEdge, fits: true };

  // Bytes grow with edge²: start at the square-root ratio, then step down (small images stay as they
  // are, so a cap saves less than the ratio promises) until it fits or reaches the floor.
  let cap = fullEdge * Math.sqrt(budget / fullBytes);
  for (let i = 0; i < 8; i += 1) {
    const snapped = Math.max(MIN_ZIP_EDGE, Math.floor(cap / 16) * 16);
    const bytes = at(snapped);
    if (bytes <= budget) return { fullBytes, bytes, budget, fullEdge, maxEdge: snapped, fits: true };
    if (snapped === MIN_ZIP_EDGE) return { fullBytes, bytes, budget, fullEdge, maxEdge: snapped, fits: false };
    cap = snapped * Math.sqrt(budget / bytes) * 0.98;
  }
  const bytes = at(MIN_ZIP_EDGE);
  return { fullBytes, bytes, budget, fullEdge, maxEdge: MIN_ZIP_EDGE, fits: bytes <= budget };
}

const fmtPx = (n: number) => `${Math.round(n).toLocaleString('en-US')} px`;
const fmtMb = (bytes: number) => `${Math.max(1, Math.round(bytes / MB)).toLocaleString('en-US')} MB`;

/** The honest line a smaller-than-full-size ZIP carries in its result's `notice`. */
export function zipReducedNotice(plan: ZipMemoryPlan, opts: { languages: number; oneLanguageFits?: boolean }): string | undefined {
  if (!plan.maxEdge || !plan.fits) return undefined;
  const base = `To fit in this device’s memory, the images were saved at up to ${fmtPx(plan.maxEdge)} (full size is ${fmtPx(plan.fullEdge)}).`;
  if (opts.languages > 1 && opts.oneLanguageFits) return `${base} Download one language at a time for full-size pages.`;
  return base;
}

/**
 * The refusal for a ZIP that would not fit even at MIN_ZIP_EDGE (said before any work starts).
 * "One language at a time" is advised only when one language really fits (`oneLanguageFits` false ⇒
 * even a single language is too big, so the honest next step is the PDF).
 */
export function zipTooBigMessage(plan: ZipMemoryPlan, opts: { languages: number; pages: number; oneLanguageFits?: boolean }): string {
  const need = `about ${fmtMb(plan.bytes)} of memory`;
  if (opts.languages > 1 && opts.oneLanguageFits !== false) {
    return `This book is too big to zip in all ${opts.languages} languages at once on this device (${opts.pages} images × ${opts.languages} languages would need ${need}). Download one language at a time instead.`;
  }
  if (opts.languages > 1) {
    return `This book is too big to zip on this device, even one language at a time (${opts.pages} images × ${opts.languages} languages would need ${need}). Download each language’s PDF instead — it keeps every page in one smaller file — or use a computer.`;
  }
  return `This book has too many pages to zip on this device (it would need ${need}). Download the PDF instead — it keeps every page in one smaller file — or use a computer.`;
}

/** Can one language of these slots be zipped on this device (at any size ≥ MIN_ZIP_EDGE)? */
export const oneLanguageZipFits = (slots: readonly ExportSlot[], opts: { longEdge?: number; plateWidth?: number; budget?: number } = {}): boolean =>
  planZipMemory(slots, 1, opts).fits;
