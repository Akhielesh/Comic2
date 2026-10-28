// Client-patch sanitizers "timeline" (contract §5.4 / §12.1; timeline.md §3.1). Owner: P1-TIMELINE.
//
//   pages_reorder · page_insert · page_duplicate · page_delete · page_restore · book · render_use · version_star
//
// Every op is FREE (no spend, no render, no new asset). A sanitizer returns the op to commit, rebuilt
// from known keys with bounded values and server stamps (deletedAt / at = ctx.now), or throws a
// StudioError that rejects the WHOLE batch: 400 for malformed input, 409 CONFLICT for a busy render
// (an in-flight paid image must never land on a missing page or be swapped under the user), 409 LIMIT
// at the page cap, 409 CONTENT_POLICY for a blocked image. Sanitizers see the doc as it was before the
// batch (jobs.ts sanitizePatchOps), so ids created earlier in the same batch are not visible here.
//
// The director's timeline tools commit through the same sanitizers (tools/timeline.ts), so the UI and
// the director share one validator.

import {
  archiveOf,
  findPage,
  getRender,
  trashOf,
  type AssetRef,
  type ComicDoc,
  type Page,
  type RenderState,
  type RenderTarget
} from '../../../../shared/comic/doc.js';
import { SAFE_ID_RE, type DocOp } from '../../../../shared/comic/ops.js';
import { DOC_LIMITS } from '../../../../shared/comic/limits.js';
import { canServeToOwner } from '../../../../shared/comic/safety.js';
import type { OpSanitizer, SanitizeCtx } from '../extensions.js';
import { isServerArt } from '../publication/snapshot.js';
import { StudioError } from '../types.js';
import { enteredText } from './text.js';

type Op<K extends DocOp['op']> = Extract<DocOp, { op: K }>;

/** newId for a duplicate must stay ≤ 52 chars so derived child ids (`${newId}_l12_7`) remain SAFE_IDs. */
export const MAX_DUPLICATE_ID_CHARS = 52;
const MAX_SUMMARY_CHARS = 1000;
const MAX_LAYOUT_CHARS = 1000;

const bad = (message: string) => new StudioError('BAD_REQUEST', message, { status: 400 });
const conflict = (message: string) => new StudioError('CONFLICT', message, { status: 409 });
const limit = (message: string) => new StudioError('LIMIT', message, { status: 409 });
const policy = (message: string) => new StudioError('CONTENT_POLICY', message, { status: 409 });

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isBusy = (r?: RenderState) => !!r && (r.status === 'queued' || r.status === 'rendering');

/** The page ceiling for this user: DOC_LIMITS.pages, lowered (never raised) by StudioCaps.maxPages. */
export const pageCapFor = (ctx?: Pick<SanitizeCtx, 'caps'>): number => {
  const m = ctx?.caps?.maxPages;
  return typeof m === 'number' && Number.isFinite(m) && m >= 1 ? Math.min(DOC_LIMITS.pages, Math.floor(m)) : DOC_LIMITS.pages;
};

const safeId = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !SAFE_ID_RE.test(v)) throw bad(`Invalid ${what} id.`);
  return v;
};

const existingPage = (doc: ComicDoc, v: unknown): Page => {
  const page = findPage(doc, safeId(v, 'page'));
  if (!page) throw bad('That page is no longer in the book.');
  return page;
};

const inTrash = (doc: ComicDoc, id: string) => trashOf(doc).some((t) => t.page.id === id);

const pageCapError = (cap: number) => limit(`A comic can have up to ${cap} pages — delete one first, or start a second comic.`);

/** Busy wording shared by delete / duplicate / version swaps (the UI shows it verbatim). */
const busyMessage = (label: string, what: string) => `${label} is still drawing — ${what} when it's done.`;

/** Free text as it enters the doc: no NUL or lone surrogate (jsonb), trimmed, clipped without splitting a pair. */
const str = (v: unknown, max: number, what: string): string => {
  if (typeof v !== 'string') throw bad(`Invalid ${what}.`);
  return enteredText(v, max);
};

// ── Render targets and the asset index ───────────────────────────────────────

const TARGET_KINDS = new Set(['page', 'cover', 'sheet', 'place', 'style_option']);

/** A well-formed RenderTarget (shape only; existence is checked by the caller). */
export const parseRenderTarget = (raw: unknown): RenderTarget => {
  if (!isObject(raw) || typeof raw.kind !== 'string' || !TARGET_KINDS.has(raw.kind)) throw bad('Unknown image.');
  if (raw.kind === 'cover') return { kind: 'cover' };
  return { kind: raw.kind as 'page' | 'sheet' | 'place' | 'style_option', id: safeId(raw.id, raw.kind === 'style_option' ? 'style option' : raw.kind) };
};

