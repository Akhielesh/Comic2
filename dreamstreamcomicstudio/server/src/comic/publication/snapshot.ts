// The public snapshot of a comic (contract §9.3, sharing.md §3.2): an allow-listed,
// ComicDoc-shaped object built BY CONSTRUCTION from explicit fields — never by spreading the
// live doc — so a private field added to ComicDoc later can never leak by accident. The
// snapshot test asserts the exact key set at every level.
//
// Also: the publish plan (which live paths become which opaque pub/<key>/ copies), the
// ShareCard (what previews and the edge need), and the content fingerprint that drives the
// "changes since publishing" badge. Pure: no I/O.

import crypto from 'node:crypto';
import {
  COMIC_DOC_VERSION,
  DEFAULT_SETTINGS,
  type AssetRef,
  type AssetVariant,
  type Balloon,
  type ComicDoc,
  type ComicKind,
  type Cover,
  type I18nState,
  type Line,
  type Page,
  type Panel,
  type QcReport,
  type TextTranslation
} from '../../../../shared/comic/doc.js';
import { hashString } from '../../../../shared/comic/hash.js';
import { i18nOf, lineSourceHash, localizeDoc, publicI18n } from '../../../../shared/comic/i18n.js';
import { languageSpec, sameLanguage } from '../../../../shared/comic/languages.js';
import type { ShareCard } from '../../../../shared/comic/publication.js';
import { isSafeStoragePath, variantPathFor } from '../assets.js';
import { isLibraryPath, pubPath } from '../storagePaths.js';
import type { SnapshotPlan } from './index.js';

// ── Text hygiene ─────────────────────────────────────────────────────────────

/** Strip control/bidi-override characters, collapse whitespace, clamp to `max` graphemes-ish (code points). */
export function cleanText(value: unknown, max: number): string {
  const text = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : text;
}

const KIND_LABEL: Record<ComicKind, string> = {
  comic: 'Comic',
  manga: 'Manga',
  webtoon: 'Webtoon',
  strip: 'Comic strip',
  storybook: 'Storybook'
};
export const kindLabelOf = (kind: ComicKind | undefined): string => KIND_LABEL[kind as ComicKind] || 'Comic';

// ── Which pages are drawn ────────────────────────────────────────────────────

/** A page (or cover) whose current art can be published: it has an asset and is not mid-render. */
export const hasPublishableArt = (render: { status: string; asset?: AssetRef } | undefined): boolean =>
  !!render?.asset?.path && (render.status === 'ready' || render.status === 'stale');

/** Pages with art, in reading order. */
export const drawnPages = (doc: ComicDoc): Page[] => (doc.pages || []).filter((p) => hasPublishableArt(p.render));

// ── The publication boundary (S6) ────────────────────────────────────────────

const IMG_LANE_RE = /^u\/[^/]+\/p\/[^/]+\/img\/[^/]+$/;
const REF_LANE_RE = /^u\/[^/]+\/p\/[^/]+\/ref\/[^/]+$/;

/**
 * Only bytes the SERVER wrote, in a lane no client can rewrite, are ever published:
 *  - `u/<user>/p/<project>/ref/…` — the private bucket (no storage policies): uploads, crops and
 *    fits, always re-encoded server-side to static WebP (saveRef / cropRef / fitToAspect);
 *  - `u/<user>/p/<project>/img/…` the server made (generated, derived, library picks) — random
 *    UUID names, re-encoded static WebP (saveGenerated / storeEncoded);
 *  - `library/…` — the platform library.
 * Refused: the classic `<uid>/<file>` lane and `u/<uid>/tmp/…` (both client-writable), anything
 * else, and an `upload` in the public img lane (a legacy import can point a ref at any owned path
 * there). So a client-placed object, an animated GIF/APNG that only had its first frame checked,
 * or bytes swapped after their check can never reach pub/: every allowed object is a server
 * re-encode at a path the client can't write.
 */
export const isServerArt = (asset: AssetRef | undefined): boolean => {
  const path = asset?.path;
  if (!path || !isSafeStoragePath(path)) return false;
  if (isLibraryPath(path) || REF_LANE_RE.test(path)) return true;
  return IMG_LANE_RE.test(path) && asset!.source !== 'upload';
};

