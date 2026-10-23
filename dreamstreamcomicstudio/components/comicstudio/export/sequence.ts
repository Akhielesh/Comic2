// What an export contains, in what order (timeline.md §4.1, contract §11.3): ONE collector for the
// PDF, the PNG ZIP, the print view and the motion comic, built on `bookSequence` — cover → title
// plate → pages by number → "The End" → back cover. It replaces the five copies that used to drift.
//
// Honest by construction: every page that is planned but not drawn, every image whose link isn't
// signed yet and every image the safety check withheld is reported in `skipped` with the reason —
// never silently dropped, and a withheld image is never fetched (it never reaches a download).

import { bookSequence, type BookSlotKind } from '../../../shared/comic/book';
import { i18nOf, localizeDoc } from '../../../shared/comic/i18n';
import { languageSpec, sameLanguage } from '../../../shared/comic/languages';
import { canServeToOwner } from '../../../shared/comic/safety';
import { aspectRatioOf } from '../../../shared/comic/models';
import { bookOf, type AssetRef, type ComicDoc, type Page } from '../../../shared/comic/doc';
import { letteringAspect } from '../../../shared/comic/lettering/layout';
import type { PlateKind } from '../timeline/plates';
import { padIndex } from './filenames';
import { ExportError } from './errors';

export type UrlFor = (asset?: AssetRef | string | null) => string | undefined;

export interface ExportSlot {
  /** 'cover' | 'title' | page.id | 'end' | 'back_cover' */
  key: string;
  kind: BookSlotKind;
  label: string;
  /** Reading-order file name base: '00-cover', '01-title', '02-page-01', '05-end', '06-back-cover'. */
  fileBase: string;
  page?: Page;
  asset?: AssetRef;
  /** Art URL (cover and pages). Plates have none (software draws them). */
  url?: string;
  /** Software plate (free). */
  plate?: PlateKind;
  /** Width / height of the art (asset size, else the book's page aspect). */
  aspect: number;
}

export interface CollectOptions {
  /** Include the enabled book plates (default true). */
  plates?: boolean;
}

/** The book's trim aspect (width / height) from `format.pageAspect`. */
export const trimAspectOf = (doc: Pick<ComicDoc, 'format'>): number => {
  const a = aspectRatioOf(doc.format?.pageAspect);
  return a > 0 && Number.isFinite(a) ? a : 2 / 3;
};

const assetAspect = (doc: ComicDoc, asset?: AssetRef): number =>
  asset?.w && asset?.h && asset.w > 0 && asset.h > 0 ? asset.w / asset.h : trimAspectOf(doc);

const plateFile: Record<PlateKind, string> = { title: 'title', end: 'end', back_cover: 'back-cover' };

/** Cover, plates and drawn pages in reading order, plus what was left out and why. */
export function collectExportSlots(doc: ComicDoc, urlFor: UrlFor, opts: CollectOptions = {}): { slots: ExportSlot[]; skipped: string[] } {
  const withPlates = opts.plates !== false;
  const picked: Omit<ExportSlot, 'fileBase'>[] = [];
  const skipped: string[] = [];
  for (const s of bookSequence(doc, { audience: 'studio' })) {
    if (s.kind === 'title' || s.kind === 'end' || s.kind === 'back_cover') {
      if (withPlates) picked.push({ key: s.key, kind: s.kind, label: s.label, plate: s.kind, aspect: trimAspectOf(doc) });
      continue;
    }
    const asset = s.kind === 'cover' ? doc.cover.render.asset : s.page?.render.asset;
    const label = s.kind === 'cover' ? 'Cover' : `Page ${s.page?.n ?? '?'}`;
    if (!asset?.path) {
      // An undrawn cover is optional and never reported; an undrawn page is.
      if (s.kind === 'page') skipped.push(`${label} (not drawn yet)`);
      continue;
    }
    if (!canServeToOwner(asset)) {
      skipped.push(`${label} (withheld by the safety check)`);
      continue;
    }
    const url = urlFor(asset);
    if (!url) {
      skipped.push(`${label} (image link not ready yet)`);
      continue;
    }
    picked.push({
      key: s.key,
      kind: s.kind,
      label,
      ...(s.page ? { page: s.page } : {}),
      asset,
      url,
      aspect: s.page ? letteringAspect(doc, s.page) : assetAspect(doc, asset)
    });
  }
  const total = picked.length;
  const slots = picked.map((p, i): ExportSlot => {
    const what = p.plate ? plateFile[p.plate] : p.kind === 'cover' ? 'cover' : `page-${String(p.page?.n ?? i).padStart(2, '0')}`;
    return { ...p, fileBase: `${padIndex(i, total)}-${what}` };
  });
  return { slots, skipped };
}

/** Uniform trim on (default): every sheet at `format.pageAspect`, art letterboxed on white. */
export const uniformTrimOf = (doc: ComicDoc): boolean => bookOf(doc).uniformTrim !== false;

// ── Languages ─────────────────────────────────────────────────────────────────

/** Languages this doc can be exported in: the source plus every edition it carries. */
export function availableLanguages(doc: ComicDoc): string[] {
  const source = doc.format?.language || 'en';
  const out = [source];
  for (const lang of Object.keys(i18nOf(doc).editions || {})) if (!out.some((l) => sameLanguage(l, lang))) out.push(lang);
  return out;
}

/**
 * The languages an "all languages" export holds: the requested list (or the published editions from
 * `doc.publication`, or just the source), kept only when the doc really has that edition, source first.
 */
export function exportLanguages(doc: ComicDoc, requested?: readonly string[]): string[] {
  const available = availableLanguages(doc);
  const source = available[0];
  const wanted = requested?.length ? requested : doc.publication?.languages?.length ? doc.publication.languages : [source];
  const out: string[] = [];
  for (const w of wanted) {
    const hit = available.find((a) => sameLanguage(a, w));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  out.sort((a, b) => (a === source ? -1 : b === source ? 1 : 0));
  return out.length ? out : [source];
}

/**
 * The doc as a reader of `lang` sees it (localizeDoc). An unknown edition throws an honest error
 * instead of silently exporting the source language under another language's name.
 */
export function localizedFor(doc: ComicDoc, lang?: string): ComicDoc {
  if (!lang || sameLanguage(lang, doc.format?.language || 'en')) return doc;
  const hit = Object.keys(i18nOf(doc).editions || {}).find((l) => sameLanguage(l, lang));
  if (!hit) {
    const name = languageSpec(lang)?.english ?? lang;
    throw new ExportError(`There is no ${name} edition of this comic yet.`);
  }
  return localizeDoc(doc, hit);
}