/** Where an image lives in the doc. `art` = page or cover art (current, history, archive or deleted pages). */
export type AssetRole = 'art' | 'sheet' | 'place' | 'style_option' | 'board' | 'ref' | 'attachment' | 'inbox';

export interface AssetIndexEntry {
  /** First AssetRef seen with this path (its safety verdict travels with copies). */
  asset: AssetRef;
  roles: Set<AssetRole>;
  /** Any copy of this path is blocked or quarantined. */
  blocked: boolean;
  /** In some render history or the archive (version_star scope). */
  versioned: boolean;
}

/**
 * Every PRIMARY asset path in the doc (variants and ref originals are not usable as art on their own)
 * with the roles it plays. Pure; O(assets).
 */
export function assetIndex(doc: ComicDoc): Map<string, AssetIndexEntry> {
  const out = new Map<string, AssetIndexEntry>();
  const add = (a: AssetRef | undefined, role: AssetRole, versioned = false) => {
    if (!a || typeof a.path !== 'string' || !a.path) return;
    let e = out.get(a.path);
    if (!e) {
      e = { asset: a, roles: new Set(), blocked: false, versioned: false };
      out.set(a.path, e);
    }
    e.roles.add(role);
    if (!canServeToOwner(a)) e.blocked = true;
    if (versioned) e.versioned = true;
  };
  const addRender = (r: RenderState | undefined, role: AssetRole, versionedHistory = true) => {
    if (!r) return;
    add(r.asset, role);
    for (const v of r.history || []) add(v, role, versionedHistory);
  };
  for (const p of doc.pages) addRender(p.render, 'art');
  addRender(doc.cover.render, 'art');
  for (const t of trashOf(doc)) addRender(t.page.render, 'art', false);
  for (const c of doc.cast) {
    addRender(c.sheet, 'sheet');
    for (const r of c.refs || []) add(r, 'ref');
  }
  for (const p of doc.places) {
    addRender(p.sheet, 'place');
    for (const r of p.refs || []) add(r, 'ref');
  }
  for (const o of doc.style.options) addRender(o.render, 'style_option');
  add(doc.style.board, 'board');
  for (const r of doc.style.refs || []) add(r, 'ref');
  for (const a of archiveOf(doc)) {
    const kind = a.targetKey.split(':')[0];
    const role: AssetRole = kind === 'page' || kind === 'cover' ? 'art' : kind === 'sheet' ? 'sheet' : kind === 'place' ? 'place' : 'style_option';
    add(a, role, true);
  }
  for (const r of doc.refInbox || []) add(r, 'inbox');
  for (const m of doc.conversation) for (const a of m.attachments || []) add(a, 'attachment');
  return out;
}

// ── Sanitizers ───────────────────────────────────────────────────────────────

const pagesReorder: OpSanitizer<Op<'pages_reorder'>> = {
  op: 'pages_reorder',
  sanitize(doc, op) {
    const raw = (op as { order?: unknown }).order;
    if (!Array.isArray(raw) || !raw.length) throw bad('Invalid page order.');
    if (raw.length > DOC_LIMITS.reorderIds) throw bad('Too many pages in that order.');
    const known = new Set(doc.pages.map((p) => p.id));
    const seen = new Set<string>();
    for (const v of raw) {
      const id = safeId(v, 'page');
      if (!known.has(id)) throw bad('A page in that order is no longer in the book.');
      if (seen.has(id)) throw bad('A page appears twice in that order.');
      seen.add(id);
    }
    // Pages not mentioned keep their relative order after the listed ones (applyOp appends them).
    return { op: 'pages_reorder', order: [...seen] };
  }
};

const pageInsert: OpSanitizer<Op<'page_insert'>> = {
  op: 'page_insert',
  sanitize(doc, op, ctx) {
    const id = safeId(op.id, 'page');
    if (findPage(doc, id) || inTrash(doc, id)) throw bad('A page with that id already exists.');
    const n = doc.pages.length;
    if (!isInt(op.after) || op.after < 0 || op.after > n) throw bad(`“after” must be a page number from 0 to ${n}.`);
    const cap = pageCapFor(ctx);
    if (n >= cap) throw pageCapError(cap);
    const out: Op<'page_insert'> = { op: 'page_insert', id, after: op.after };
    if (op.patch !== undefined && op.patch !== null) {
      if (!isObject(op.patch)) throw bad('Invalid page.');
      const patch: NonNullable<Op<'page_insert'>['patch']> = {};
      if (op.patch.summary !== undefined) patch.summary = str(op.patch.summary, MAX_SUMMARY_CHARS, 'page summary');
      if (op.patch.layout !== undefined) patch.layout = str(op.patch.layout, MAX_LAYOUT_CHARS, 'page layout');
      if (op.patch.chapterTitle !== undefined) {
        const title = str(op.patch.chapterTitle, DOC_LIMITS.chapterTitleChars, 'chapter title');
        if (title) patch.chapterTitle = title;
      }
      if (Object.keys(patch).length) out.patch = patch;
    }
    return out;
  }
};

