// Director tool group "timeline" (contract §12.1/§12.2; timeline.md §3.3). Owner: P1-TIMELINE.
//
//   move_page · insert_page · duplicate_page · delete_page · restore_page   FREE (insert_page {write} = TEXT)
//   list_versions · use_version                                             FREE (picking a version never redraws)
//   set_book                                                                FREE (title page / The End / back cover are software)
//   fit_render                                                              FREE (pad/crop a wrong-shape page; never a redraw)
//
// Every edit commits through jobs.ts sanitizePatchOps — the same validator the timeline UI uses — so
// busy pages answer 409 ("still drawing") and nothing unvalidated reaches the doc. Tool results are
// honest sentences with the new order / version count; when nothing matched they list what exists.
// The per-turn tool list stays small: tools() offers only what the doc can use right now.

import {
  archiveOf,
  bookOf,
  findPage,
  getRender,
  isPageStale,
  isTargetStale,
  newId,
  pageByNumber,
  renderTargetKey,
  resolveCharacter,
  targetLabel,
  trashOf,
  type ArchivedVersion,
  type AssetRef,
  type BookSettings,
  type Card,
  type ComicDoc,
  type Page,
  type RenderTarget,
  type RenderVersion
} from '../../../../shared/comic/doc.js';
import { applyOp, type DocOp } from '../../../../shared/comic/ops.js';
import { aspectFromSize, aspectMatches, formatUsd, getImageModel, IMAGE_MODELS, PLAN_USD_PER_PAGE } from '../../../../shared/comic/models.js';
import { reorderIds, continuityHint, versionList, type VersionEntry } from '../../../../shared/comic/book.js';
import { unitPrice } from '../../../../shared/comic/plan.js';
import { DOC_LIMITS, MAX_ARCHIVE } from '../../../../shared/comic/limits.js';
import { canServeToOwner } from '../../../../shared/comic/safety.js';
import { defineTool, toolArgError, toolErrorText, type DirectorTool, type ToolGroup } from '../extensions.js';
import { planPages, sanitizeCtxFor, sanitizePatchOps, spendIsByok } from '../jobs.js';
import { MAX_PAID_TEXT_PER_TURN, pushNextSteps, type DirectorTurn } from '../tools.js';
import type { StudioContext } from '../types.js';
import { runFitRender } from '../actions/timeline.js';
import { costViewFor, governDollars } from '../costText.js';

// ── Pure helpers (exported for tests and summaries) ──────────────────────────