/**
 * A size variant is published only from its deterministic sibling path (`<base>_w480.webp`), which
 * the server derives from the original and overwrites (assets.ts writeVariants) — or the library.
 */
const isServerVariant = (asset: AssetRef, v: AssetVariant): boolean =>
  isSafeStoragePath(v.path) && (v.path === variantPathFor(asset.path, v.w) || (isLibraryPath(asset.path) && isLibraryPath(v.path)));

// ── Paths ────────────────────────────────────────────────────────────────────

/** 12 hex of sha256(live path): the copy's name is stable for the same source (republish skips it). */
export const sha12 = (livePath: string): string => crypto.createHash('sha256').update(livePath).digest('hex').slice(0, 12);

const VARIANT_WIDTHS = new Set([480, 1080]);

/** The opaque copies of one live asset: original + its 480/1080 variants. */
export function copiesFor(assetKey: string, slot: 'cover' | 'page', asset: AssetRef): Record<string, string> {
  const out: Record<string, string> = {};
  const hash = sha12(asset.path);
  out[asset.path] = pubPath(assetKey, slot, hash);
  for (const v of asset.variants || []) {
    if (!v || typeof v.path !== 'string' || !VARIANT_WIDTHS.has(v.w)) continue;
    out[v.path] = pubPath(assetKey, slot, hash, v.w as 480 | 1080);
  }
  return out;
}

/**
 * The asset with only the variants the server derived at their deterministic paths (see
 * isServerVariant). Every reader of a live asset's variants on the publish path goes through it: the
 * copies (planSnapshot) and the share image the OG card is drawn from (publication.ts previewPathOf).
 */
export const withServerVariants = (asset: AssetRef): AssetRef =>
  asset.variants?.length ? { ...asset, variants: asset.variants.filter((v) => !!v && typeof v.path === 'string' && isServerVariant(asset, v)) } : asset;

/** The publish plan: which pages/cover go out and where every live path is copied. */
export function planSnapshot(
  doc: ComicDoc,
  opts: { assetKey: string; pageIds: string[]; includeCover: boolean; languages: string[]; defaultLang?: string }
): SnapshotPlan {
  const paths: Record<string, string> = {};
  const wanted = new Set(opts.pageIds);
  const pageIds: string[] = [];
  for (const page of doc.pages || []) {
    if (!wanted.has(page.id) || !hasPublishableArt(page.render)) continue;
    pageIds.push(page.id);
    Object.assign(paths, copiesFor(opts.assetKey, 'page', withServerVariants(page.render.asset!)));
  }
  const includeCover = opts.includeCover && hasPublishableArt(doc.cover?.render);
  if (includeCover) Object.assign(paths, copiesFor(opts.assetKey, 'cover', withServerVariants(doc.cover.render.asset!)));
  return {
    assetKey: opts.assetKey,
    pageIds,
    includeCover,
    languages: [...opts.languages],
    ...(opts.defaultLang ? { defaultLang: opts.defaultLang } : {}),
    paths
  };
}

// ── Snapshot builder ─────────────────────────────────────────────────────────

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Plain JSON copy (drops functions/undefined; the snapshot is stored as jsonb anyway). */
const plain = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** PublicAsset: path/size/variants of the opaque copy, nothing else (no model, safety, libraryId, derivedFrom). */
function publicAsset(asset: AssetRef, plan: SnapshotPlan): AssetRef | null {
  const path = plan.paths[asset.path];
  if (!path) return null;
  const out: AssetRef = { path, source: 'generated', at: 0 };
  if (num(asset.w)) out.w = asset.w;
  if (num(asset.h)) out.h = asset.h;
  const variants: AssetVariant[] = [];
  for (const v of asset.variants || []) {
    const vp = v && plan.paths[v.path];
    if (vp && num(v.w) && num(v.h)) variants.push({ path: vp, w: v.w, h: v.h });
  }
  if (variants.length) out.variants = variants.sort((a, b) => a.w - b.w);
  return out;
}