const pageDuplicate: OpSanitizer<Op<'page_duplicate'>> = {
  op: 'page_duplicate',
  sanitize(doc, op, ctx) {
    const src = existingPage(doc, op.id);
    if (isBusy(src.render)) throw conflict(busyMessage(`Page ${src.n}`, 'duplicate it'));
    const newId = safeId(op.newId, 'page');
    if (newId.length > MAX_DUPLICATE_ID_CHARS) throw bad('That page id is too long.');
    if (findPage(doc, newId) || inTrash(doc, newId)) throw bad('A page with that id already exists.');
    const cap = pageCapFor(ctx);
    if (doc.pages.length >= cap) throw pageCapError(cap);
    const out: Op<'page_duplicate'> = { op: 'page_duplicate', id: src.id, newId };
    if (op.after !== undefined && op.after !== null) {
      if (!isInt(op.after) || op.after < 0 || op.after > doc.pages.length) throw bad(`“after” must be a page number from 0 to ${doc.pages.length}.`);
      out.after = op.after;
    }
    return out;
  }
};

const pageDelete: OpSanitizer<Op<'page_delete'>> = {
  op: 'page_delete',
  sanitize(doc, op, ctx) {
    const page = existingPage(doc, op.id);
    if (isBusy(page.render)) throw conflict(busyMessage(`Page ${page.n}`, 'delete it'));
    // The server stamps the time; the client value is ignored. `purge` (undo of an insert/duplicate)
    // is honoured by applyOp only when no image of the page would become unreferenced.
    return { op: 'page_delete', id: page.id, deletedAt: ctx.now, ...((op as { purge?: unknown }).purge === true ? { purge: true } : {}) };
  }
};

const pageRestore: OpSanitizer<Op<'page_restore'>> = {
  op: 'page_restore',
  sanitize(doc, op, ctx) {
    const id = safeId(op.id, 'page');
    if (!inTrash(doc, id)) throw bad('That page is not in Deleted any more.');
    if (findPage(doc, id)) throw bad('That page is already in the book.');
    const cap = pageCapFor(ctx);
    if (doc.pages.length >= cap) throw pageCapError(cap);
    const out: Op<'page_restore'> = { op: 'page_restore', id };
    if (op.n !== undefined && op.n !== null) {
      if (!isInt(op.n) || op.n < 1) throw bad('Invalid page position.');
      out.n = op.n;
    }
    return out;
  }
};

const book: OpSanitizer<Op<'book'>> = {
  op: 'book',
  sanitize(_doc, op) {
    if (!isObject(op.patch)) throw bad('Invalid book settings.');
    const raw = op.patch as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of ['titlePage', 'endPage', 'firstPageRight', 'uniformTrim'] as const) {
      if (raw[key] === undefined) continue;
      if (typeof raw[key] !== 'boolean') throw bad(`Invalid book setting: ${key}.`);
      patch[key] = raw[key];
    }
    if (raw.backCover !== undefined) {
      if (raw.backCover !== 'none' && raw.backCover !== 'auto') throw bad('Back cover must be "none" or "auto".');
      patch.backCover = raw.backCover;
    }
    if (raw.blurb !== undefined) {
      if (raw.blurb === null) patch.blurb = null;
      else {
        if (typeof raw.blurb !== 'string') throw bad('Invalid back-cover blurb.');
        if (raw.blurb.length > DOC_LIMITS.bookBlurbChars) throw bad(`The back-cover blurb can be up to ${DOC_LIMITS.bookBlurbChars} characters.`);
        patch.blurb = raw.blurb.trim();
      }
    }
    if (raw.credits !== undefined) {
      if (raw.credits === null) patch.credits = null;
      else {
        if (!Array.isArray(raw.credits)) throw bad('Invalid credits.');
        if (raw.credits.length > DOC_LIMITS.bookCredits) throw bad(`Up to ${DOC_LIMITS.bookCredits} credit lines.`);
        const lines: string[] = [];
        for (const c of raw.credits) {
          if (typeof c !== 'string') throw bad('Invalid credit line.');
          if (c.length > DOC_LIMITS.bookCreditChars) throw bad(`A credit line can be up to ${DOC_LIMITS.bookCreditChars} characters.`);
          const t = c.trim();
          if (t) lines.push(t);
        }
        patch.credits = lines;
      }
    }
    if (!Object.keys(patch).length) throw bad('Nothing to change in the book settings.');
    // Free text (blurb, credits) goes through the safety pre-filter in the whole-batch screen.
    return { op: 'book', patch: patch as Op<'book'>['patch'] };
  }
};