const sortedPages = (doc: ComicDoc): Page[] => [...doc.pages].sort((a, b) => a.n - b.n);
const isBusyPage = (p: Page) => p.render.status === 'queued' || p.render.status === 'rendering';
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const clip = (s: string | undefined, max: number) => {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** "1–3, 5" */
const ranges = (ns: number[]): string => {
  const sorted = [...new Set(ns)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return parts.join(', ');
};
const pagesWord = (ns: number[]) => `${ns.length === 1 ? 'page' : 'pages'} ${ranges(ns)}`;

/** A tool result with prices worded for this user (costText.ts): dollars for admins and own keys, a share of the usage otherwise. */
const priced = (ctx: StudioContext, text: string): string => governDollars(text, costViewFor(ctx.caps));

/** Friendly model name for a stored model id (registry id or a provider route id); unknown ids pass through. */
export const modelName = (id?: string): string | undefined => {
  if (!id) return undefined;
  const spec = getImageModel(id) ?? IMAGE_MODELS.find((m) => Object.values(m.routes).includes(id));
  return spec?.nickname ?? id;
};

/**
 * Every version of a target — current, history and its archived versions — numbered v1 = oldest
 * (creation time, then path), stable across swaps. ONE implementation for the director and the
 * client timeline (shared/comic/book.ts); re-exported here for this group's callers and tests.
 */
export { versionList, type VersionEntry };

/** Targets that have more than one version (pages by n, cover, sheets, places, style options). */
export function versionedTargets(doc: ComicDoc): { target: RenderTarget; count: number }[] {
  const out: { target: RenderTarget; count: number }[] = [];
  const consider = (target: RenderTarget) => {
    const n = versionList(doc, target).length;
    if (n >= 2) out.push({ target, count: n });
  };
  consider({ kind: 'cover' });
  for (const p of sortedPages(doc)) consider({ kind: 'page', id: p.id });
  for (const c of doc.cast) consider({ kind: 'sheet', id: c.id });
  for (const p of doc.places) consider({ kind: 'place', id: p.id });
  for (const o of doc.style.options) consider({ kind: 'style_option', id: o.id });
  return out;
}

/** Ready pages/cover whose art is not the book's page shape. */
export function offShape(doc: ComicDoc): { target: RenderTarget; got: string }[] {
  const want = doc.format.pageAspect;
  const out: { target: RenderTarget; got: string }[] = [];
  const check = (target: RenderTarget, asset?: AssetRef, ready?: boolean) => {
    if (!ready || !asset?.w || !asset?.h || aspectMatches(want, asset.w, asset.h)) return;
    out.push({ target, got: aspectFromSize(asset.w, asset.h) });
  };
  check({ kind: 'cover' }, doc.cover.render.asset, doc.cover.render.status === 'ready');
  for (const p of sortedPages(doc)) check({ kind: 'page', id: p.id }, p.render.asset, p.render.status === 'ready');
  return out;
}

/** "v3 current (4:5, Nano Banana Pro, $0.06, render, QC 0.82)" — only real recorded data. */
export function describeVersion(doc: ComicDoc, e: VersionEntry): string {
  const v = e.version as RenderVersion & ArchivedVersion;
  const bits: string[] = [];
  if (v.w && v.h) {
    const shape = aspectFromSize(v.w, v.h);
    bits.push(aspectMatches(doc.format.pageAspect, v.w, v.h) ? shape : `${shape} ⚠ not ${doc.format.pageAspect}`);
  }
  const model = modelName(v.model);
  if (model) bits.push(model);
  if (typeof v.costUsd === 'number') bits.push(v.costUsd > 0 ? formatUsd(v.costUsd) : 'free');
  if (v.origin) bits.push(v.origin === 'derived' ? 'fitted by software' : v.origin);
  if (v.note) bits.push(`“${clip(v.note, 60)}”`);
  if (typeof v.qc?.score === 'number') bits.push(`QC ${v.qc.score.toFixed(2)}`);
  if (e.archived) bits.push('archived');
  if (v.starred) bits.push('starred');
  if (!canServeToOwner(v)) bits.push('blocked by the content check');
  return `v${e.n}${e.current ? ' current' : ''}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

/** Drawn pages that are out of date now but were not before (a sheet/version swap would cause this). */
export function newlyStalePages(before: ComicDoc, after: ComicDoc): number[] {
  const out: number[] = [];
  for (const p of sortedPages(after)) {
    const prev = findPage(before, p.id);
    if (prev && !isPageStale(before, prev) && isPageStale(after, p)) out.push(p.n);
  }
  return out;
}

/** Book order with short beats: "1 Lake, 2 Frog…" (capped for the model). */
export const orderLine = (doc: ComicDoc, max = 12): string => {
  const pages = sortedPages(doc);
  const shown = pages.slice(0, max).map((p) => `${p.n}${p.summary ? ` ${clip(p.summary, 28)}` : ''}`);
  return `${shown.join(', ')}${pages.length > max ? `, … (${pages.length} pages)` : ''}`;
};

// ── Target resolution for the version tools ──────────────────────────────────

const TARGET_ENUM = ['page', 'cover', 'sheet', 'place', 'style_option'] as const;

const nameMatch = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const existingTargetsText = (doc: ComicDoc): string => {
  const parts = ['cover'];
  if (doc.pages.length) parts.push(pagesWord(doc.pages.map((p) => p.n)));
  if (doc.cast.length) parts.push(`sheets: ${doc.cast.map((c) => c.name.toUpperCase()).join(', ')}`);
  if (doc.places.length) parts.push(`places: ${doc.places.map((p) => p.name.toUpperCase()).join(', ')}`);
  return `Images in this comic: ${parts.join('; ')}.`;
};

/** target: 'page'|'cover'|'sheet'|'place'|'style_option' (+ page / name), or free text like "page 3", "sheet MAYA". */
export function resolveTarget(doc: ComicDoc, args: Record<string, unknown>): RenderTarget {
  const raw = typeof args.target === 'string' ? args.target.trim() : '';
  const lower = raw.toLowerCase();
  const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : '';
  const pageArg = typeof args.page === 'number' ? args.page : typeof args.page === 'string' && args.page.trim() ? Number(args.page) : undefined;

  const page = (n: number | undefined): RenderTarget => {
    if (n === undefined || !Number.isInteger(n)) throw toolArgError(`Say which page (page: n). ${existingTargetsText(doc)}`);
    const p = pageByNumber(doc, n);
    if (!p) throw toolArgError(`There is no page ${n}. ${existingTargetsText(doc)}`);
    return { kind: 'page', id: p.id };
  };
  const sheet = (who: string): RenderTarget | undefined => {
    const c = who ? resolveCharacter(doc, who) : undefined;
    return c ? { kind: 'sheet', id: c.id } : undefined;
  };
  const place = (where: string): RenderTarget | undefined => {
    const p = where ? doc.places.find((x) => x.id === where || nameMatch(x.name, where)) : undefined;
    return p ? { kind: 'place', id: p.id } : undefined;
  };
  const option = (what: string): RenderTarget | undefined => {
    const o = what ? doc.style.options.find((x) => x.id === what || nameMatch(x.name, what)) : undefined;
    return o ? { kind: 'style_option', id: o.id } : undefined;
  };

  if (lower === 'cover') return { kind: 'cover' };
  const pageText = /^page\s*#?\s*(\d+)$/.exec(lower);
  if (pageText) return page(Number(pageText[1]));
  if (lower === 'page') return page(pageArg);
  const kindText = /^(sheet|character|place|location|style(?:_option| option)?)\s*:?\s*(.*)$/.exec(raw);
  if (kindText) {
    const kind = kindText[1].toLowerCase();
    const who = kindText[2].trim() || name;
    const hit = kind === 'sheet' || kind === 'character' ? sheet(who) : kind === 'place' || kind === 'location' ? place(who) : option(who);
    if (hit) return hit;
    throw toolArgError(`I can't find ${who ? `“${who}”` : 'that'}. ${existingTargetsText(doc)}`);
  }
  if (!raw && pageArg !== undefined) return page(pageArg);
  const guess = sheet(raw || name) ?? place(raw || name) ?? option(raw || name);
  if (guess) return guess;
  throw toolArgError(`I can't tell which image “${raw || name}” is. ${existingTargetsText(doc)}`);
}

const pickVersion = (list: VersionEntry[], raw: unknown, history: RenderVersion[]): VersionEntry => {
  if (raw === 'original' || raw === 'first' || raw === 'oldest') return list[0];
  if (raw === 'previous' || raw === 'last') {
    const prevPath = history[0]?.path;
    const prev = (prevPath && list.find((e) => e.path === prevPath)) || [...list].reverse().find((e) => !e.current);
    if (!prev) throw toolArgError('There is no earlier version.');
    return prev;
  }
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^v?\d+$/i.test(raw.trim()) ? Number(raw.trim().replace(/^v/i, '')) : Number.NaN;
  if (!Number.isInteger(n)) throw toolArgError('version must be a number (v1 = oldest), "previous" or "original".');
  const hit = list.find((e) => e.n === n);
  if (!hit) throw toolArgError(`There is no v${n} — this image has v1–v${list.length}.`);
  return hit;
};

// ── Tools ────────────────────────────────────────────────────────────────────

/** Validate with the shared sanitizer (the UI's validator) and commit as a director edit. */
const commit = (ctx: StudioContext, ops: DocOp[], label: string): ComicDoc => {
  const clean = sanitizePatchOps(ctx.session.doc, ops, sanitizeCtxFor(ctx));
  return ctx.session.commit(clean, { origin: 'director', label });
};

const intArg = (v: unknown, what: string): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.trim()) : Number.NaN;
  if (!Number.isInteger(n)) throw toolArgError(`${what} must be a whole number.`);
  return n;
};