const publicLine = (line: Line): Line => {
  const out: Line = { id: String(line.id), kind: line.kind, text: String(line.text ?? '') };
  if (typeof line.speakerId === 'string' && line.speakerId) out.speakerId = line.speakerId;
  if (line.style && typeof line.style === 'object') out.style = plain(line.style);
  // A rendering hint, not private: a never-translated line (spell, made-up word, song) stays in the
  // source language in every edition, so the reader neither counts it as "untranslated" nor marks a
  // published edition incomplete (editionProgress / fallbackLineIds read it; P2-PUBLIC-PAYLOAD).
  if (line.noTranslate === true) out.noTranslate = true;
  return out;
};

const publicPanel = (panel: Panel): Panel => ({
  id: String(panel.id),
  n: num(panel.n) ? panel.n : 1,
  size: panel.size,
  shot: 'medium',
  action: '',
  castIds: [],
  lines: (panel.lines || []).map(publicLine)
});

const BALLOON_KEYS: (keyof Balloon)[] = ['lineId', 'x', 'y', 'w', 'tailX', 'tailY', 'pinned', 'z', 'locked', 'linkTo'];
const publicBalloon = (b: Balloon): Balloon => {
  const out: Record<string, unknown> = {};
  for (const key of BALLOON_KEYS) if (b[key] !== undefined) out[key] = b[key];
  return out as unknown as Balloon;
};

const publicQc = (qc: QcReport | undefined): QcReport | undefined =>
  qc && Array.isArray(qc.panelBoxes) && qc.panelBoxes.length
    ? { score: 0, issues: [], checkedAt: 0, panelBoxes: qc.panelBoxes.filter((b) => b && num(b.x) && num(b.y) && num(b.w) && num(b.h)).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h })) }
    : undefined;

function publicPage(page: Page, n: number, plan: SnapshotPlan): Page | null {
  const asset = page.render.asset ? publicAsset(page.render.asset, plan) : null;
  if (!asset) return null;
  const qc = publicQc(page.render.qc);
  const out: Page = {
    id: String(page.id),
    n,
    summary: '',
    layout: typeof page.layout === 'string' ? page.layout : '',
    panels: (page.panels || []).map(publicPanel),
    balloons: (page.balloons || []).map(publicBalloon),
    render: { status: 'ready', asset, history: [], ...(qc ? { qc } : {}) }
  };
  if (typeof page.chapterTitle === 'string' && page.chapterTitle.trim()) out.chapterTitle = page.chapterTitle;
  return out;
}

function publicCover(cover: Cover | undefined, plan: SnapshotPlan): Cover {
  const out: Cover = { render: { status: 'none', history: [] } };
  if (typeof cover?.title === 'string' && cover.title) out.title = cover.title;
  if (typeof cover?.tagline === 'string' && cover.tagline) out.tagline = cover.tagline;
  if (cover?.lettering === 'overlay' || cover?.lettering === 'in_art') out.lettering = cover.lettering;
  if (cover?.titleStyle && typeof cover.titleStyle === 'object') out.titleStyle = plain(cover.titleStyle);
  const asset = plan.includeCover && cover?.render?.asset ? publicAsset(cover.render.asset, plan) : null;
  if (asset) out.render = { status: 'ready', asset, history: [] };
  return out;
}

/**
 * §9.3 allow-list snapshot. Every path is the opaque pub/<assetKey>/ copy; no u/<user>/p/<project>
 * path, no project id, no private field anywhere. Pages are the planned (cleared + drawn) ones,
 * renumbered contiguously.
 */