const laneSegment = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-');
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An image the SERVER wrote for THIS comic: its generated/derived art lane (u/<owner>/p/<doc>/img/…),
 * its private reference lane (…/ref/…, server re-encoded, no client storage policies) or the platform
 * library. Legacy-imported refs live in client-writable lanes (<uid>/<file>, u/<uid>/tmp/…) or in
 * another project's lane, so they can never become page or cover art (S6: the publish gate checks a
 * verdict by path; a client-writable path can be swapped or hold animated bytes after the check).
 */
export const isServerArtForComic = (path: string, doc: Pick<ComicDoc, 'id'>, userId: string): boolean => {
  if (typeof path !== 'string' || !path) return false;
  if (/^library\/[^/]+(?:\/[^/]+)+$/.test(path) && !path.includes('..')) return true;
  if (!userId || !doc?.id) return false;
  const lane = new RegExp(`^u/${escapeRe(laneSegment(userId))}/p/${escapeRe(laneSegment(doc.id))}/(?:img|ref)/[A-Za-z0-9_@.-]+$`);
  return lane.test(path) && !path.includes('..');
};

const OUTSIDE_IMAGE_MESSAGE = 'That photo came from an older comic, so it can’t go on a page as it is — upload it again in Media first.';
/** This comic's own lane, but an `upload` in the public img lane: the publish boundary (isServerArt) refuses it, so say so now. */
const UNPUBLISHABLE_IMAGE_MESSAGE = 'That image was brought in from outside the studio, so it can’t go on a page as it is — upload it again in Media first.';

const renderUse: OpSanitizer<Op<'render_use'>> = {
  op: 'render_use',
  sanitize(doc, op, ctx) {
    const target = parseRenderTarget(op.target);
    const render = getRender(doc, target);
    if (!render) throw bad('That image is no longer in the comic.');
    const label = target.kind === 'cover' ? 'The cover' : target.kind === 'page' ? `Page ${findPage(doc, target.id)?.n ?? ''}`.trim() : 'That image';
    if (isBusy(render)) throw conflict(busyMessage(label, 'switch versions'));
    if (typeof op.path !== 'string' || !op.path) throw bad('Pick a version.');
    const index = assetIndex(doc);
    const entry = index.get(op.path);
    // Only images this comic already owns (renders, versions, archive, deleted pages, uploads): never a
    // foreign path, never a size variant or a ref original on its own.
    if (!entry) throw bad("That image isn't part of this comic.");
    if (entry.blocked) throw policy("That image didn't pass the content check, so it can't be used.");
    if (target.kind === 'page' || target.kind === 'cover') {
      const key = target.kind === 'cover' ? 'cover' : `page:${target.id}`;
      const ownVersion = render.asset?.path === op.path || render.history.some((v) => v.path === op.path) || archiveOf(doc).some((a) => a.path === op.path && a.targetKey === key);
      // Anything new to this page/cover must be an image the server made for this comic (S6) — and one
      // the publish boundary accepts (publication/snapshot.ts isServerArt: never an `upload` in the public
      // img lane), so "Use for page" refuses now what Publish would refuse later, with the same remedy.
      if (!ownVersion && !isServerArtForComic(op.path, doc, ctx?.userId)) throw bad(OUTSIDE_IMAGE_MESSAGE);
      if (!ownVersion && !isServerArt(entry.asset)) throw bad(UNPUBLISHABLE_IMAGE_MESSAGE);
      // A photo, attachment, sheet or style option becoming page/cover art must be an explicit "Use as page".
      if (!ownVersion && !entry.roles.has('art') && (op as { adopt?: unknown }).adopt !== true) {
        throw bad('Use “Use for page” in Media to put that image on a page.');
      }
    }
    // `adopt` is a UI confirmation only: stripped. The server stamps the time.
    return { op: 'render_use', target, path: op.path, at: ctx.now };
  }
};

const versionStar: OpSanitizer<Op<'version_star'>> = {
  op: 'version_star',
  sanitize(doc, op) {
    if (typeof op.path !== 'string' || !op.path) throw bad('Pick a version to star.');
    if (typeof op.starred !== 'boolean') throw bad('Invalid star.');
    const entry = assetIndex(doc).get(op.path);
    if (!entry?.versioned) throw bad('Only earlier versions can be starred.');
    return { op: 'version_star', path: op.path, starred: op.starred };
  }
};

export const TIMELINE_SANITIZERS: OpSanitizer[] = [
  pagesReorder,
  pageInsert,
  pageDuplicate,
  pageDelete,
  pageRestore,
  book,
  renderUse,
  versionStar
] as OpSanitizer[];