const pageArg = (doc: ComicDoc, v: unknown): Page => {
  const n = intArg(v, 'page');
  const p = pageByNumber(doc, n);
  if (!p) throw toolArgError(`There is no page ${n}. ${doc.pages.length ? `This book has ${pagesWord(doc.pages.map((x) => x.n))}.` : 'There are no pages yet.'}`);
  return p;
};

const continuityNote = (before: ComicDoc, after: ComicDoc): string => {
  const changed = sortedPages(after).filter((p) => continuityHint(after, p) && !continuityHint(before, findPage(before, p.id) ?? p));
  return changed.length
    ? ` ${capitalize(pagesWord(changed.map((p) => p.n)))} now ${changed.length === 1 ? 'has' : 'have'} different neighbours (art unchanged, nothing goes out of date). Offer “Redraw for continuity” only if the user asks.`
    : '';
};
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function movePageTool(ctx: StudioContext): DirectorTool {
  return defineTool(
    'move_page',
    'free',
    'Move a page to another position in the book (like dragging a clip in the timeline). Art, versions and lettering move with it; nothing is redrawn.',
    {
      type: 'object',
      properties: {
        page: { type: 'integer', minimum: 1, description: 'Current page number.' },
        to: { type: 'integer', minimum: 1, description: 'New page number.' }
      },
      required: ['page', 'to'],
      additionalProperties: false
    },
    (args) => {
      const before = ctx.session.doc;
      const page = pageArg(before, args.page);
      const pages = sortedPages(before);
      const to = Math.min(pages.length, Math.max(1, intArg(args.to, 'to')));
      if (to === page.n) return `Page ${page.n} is already at position ${to}. Order: ${orderLine(before)}.`;
      const order = reorderIds(
        pages.map((p) => p.id),
        pages.findIndex((p) => p.id === page.id),
        to - 1
      );
      const after = commit(ctx, [{ op: 'pages_reorder', order }], `Move page ${page.n}`);
      return `Moved page ${page.n} to ${to} ($0). Order now: ${orderLine(after)}.${continuityNote(before, after)}`;
    }
  );
}