export function buildSnapshot(doc: ComicDoc, plan: SnapshotPlan): ComicDoc {
  const at = num(plan.publishedAt) ? plan.publishedAt : 0;
  const wanted = new Set(plan.pageIds);
  const pages: Page[] = [];
  for (const page of doc.pages || []) {
    if (!wanted.has(page.id)) continue;
    const pub = publicPage(page, pages.length + 1, plan);
    if (pub) pages.push(pub);
  }
  const source = doc.format?.language || 'en';
  const editions = (plan.languages || []).filter((l) => !sameLanguage(l, source));
  const brief: ComicDoc['brief'] = { title: String(doc.brief?.title ?? ''), notes: [] };
  if (typeof doc.brief?.logline === 'string' && doc.brief.logline) brief.logline = doc.brief.logline;
  const style: ComicDoc['style'] = { status: 'locked', refs: [], options: [] };
  if (typeof doc.style?.name === 'string' && doc.style.name) style.name = doc.style.name;

  const snapshot: ComicDoc = {
    v: COMIC_DOC_VERSION,
    id: String(plan.publicationId || 'publication'),
    createdAt: at,
    updatedAt: at,
    rev: num(plan.rev) ? plan.rev : 0,
    brief,
    format: {
      kind: doc.format.kind,
      pageCount: pages.length,
      pageAspect: doc.format.pageAspect,
      panelsPerPage: doc.format.panelsPerPage,
      readingDirection: doc.format.readingDirection,
      lettering: doc.format.lettering,
      colorMode: doc.format.colorMode,
      language: source
    },
    source: {},
    style,
    cast: (doc.cast || []).map((c) => ({
      id: String(c.id),
      name: String(c.name ?? ''),
      tier: c.tier,
      look: { summary: '' },
      refs: [],
      sheet: { status: 'none', history: [] }
    })),
    places: [],
    pages,
    cover: publicCover(doc.cover, plan),
    planStatus: 'approved',
    settings: { ...DEFAULT_SETTINGS },
    spend: { totalUsd: 0, byKind: {}, entries: [] },
    gate: null,
    conversation: []
  };
  if (doc.letterStyle) snapshot.letterStyle = plain(doc.letterStyle);
  if (doc.book) snapshot.book = plain(doc.book);
  if (doc.reader) snapshot.reader = plain(doc.reader);
  snapshot.i18n = onlyPublishedLines(publicI18n(i18nOf(doc), editions), pages, i18nOf(doc));
  return snapshot;
}

/**
 * Translations (and per-language balloon geometry) of the published lines only: a withheld page's
 * lines, or a line deleted since it was translated, never ride along in the public payload. Cover
 * and brief translations stay (the snapshot publishes both).
 *
 * Each kept line translation carries the source hash of the PUBLISHED line when it was current in
 * the live doc (publicI18n blanks it), so the snapshot is self-consistent: editionProgress /
 * editionReadiness over the public doc see a published edition as complete (the legacy
 * /public/:id `languages[].complete` and the reader's language list rely on it). The hash is of
 * public text only; a stale translation keeps '' (publishing refuses stale editions anyway).
 */
function onlyPublishedLines(i18n: NonNullable<ComicDoc['i18n']>, pages: Page[], live: I18nState): NonNullable<ComicDoc['i18n']> {
  const lines = new Map<string, Line>();
  for (const p of pages) for (const panel of p.panels) for (const l of panel.lines) lines.set(l.id, l);
  const keep = <T>(rec: Record<string, T> | undefined): Record<string, T> => Object.fromEntries(Object.entries(rec || {}).filter(([id]) => lines.has(id)));
  const editions: typeof i18n.editions = {};
  for (const [lang, e] of Object.entries(i18n.editions)) {
    const liveLines = live.editions[lang]?.lines || {};
    const out: Record<string, TextTranslation> = {};
    for (const [id, t] of Object.entries(keep(e.lines))) {
      const hash = lineSourceHash(lines.get(id)!);
      const current = Object.prototype.hasOwnProperty.call(liveLines, id) && liveLines[id]?.sourceHash === hash;
      out[id] = { ...t, sourceHash: current ? hash : '' };
    }
    editions[lang] = { ...e, lines: out, balloons: keep(e.balloons) };
  }
  return { ...i18n, editions };
}

/** Every storage path inside a snapshot (assets + variants), for the reader's url map. */
export function snapshotPaths(snapshot: ComicDoc): string[] {
  const out = new Set<string>();
  const add = (a?: AssetRef) => {
    if (!a?.path) return;
    out.add(a.path);
    for (const v of a.variants || []) if (v?.path) out.add(v.path);
  };
  add(snapshot.cover?.render?.asset);
  for (const p of snapshot.pages || []) add(p.render?.asset);
  return [...out];
}

// ── Content fingerprint ("changes since publishing") ─────────────────────────

/**
 * Hash of everything a reader would see from the live doc (art paths, text, layout, lettering,
 * published translations). Equal fingerprints ⇒ republishing would change nothing.
 */