function insertPageTool(ctx: StudioContext, turn: DirectorTurn): DirectorTool {
  return defineTool(
    'insert_page',
    'free',
    `Add a page. after = the page number it follows (0 = before page 1). Blank pages are free; write:true also has the writer plan its panels (TEXT ≈${formatUsd(PLAN_USD_PER_PAGE)}) from summary. Pages are drawn later with render_pages.`,
    {
      type: 'object',
      properties: {
        after: { type: 'integer', minimum: 0, description: 'Insert after this page number (0 = at the start).' },
        summary: { type: 'string', description: 'What happens on the new page (one or two sentences).' },
        write: { type: 'boolean', description: 'true = the writer plans its panels now (TEXT cost). Only when the user wants the page written.' }
      },
      required: ['after'],
      additionalProperties: false
    },
    async (args) => {
      const doc = ctx.session.doc;
      const after = Math.min(doc.pages.length, Math.max(0, intArg(args.after, 'after')));
      const summary = typeof args.summary === 'string' ? args.summary.trim().slice(0, 1000) : '';
      const write = args.write === true;
      if (write) {
        if (turn.paidText >= MAX_PAID_TEXT_PER_TURN) throw toolArgError('Already ran the writer twice this turn — add the page blank and ask before writing it.');
        const budget = doc.settings.budgetUsd;
        if (typeof budget === 'number' && budget > 0 && doc.spend.totalUsd >= budget) throw toolArgError('The comic is at its budget cap — add the page blank, or ask the user to raise the budget in Settings.');
      }
      const id = newId('pg');
      const committed = commit(ctx, [{ op: 'page_insert', id, after, ...(summary ? { patch: { summary } } : {}) }], 'Add a page');
      const n = findPage(committed, id)?.n ?? after + 1;
      if (!write) {
        return priced(
          ctx,
          `Added a blank page ${n} after ${after === 0 ? 'the cover' : `page ${after}`} ($0). Order: ${orderLine(committed)}. It has no panels yet — when the user says what happens, write it with revise_pages (TEXT ≈${formatUsd(PLAN_USD_PER_PAGE)}), or they can type it in the Pages tab.`
        );
      }
      turn.paidText += 1;
      const prevBeat = sortedPages(committed).find((p) => p.n === n - 1)?.summary;
      const nextBeat = sortedPages(committed).find((p) => p.n === n + 1)?.summary;
      const instructions =
        summary ||
        `Write new page ${n} so it bridges ${prevBeat ? `“${clip(prevBeat, 160)}”` : 'the opening'} and ${nextBeat ? `“${clip(nextBeat, 160)}”` : 'the ending'}.`;
      let outcome: Awaited<ReturnType<typeof planPages>>;
      try {
        outcome = await planPages(ctx, { instructions, pageIds: [id] }, { collectCard: (c) => turn.cards.push(c), origin: 'director' });
      } catch (err) {
        // The blank page is already in the book: say so, never a bare error the model reads as "nothing happened".
        const why = toolErrorText(err).replace(/^Error:\s*/, '').replace(/[.!]+$/, '');
        return `Added a blank page ${n} ($0), but the writer couldn't write it: ${why}. The page is in the book and empty — offer to try again or let the user type it in the Pages tab.`;
      }
      turn.plannedThisTurn = true;
      if (outcome.status !== 'done') return `Added a blank page ${n} ($0); writing it didn't finish: ${outcome.message}`;
      return `Added page ${n} and wrote it: ${outcome.message} Draw it later with render_pages (only when the user asks).`;
    }
  );
}

function duplicatePageTool(ctx: StudioContext): DirectorTool {
  return defineTool(
    'duplicate_page',
    'free',
    'Duplicate a page right after itself — same panels, lines, balloons and current art (nothing redrawn). Use for "copy page 2" or as a starting point for a variation.',
    {
      type: 'object',
      properties: { page: { type: 'integer', minimum: 1, description: 'Page number to copy.' } },
      required: ['page'],
      additionalProperties: false
    },
    (args) => {
      const doc = ctx.session.doc;
      const page = pageArg(doc, args.page);
      const newPageId = newId('pg');
      const after = commit(ctx, [{ op: 'page_duplicate', id: page.id, newId: newPageId }], `Duplicate page ${page.n}`);
      const copy = findPage(after, newPageId);
      return `Copied page ${page.n} to page ${copy?.n ?? page.n + 1} ($0)${page.render.asset ? ' with its current art' : ''}. Order: ${orderLine(after)}.`;
    }
  );
}

function deletePageTool(ctx: StudioContext): DirectorTool {
  return defineTool(
    'delete_page',
    'free',
    'Delete a page. It is kept in Media → Deleted with its art and versions; restore_page (or the user saying "undo") brings it back. Never use it on a page that is drawing.',
    {
      type: 'object',
      properties: { page: { type: 'integer', minimum: 1, description: 'Page number to delete.' } },
      required: ['page'],
      additionalProperties: false
    },
    (args) => {
      const doc = ctx.session.doc;
      const page = pageArg(doc, args.page);
      if (isBusyPage(page)) throw toolArgError(`Page ${page.n} is still drawing — delete it when it's done (its paid image would be lost otherwise).`);
      if (doc.pages.length <= 1) throw toolArgError('That is the only page. Add another page first, or change the plan with revise_pages.');
      const after = commit(ctx, [{ op: 'page_delete', id: page.id, deletedAt: Date.now() }], `Delete page ${page.n}`);
      return `Deleted page ${page.n} ($0). It's in Media → Deleted — say “undo” or ask me to restore it. Pages renumbered: ${orderLine(after)}.${continuityNote(doc, after)}`;
    }
  );
}

function restorePageTool(ctx: StudioContext): DirectorTool {
  return defineTool(
    'restore_page',
    'free',
    'Bring a deleted page back from Media → Deleted, at its old position. page = the number it had when deleted; omit for the most recently deleted page.',
    {
      type: 'object',
      properties: {
        page: { type: 'integer', minimum: 1, description: 'The page number it had when it was deleted.' },
        latest: { type: 'boolean', description: 'Restore the most recently deleted page.' }
      },
      additionalProperties: false
    },
    (args) => {
      const doc = ctx.session.doc;
      const trash = trashOf(doc);
      if (!trash.length) return 'Nothing is in Deleted, so there is no page to restore.';
      let entry = trash[0];
      if (args.page !== undefined && args.latest !== true) {
        const n = intArg(args.page, 'page');
        const hit = trash.find((t) => t.fromN === n);
        if (!hit) return `No deleted page was page ${n}. Deleted: ${trash.map((t) => `former page ${t.fromN}${t.page.summary ? ` (${clip(t.page.summary, 40)})` : ''}`).join('; ')}.`;
        entry = hit;
      }
      const after = commit(ctx, [{ op: 'page_restore', id: entry.page.id }], 'Restore a page');
      const back = findPage(after, entry.page.id);
      return `Restored the deleted page as page ${back?.n ?? entry.fromN} ($0), with its art and versions. Order: ${orderLine(after)}.`;
    }
  );
}

const versionsCard = (target: RenderTarget): Extract<Card, { type: 'versions' }> => ({ type: 'versions', id: newId('card'), target });