export function contentFingerprint(doc: ComicDoc, languages: string[]): string {
  const source = doc.format?.language || 'en';
  const editions = languages.filter((l) => !sameLanguage(l, source));
  const view = {
    brief: [doc.brief?.title, doc.brief?.logline],
    format: [doc.format?.kind, doc.format?.pageAspect, doc.format?.readingDirection, doc.format?.lettering],
    cover: [doc.cover?.title, doc.cover?.tagline, doc.cover?.lettering, doc.cover?.titleStyle, hasPublishableArt(doc.cover?.render) ? doc.cover.render.asset!.path : ''],
    pages: drawnPages(doc).map((p) => [
      p.id,
      p.render.asset!.path,
      p.chapterTitle,
      (p.panels || []).map((pn) => (pn.lines || []).map((l) => [l.id, l.kind, l.speakerId, l.text, l.style])),
      p.balloons
    ]),
    cast: (doc.cast || []).map((c) => [c.id, c.name]),
    letterStyle: doc.letterStyle,
    book: doc.book,
    reader: doc.reader,
    i18n: publicI18n(i18nOf(doc), editions)
  };
  return hashString(JSON.stringify(view));
}

// ── Share card ───────────────────────────────────────────────────────────────

export interface CardInputs {
  doc: ComicDoc;
  snapshot: ComicDoc;
  languages: string[];
  /** Public URL builder for a pub/ path. */
  publicUrl: (path: string) => string;
  og: ShareCard['og'];
  themeColor?: string;
  creator?: string;
}

/** Localized title/description for one published language (source when lang is the source). */
export function localizedText(doc: ComicDoc, lang: string, pageCount: number): { title: string; description: string } {
  const view = sameLanguage(lang, doc.format?.language) ? doc : localizeDoc(doc, lang);
  const title = cleanText(view.brief?.title || view.cover?.title || 'Untitled comic', 90) || 'Untitled comic';
  const label = kindLabelOf(doc.format?.kind).toLowerCase();
  const fallback = `A ${pageCount}-page ${label} made with DreamStream Studio`;
  const description = cleanText(view.brief?.logline || view.cover?.tagline || fallback, 200) || fallback;
  return { title, description };
}

/** The 1080w public URL of the cover (else the first page), for instant first paint. */
export function coverUrlOf(snapshot: ComicDoc, publicUrl: (path: string) => string): string | undefined {
  const asset = snapshot.cover?.render?.asset || snapshot.pages?.[0]?.render?.asset;
  if (!asset) return undefined;
  const v1080 = (asset.variants || []).find((v) => v.w === 1080) || (asset.variants || []).slice(-1)[0];
  return publicUrl((v1080 || asset).path);
}

export function buildShareCard(input: CardInputs): ShareCard {
  const { doc, snapshot, languages } = input;
  const pageCount = snapshot.pages.length;
  const kindLabel = kindLabelOf(doc.format?.kind);
  const source = localizedText(doc, doc.format?.language || 'en', pageCount);
  const i18n: ShareCard['i18n'] = {};
  for (const lang of languages) i18n[lang] = localizedText(doc, lang, pageCount);
  const primary = i18n[languages[0]] || source;
  const card: ShareCard = {
    v: 1,
    title: primary.title,
    description: primary.description,
    kindLabel,
    pageCount,
    aspect: doc.format.pageAspect,
    og: input.og,
    i18n
  };
  const coverUrl = coverUrlOf(snapshot, input.publicUrl);
  if (coverUrl) card.coverUrl = coverUrl;
  if (input.creator) card.creator = cleanText(input.creator, 40);
  if (input.themeColor && /^#[0-9a-fA-F]{6}$/.test(input.themeColor)) card.themeColor = input.themeColor;
  return card;
}

/** "English / हिन्दी" for the OG meta row. */
export const languagesLabel = (languages: string[]): string =>
  languages.map((l) => languageSpec(l)?.endonym || l).slice(0, 4).join(' / ');

/** File-name-safe language slot: 'zh-Hans' → 'zhhans'. */
export const langSlot = (lang: string): string => (String(lang || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'src').slice(0, 12);

export const OG_PATH_RE = /^pub\/[A-Za-z0-9]{22}\/og-[a-z0-9]{2,12}-[0-9a-f]{12}\.jpg$/;
export const ogPath = (assetKey: string, lang: string, hash12: string): string => `pub/${assetKey}/og-${langSlot(lang)}-${hash12}.jpg`;