const TARGET_PROPS = {
  target: { type: 'string', description: 'Which image: "cover", "page" (with page), "sheet" or "place" (with name), or free text like "page 3" / "sheet MAYA".' },
  page: { type: 'integer', minimum: 1, description: 'Page number when target is "page".' },
  name: { type: 'string', description: 'Character or place name when target is "sheet" / "place".' }
} as const;

function listVersionsTool(ctx: StudioContext, turn: DirectorTurn): DirectorTool {
  return defineTool(
    'list_versions',
    'free',
    'List every saved version of an image (page, cover, character sheet, place) with real recorded data — shape, model, cost, QC — and show them to the user as a version card they can tap. Check this BEFORE suggesting any redraw: picking a version is free.',
    { type: 'object', properties: { ...TARGET_PROPS }, required: ['target'], additionalProperties: false },
    (args) => {
      const doc = ctx.session.doc;
      const target = resolveTarget(doc, args);
      const list = versionList(doc, target);
      const label = targetLabel(doc, target);
      if (!list.length) return `${label} isn't drawn yet, so it has no versions.`;
      if (!turn.cards.some((c) => c.type === 'versions' && renderTargetKey(c.target) === renderTargetKey(target))) turn.cards.push(versionsCard(target));
      const shown = [...list].reverse().slice(0, 10);
      const more = list.length > shown.length ? `; … ${list.length - shown.length} older` : '';
      const stale = isTargetStale(doc, target) ? ' The current version is out of date with the script.' : '';
      return priced(
        ctx,
        `${label} — ${plural(list.length, 'version')}: ${shown.map((e) => describeVersion(doc, e)).join('; ')}${more}.${stale} The version card is visible to the user; switching with use_version is free and instant.`
      );
    }
  );
}

function useVersionTool(ctx: StudioContext): DirectorTool {
  return defineTool(
    'use_version',
    'free',
    'Switch an image to one of its saved versions (free, instant, undoable). version: number from list_versions (v1 = oldest), "previous" or "original". A character-sheet version that would make drawn pages out of date needs confirm:true after the user agrees (the first call says which pages).',
    {
      type: 'object',
      properties: {
        ...TARGET_PROPS,
        version: { type: 'string', description: 'The v-number from list_versions ("1" = oldest, "3", "v3"), or "previous" / "original".' },
        confirm: { type: 'boolean', description: 'true only after the user agreed to the listed out-of-date pages.' }
      },
      required: ['target', 'version'],
      additionalProperties: false
    },
    (args) => {
      const doc = ctx.session.doc;
      const target = resolveTarget(doc, args);
      const r = getRender(doc, target);
      const label = targetLabel(doc, target);
      if (!r) throw toolArgError(`${label} no longer exists.`);
      const list = versionList(doc, target);
      if (list.length < 2) {
        const kind = target.kind === 'cover' ? 'cover' : target.kind === 'page' ? 'page' : 'sheet';
        const price = unitPrice(doc, kind, { byok: spendIsByok(ctx.keys) }).usd;
        return priced(ctx, `${label} has ${list.length ? 'only one version' : 'no drawing yet'} — nothing to switch to. A new take is ≈${formatUsd(price)}, only if the user asks for one.`);
      }
      if (r.status === 'queued' || r.status === 'rendering') throw toolArgError(`${label} is still drawing — switch versions when it's done.`);
      const pick = pickVersion(list, args.version, r.history);
      if (pick.current) return `v${pick.n} is already the current version of ${label} ($0).`;
      if (!canServeToOwner(pick.version)) throw toolArgError(`v${pick.n} didn't pass the content check, so it can't be used.`);
      const op: DocOp = { op: 'render_use', target, path: pick.path, at: Date.now() };
      const simulated = applyOp(doc, op);
      const stalePages = newlyStalePages(doc, simulated);
      const coverStale = !isTargetStale(doc, { kind: 'cover' }) && isTargetStale(simulated, { kind: 'cover' }) && target.kind !== 'cover';
      if ((target.kind === 'sheet' || target.kind === 'place') && (stalePages.length || coverStale) && args.confirm !== true) {
        const byok = spendIsByok(ctx.keys);
        const cost = unitPrice(doc, 'page', { byok }).usd * stalePages.length + (coverStale ? unitPrice(doc, 'cover', { byok }).usd : 0);
        const what = [stalePages.length ? pagesWord(stalePages) : '', coverStale ? 'the cover' : ''].filter(Boolean).join(' and ');
        return priced(
          ctx,
          `Not switched yet: using v${pick.n} of ${label} would mark ${what} out of date (they were drawn from the current version; redrawing them later ≈${formatUsd(cost)}). Ask the user; if they agree, call use_version again with confirm:true. Their art stays as it is either way.`
        );
      }
      const after = commit(ctx, [op], `Use ${label} v${pick.n}`);
      const notes: string[] = [];
      const v = pick.version;
      if ((target.kind === 'page' || target.kind === 'cover') && v.w && v.h && !aspectMatches(after.format.pageAspect, v.w, v.h)) {
        notes.push(`It's ${aspectFromSize(v.w, v.h)}, not ${after.format.pageAspect} — fit_render fixes the shape for free.`);
      }
      if (isTargetStale(after, target)) notes.push('It was drawn before the latest script/style changes, so it shows as out of date.');
      const nowStale = newlyStalePages(doc, after);
      if (nowStale.length) notes.push(`${capitalize(pagesWord(nowStale))} now ${nowStale.length === 1 ? 'shows' : 'show'} as out of date.`);
      return `${label} now uses v${pick.n} ($0, free and undoable).${notes.length ? ` ${notes.join(' ')}` : ''}`;
    }
  );
}

function setBookTool(ctx: StudioContext): DirectorTool {
  return defineTool(
    'set_book',
    'free',
    'Turn the book extras on or off: a title page, a "The End" page with credits, and a back cover with a blurb. All are laid out by software ($0) and appear in the reader, the timeline and exports.',
    {
      type: 'object',
      properties: {
        titlePage: { type: 'boolean' },
        endPage: { type: 'boolean', description: '"The End" + credits page.' },
        backCover: { type: 'string', enum: ['none', 'auto'] },
        blurb: { type: 'string', description: `Back-cover blurb (≤ ${DOC_LIMITS.bookBlurbChars} chars; default: the logline).` },
        credits: { type: 'array', items: { type: 'string' }, description: `Credit lines for the end page (≤ ${DOC_LIMITS.bookCredits}).` }
      },
      additionalProperties: false
    },
    (args) => {
      const patch: Partial<BookSettings> = {};
      if (typeof args.titlePage === 'boolean') patch.titlePage = args.titlePage;
      if (typeof args.endPage === 'boolean') patch.endPage = args.endPage;
      if (args.backCover === 'none' || args.backCover === 'auto') patch.backCover = args.backCover;
      if (typeof args.blurb === 'string') patch.blurb = args.blurb.slice(0, DOC_LIMITS.bookBlurbChars);
      if (Array.isArray(args.credits)) {
        patch.credits = args.credits
          .filter((c): c is string => typeof c === 'string' && !!c.trim())
          .slice(0, DOC_LIMITS.bookCredits)
          .map((c) => c.slice(0, DOC_LIMITS.bookCreditChars));
      }
      if (!Object.keys(patch).length) throw toolArgError('Pass at least one of titlePage, endPage, backCover, blurb, credits.');
      const after = commit(ctx, [{ op: 'book', patch }], 'Change book pages');
      return `Book extras: ${bookLine(bookOf(after))} — all free, made by software.`;
    }
  );
}

const bookLine = (b: BookSettings): string =>
  `title page ${b.titlePage ? 'on' : 'off'}, “The End” ${b.endPage ? 'on' : 'off'}, back cover ${b.backCover === 'auto' ? 'on' : 'off'}`;

function fitRenderTool(ctx: StudioContext, turn: DirectorTurn): DirectorTool {
  return defineTool(
    'fit_render',
    'free',
    "Fix a drawn page or cover that came back at the wrong shape (e.g. square instead of 4:5) by padding its edges or trimming ≤ 8% — software, $0, the original stays as a version. Use this instead of a redraw for shape problems.",
    {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['page', 'cover'] },
        page: { type: 'integer', minimum: 1, description: 'Page number when target is "page".' },
        mode: { type: 'string', enum: ['auto', 'pad', 'crop'], description: 'auto (default): trim when ≤ 8% would go, else pad.' }
      },
      required: ['target'],
      additionalProperties: false
    },
    async (args) => {
      const doc = ctx.session.doc;
      const target: RenderTarget = args.target === 'cover' ? { kind: 'cover' } : { kind: 'page', id: pageArg(doc, args.page).id };
      const mode = args.mode === 'pad' || args.mode === 'crop' ? args.mode : 'auto';
      const started = await runFitRender(ctx, { type: 'fit_render', target, mode }, {
        confirmed: false,
        collectCard: (c) => turn.cards.push(c),
        collectNextSteps: (steps) => pushNextSteps(turn, steps),
        caps: ctx.caps,
        origin: 'director'
      });
      return started.outcome.message;
    }
  );
}

// ── The group ────────────────────────────────────────────────────────────────

const hasVersions = (doc: ComicDoc) => versionedTargets(doc).length > 0;

export const timelineToolGroup: ToolGroup = {
  id: 'timeline',
  priority: 30,
  when: (ctx) => {
    const doc = ctx.session.doc;
    return doc.pages.length > 0 || trashOf(doc).length > 0 || hasVersions(doc);
  },
  tools: (ctx, turn) => {
    const doc = ctx.session.doc;
    const tools: DirectorTool[] = [];
    if (doc.pages.length) {
      if (doc.pages.length > 1) tools.push(movePageTool(ctx));
      tools.push(insertPageTool(ctx, turn), duplicatePageTool(ctx), deletePageTool(ctx));
    }
    if (trashOf(doc).length) tools.push(restorePageTool(ctx));
    if (hasVersions(doc)) tools.push(listVersionsTool(ctx, turn), useVersionTool(ctx));
    if (doc.pages.length) tools.push(setBookTool(ctx));
    if (offShape(doc).length) tools.push(fitRenderTool(ctx, turn));
    return tools;
  },
  promptRules: (doc) => {
    const rules = [
      'TIMELINE: page moves, inserts, copies and deletes are free (move_page, insert_page, duplicate_page, delete_page); a deleted page waits in Media → Deleted (restore_page). Title page, “The End” and back cover are free software pages (set_book).'
    ];
    if (hasVersions(doc)) rules.push('Before redrawing anything, check its versions (list_versions): picking an earlier version is free and instant (use_version, v1 = oldest). A redraw is only for a new take the user asked for.');
    if (offShape(doc).length) rules.push('A page or cover at the wrong shape is fixed free with fit_render — never redraw just for the shape unless the user asks.');
    return rules.join(' ');
  },
  summaryLines: (doc) => {
    const lines: string[] = [];
    const versioned = versionedTargets(doc);
    if (versioned.length) {
      const shown = versioned.slice(0, 8).map(({ target, count }) => {
        const list = versionList(doc, target);
        const cur = list.find((e) => e.current);
        const qc = typeof (cur?.version as RenderVersion | undefined)?.qc?.score === 'number' ? `, QC ${(cur!.version as RenderVersion).qc!.score.toFixed(2)}` : '';
        const name = target.kind === 'page' ? `p${findPage(doc, target.id)?.n ?? '?'}` : targetLabel(doc, target);
        return `${name} ${count} versions (v${cur?.n ?? '?'} current${qc})`;
      });
      lines.push(`Versions: ${shown.join('; ')}${versioned.length > 8 ? `; +${versioned.length - 8} more` : ''} — switching is free.`);
    }
    const shape = offShape(doc);
    if (shape.length) {
      const names = shape.map(({ target, got }) => `${target.kind === 'cover' ? 'cover' : `p${findPage(doc, (target as { id: string }).id)?.n ?? '?'}`} (${got})`);
      lines.push(`Wrong shape for ${doc.format.pageAspect}: ${names.join(', ')} — fit_render fixes it free.`);
    }
    if (doc.pages.some((p) => p.render.status === 'ready')) lines.push(`Book extras: ${bookLine(bookOf(doc))}.`);
    const trash = trashOf(doc);
    if (trash.length) lines.push(`Deleted pages: ${trash.length} (Media → Deleted; restore_page brings one back).`);
    const archive = archiveOf(doc).length;
    if (archive) lines.push(`Version archive: ${archive}/${MAX_ARCHIVE}.`);
    return lines;
  },
  activity: {
    move_page: 'Moving the page',
    insert_page: 'Adding a page',
    duplicate_page: 'Copying the page',
    delete_page: 'Deleting the page',
    restore_page: 'Restoring the page',
    list_versions: 'Looking at the versions',
    use_version: 'Switching versions',
    set_book: 'Setting up the book pages',
    fit_render: 'Fitting the page shape'
  }
};

export { TARGET_ENUM };
