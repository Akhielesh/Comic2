// Director tool group "breakdown" (contract §12.1/§12.2; softwarefirst.md §2.5). Owner: P1-BOOKMODEL.
//
//   show_pages  FREE  posts a live `breakdown` card (cover + every page wireframe, panel counts, cost)
//   quote       FREE  prices an action from the model registry without starting anything
//
// Both are pure reads of the doc: no ops, no spend, no model calls. Results are honest sentences
// for the director — when nothing matched they list what exists. Every number comes from the
// shared plan core (shared/comic/plan.ts) or the server's own gate estimate (jobs.ts), so the
// quote the user hears is the quote the gate will show.

import { newId, type Card, type ComicDoc, type Page } from '../../../../shared/comic/doc.js';
import { formatUsd } from '../../../../shared/comic/models.js';
import { LANGUAGES, languageSpec } from '../../../../shared/comic/languages.js';
import { coverNeedsDraw, pageTargets, quoteRenderPages, sheetTargets, summarizeBook, unitPrice, type BookSummary } from '../../../../shared/comic/plan.js';
import { defineTool, toolArgError, type DirectorTool, type ToolGroup } from '../extensions.js';
import { estimateSpendAction, spendIsByok } from '../jobs.js';
import { estimateTranslation } from '../i18n/index.js';
import type { DirectorTurn } from '../tools.js';
import { StudioError, type StudioContext } from '../types.js';

export type BreakdownView = 'plan' | 'status' | 'cost';
export const BREAKDOWN_VIEWS: readonly BreakdownView[] = ['plan', 'status', 'cost'];
/** At most this many page ids ride on one card (a 40-page free plan fits with room to spare). */
export const MAX_BREAKDOWN_PAGE_IDS = 200;

const isBusy = (p: Page) => p.render.status === 'queued' || p.render.status === 'rendering';
const sortedPages = (doc: ComicDoc) => [...doc.pages].sort((a, b) => a.n - b.n);
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** "1–3, 5, 7–8" for page numbers. */
export const pageRanges = (ns: number[]): string => {
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
const pagesLabel = (ns: number[]) => `${ns.length === 1 ? 'page' : 'pages'} ${pageRanges(ns)}`;

/** Default facet: the layout before anything is drawn, the art afterwards. */
export const defaultBreakdownView = (doc: ComicDoc): BreakdownView =>
  doc.pages.some((p) => p.render.status === 'ready' && !!p.render.asset) ? 'status' : 'plan';

/** The cover tile leads when the book has more than one page or the cover exists (softwarefirst §2.3). */
export const defaultBreakdownCover = (doc: ComicDoc): boolean => doc.pages.length > 1 || doc.cover.render.status !== 'none';

/**
 * Resolve page NUMBERS from a tool argument (ints, numeric strings, or one number). Unknown numbers
 * are reported, never guessed. `undefined` ⇒ the whole book.
 */
export function resolvePageNumbers(doc: ComicDoc, raw: unknown): { pages?: Page[]; unknown: number[] } {
  if (raw === undefined || raw === null || (Array.isArray(raw) && !raw.length)) return { unknown: [] };
  const list = Array.isArray(raw) ? raw : [raw];
  const nums: number[] = [];
  for (const v of list.slice(0, MAX_BREAKDOWN_PAGE_IDS)) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.trim()) : Number.NaN;
    if (!Number.isFinite(n) || n < 1 || Math.round(n) !== n) throw toolArgError('pages must be page numbers like [1, 2].');
    nums.push(n);
  }
  const byN = new Map(doc.pages.map((p) => [p.n, p] as const));
  const pages: Page[] = [];
  const unknown: number[] = [];
  for (const n of [...new Set(nums)]) {
    const p = byN.get(n);
    if (p) pages.push(p);
    else unknown.push(n);
  }
  return { pages: pages.sort((a, b) => a.n - b.n), unknown };
}

/** Page ids from a client action: strings that name existing pages, deduped, capped. */
export function sanitizeBreakdownPageIds(doc: ComicDoc, raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const known = new Set(doc.pages.map((p) => p.id));
  const out: string[] = [];
  for (const v of raw.slice(0, MAX_BREAKDOWN_PAGE_IDS)) if (typeof v === 'string' && known.has(v) && !out.includes(v)) out.push(v);
  return out;
}

/** The breakdown card for a doc (live: the client re-reads the doc; the payload only scopes it). */
export function breakdownCardFor(doc: ComicDoc, opts: { pageIds?: string[]; view?: BreakdownView; gateId?: string } = {}): Extract<Card, { type: 'breakdown' }> {
  const subset = opts.pageIds?.length && opts.pageIds.length < doc.pages.length ? opts.pageIds : undefined;
  return {
    type: 'breakdown',
    id: newId('card'),
    ...(subset ? { pageIds: subset } : {}),
    cover: subset ? false : defaultBreakdownCover(doc),
    view: opts.view ?? defaultBreakdownView(doc),
    ...(opts.gateId ? { gateId: opts.gateId } : {})
  };
}

/** Best guess at who pays for images when no request keys are at hand (the latest image spend says so). */
export const byokFromLedger = (doc: ComicDoc): boolean =>
  doc.spend.entries.find((e) => e.kind === 'page' || e.kind === 'sheet' || e.kind === 'cover' || e.kind === 'edit' || e.kind === 'style')?.byok ?? false;

/**
 * Compact text for the director (softwarefirst §2.5):
 * "1 page · 4 panels · cast: THE BABY, DUCKLINGS (no reference yet) · page 1 drawn ($0.06) · cover drawn ($0.09). Not drawn: nothing."
 */
export function breakdownText(doc: ComicDoc, summary: BookSummary, opts: { subset: boolean; byok: boolean }): string {
  const pages = summary.pages;
  const panelCount = pages.reduce((n, p) => n + p.panels.length, 0);
  const parts: string[] = [`${plural(pages.length, 'page')} · ${plural(panelCount, 'panel')}`];
  if (opts.subset) parts[0] += ` (of ${plural(doc.pages.length, 'page')})`;

  const castIds = [...new Set(pages.flatMap((p) => p.castIds))];
  const noRef = new Set(pages.flatMap((p) => p.missingRefCastIds));
  if (castIds.length) {
    const names = castIds
      .map((id) => doc.cast.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c) => `${c.name.toUpperCase()}${noRef.has(c.id) ? ' (no reference yet)' : ''}`);
    if (names.length) parts.push(`cast: ${names.join(', ')}`);
  }

  const drawn = pages.filter((p) => p.status === 'ready' || p.status === 'custom');
  if (drawn.length) {
    const spent = drawn.reduce((n, p) => n + (p.spentUsd ?? p.costUsd ?? 0), 0);
    parts.push(`${pagesLabel(drawn.map((p) => p.n))} drawn${spent > 0 ? ` (${formatUsd(spent)})` : ''}`);
  }
  if (!opts.subset) {
    const c = summary.cover;
    if (c.status === 'ready' || c.status === 'custom') parts.push(`cover drawn${c.spentUsd ? ` (${formatUsd(c.spentUsd)})` : ''}`);
    else if (c.status === 'queued' || c.status === 'rendering') parts.push('cover drawing now');
    else parts.push(`cover not drawn (≈${formatUsd(c.quoteUsd ?? summary.pricing?.coverUsd ?? 0)})`);
  }
  let text = `${parts.join(' · ')}.`;

  const busy = pages.filter((p) => p.status === 'queued' || p.status === 'rendering');
  if (busy.length) text += ` Drawing now: ${pagesLabel(busy.map((p) => p.n))}.`;
  const stale = pages.filter((p) => p.status === 'stale');
  if (stale.length) text += ` Out of date (script changed since drawing): ${pagesLabel(stale.map((p) => p.n))}.`;
  const failed = pages.filter((p) => p.status === 'failed');
  if (failed.length) text += ` Failed: ${pagesLabel(failed.map((p) => p.n))}.`;
  const offAspect = pages.filter((p) => p.aspectOk === false);
  if (offAspect.length) text += ` Wrong shape for ${doc.format.pageAspect}: ${pagesLabel(offAspect.map((p) => p.n))} (fit_render fixes it free).`;

  const quote = quoteRenderPages(doc, {
    ...(opts.subset ? { pageIds: pages.map((p) => p.id) } : {}),
    byok: opts.byok,
    tier: doc.settings.quality,
    modelOverride: doc.settings.imageModelOverride
  });
  if (quote.nothing) text += ' Not drawn: nothing — every page here is drawn and current ($0 to draw).';
  else {
    const ns = quote.pageIds.map((id) => doc.pages.find((p) => p.id === id)?.n ?? 0).filter((n) => n > 0);
    const sheets = quote.sheetIds.length ? ` incl. ${plural(quote.sheetIds.length, 'character sheet')}` : '';
    text += ` Not drawn: ${pagesLabel(ns)} (≈${formatUsd(quote.usd)}${sheets}, ${quote.model}).`;
  }
  if (!pages.length) text = 'No pages to show.';
  return text;
}

const VIEW_ENUM = [...BREAKDOWN_VIEWS];
const QUOTE_ACTIONS = ['render_pages', 'render_cover', 'render_sheets', 'edit_page', 'translate'] as const;
type QuoteAction = (typeof QUOTE_ACTIONS)[number];

const existingPagesText = (doc: ComicDoc) =>
  doc.pages.length ? `This book has ${pagesLabel(doc.pages.map((p) => p.n))}.` : 'This book has no pages yet.';

function showPagesTool(ctx: StudioContext, turn: DirectorTurn): DirectorTool {
  return defineTool(
    'show_pages',
    'free',
    "Show the user a visual breakdown of the book in the chat: the cover first, then every page's panel layout (wireframe or art), panel counts, cast, dialogue counts, status and cost. Use it whenever the user asks to see the pages, the plan, the breakdown, what is drawn or what is left — instead of typing the plan out. Optional `pages` (page numbers) shows a subset; `view` leads with the layout (plan), the art (status) or the money (cost).",
    {
      type: 'object',
      properties: {
        pages: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Page numbers to show (omit = the whole book).' },
        view: { type: 'string', enum: VIEW_ENUM, description: "plan = panel layouts, status = drawn art, cost = what was spent and what's left. Default: plan before any page is drawn, status after." }
      },
      additionalProperties: false
    },
    (args) => {
      const doc = ctx.session.doc;
      if (!doc.pages.length) return 'There are no pages yet, so there is nothing to show. Plan the pages first (plan_pages), then show them.';
      const { pages, unknown } = resolvePageNumbers(doc, args.pages);
      if (pages && !pages.length) return `There is no ${pagesLabel(unknown)}. ${existingPagesText(doc)} Nothing was shown.`;
      const view = typeof args.view === 'string' && (BREAKDOWN_VIEWS as readonly string[]).includes(args.view) ? (args.view as BreakdownView) : undefined;
      const card = breakdownCardFor(doc, { pageIds: pages?.map((p) => p.id), view });
      // One breakdown card per message: a second call this turn re-scopes the first instead of stacking.
      const idx = turn.cards.findIndex((c) => c.type === 'breakdown' && !c.gateId);
      if (idx >= 0) turn.cards[idx] = { ...card, id: turn.cards[idx].id };
      else turn.cards.push(card);
      const byok = spendIsByok(ctx.keys);
      const summary = summarizeBook(doc, { pageIds: card.pageIds, byok });
      const missing = unknown.length ? ` (There is no ${pagesLabel(unknown)}; ${existingPagesText(doc)})` : '';
      return `Showed the breakdown card (${card.view} view). ${breakdownText(doc, summary, { subset: !!card.pageIds, byok })}${missing} The card is visible to the user — refer to it briefly instead of repeating it.`;
    }
  );
}

const languageList = (raw: unknown): { codes: string[]; unknown: string[] } => {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;]/) : [];
  const codes: string[] = [];
  const unknown: string[] = [];
  for (const v of list.slice(0, 12)) {
    if (typeof v !== 'string' || !v.trim()) continue;
    const name = v.trim().slice(0, 40);
    const spec = languageSpec(name) ?? LANGUAGES.find((l) => l.english.toLowerCase() === name.toLowerCase() || l.endonym === name);
    if (spec) {
      if (!codes.includes(spec.code)) codes.push(spec.code);
    } else unknown.push(name);
  }
  return { codes, unknown };
};

const languageName = (code: string) => languageSpec(code)?.english ?? code;

async function quoteText(ctx: StudioContext, args: Record<string, unknown>): Promise<string> {
  const doc = ctx.session.doc;
  const action = args.action as QuoteAction;
  if (!(QUOTE_ACTIONS as readonly string[]).includes(action)) throw toolArgError(`action must be one of ${QUOTE_ACTIONS.join(', ')}.`);
  const byok = spendIsByok(ctx.keys);
  const tier = doc.settings.quality;
  const override = doc.settings.imageModelOverride;
  const who = byok ? ' Billed to the user’s own key.' : '';
  const tail = ` Quote only — nothing was started.${who}`;

  switch (action) {
    case 'render_pages': {
      if (!doc.pages.length) return `There are no pages to draw yet — plan them first.${tail}`;
      const { pages, unknown } = resolvePageNumbers(doc, args.pages);
      if (pages && !pages.length) return `There is no ${pagesLabel(unknown)}. ${existingPagesText(doc)}${tail}`;
      const scope = pages ?? sortedPages(doc);
      const q = quoteRenderPages(doc, { pageIds: pages?.map((p) => p.id), includeCover: args.include_cover === true, byok, tier, modelOverride: override });
      const fresh = scope.filter((p) => !q.pageIds.includes(p.id) && p.render.status === 'ready' && p.panels.length && !isBusy(p));
      const busy = scope.filter(isBusy);
      const empty = scope.filter((p) => !p.panels.length);
      const notes: string[] = [];
      if (fresh.length) notes.push(`Already drawn and current (not counted): ${pagesLabel(fresh.map((p) => p.n))}.`);
      if (busy.length) notes.push(`Drawing now (not counted): ${pagesLabel(busy.map((p) => p.n))}.`);
      if (empty.length) notes.push(`No panels yet (not counted): ${pagesLabel(empty.map((p) => p.n))}.`);
      if (unknown.length) notes.push(`There is no ${pagesLabel(unknown)}.`);
      if (q.nothing) {
        const redraw = fresh.length ? unitPrice(doc, 'page', { byok, tier, modelOverride: override }).usd : 0;
        const take = fresh.length
          ? ` A new take is only for when the user asks for another version: ≈${formatUsd(redraw)} a page (${plural(fresh.length, 'page')} ≈${formatUsd(redraw * fresh.length)}).`
          : '';
        return `$0 — nothing would be drawn.${notes.length ? ` ${notes.join(' ')}` : ''}${take}${tail}`;
      }
      const ns = q.pageIds.map((id) => doc.pages.find((p) => p.id === id)?.n ?? 0).filter((n) => n > 0);
      const bits = [q.pageIds.length ? plural(q.pageIds.length, 'page') : '', q.sheetIds.length ? plural(q.sheetIds.length, 'character sheet') : '', q.cover ? 'the cover' : '']
        .filter(Boolean)
        .join(' + ');
      const lines = q.lines.map((l) => `${l.label} ${l.count} = ${formatUsd(l.usd)}`).join('; ');
      return `≈${formatUsd(q.usd)} to draw ${bits}${ns.length ? ` (${pagesLabel(ns)})` : ''} on ${q.model} [${lines}].${notes.length ? ` ${notes.join(' ')}` : ''}${tail}`;
    }
    case 'render_cover': {
      const r = doc.cover.render;
      const est = estimateSpendAction(doc, { type: 'render_cover' }, byok);
      if (r.status === 'queued' || r.status === 'rendering') return `The cover is being drawn right now; another one would be ≈${formatUsd(est.usd)}.${tail}`;
      if (!coverNeedsDraw(doc)) return `The cover is already drawn and current ($0). A new cover would be ≈${formatUsd(est.usd)} on ${est.model} — only if the user asks for one.${tail}`;
      return `≈${formatUsd(est.usd)} for the cover on ${est.model}.${tail}`;
    }
    case 'render_sheets': {
      const wanted = sheetTargets(doc);
      const est = estimateSpendAction(doc, { type: 'render_sheets' }, byok);
      if (!wanted.length || est.usd <= 0) {
        const ready = doc.cast.filter((c) => c.tier !== 'extra' && c.sheet.status === 'ready').map((c) => c.name.toUpperCase());
        return `$0 — every lead and support character already has a sheet${ready.length ? ` (${ready.join(', ')})` : ''}.${tail}`;
      }
      return `≈${formatUsd(est.usd)} for ${plural(wanted.length, 'character sheet')} (${wanted.map((c) => c.name.toUpperCase()).join(', ')}) on ${est.model}.${tail}`;
    }
    case 'edit_page': {
      const { pages, unknown } = resolvePageNumbers(doc, args.pages);
      if (!pages || !pages.length) {
        return unknown.length ? `There is no ${pagesLabel(unknown)}. ${existingPagesText(doc)}${tail}` : `Say which page to edit (pages: [n]). ${existingPagesText(doc)}${tail}`;
      }
      const page = pages[0];
      if (page.render.status !== 'ready' || !page.render.asset) {
        const draw = quoteRenderPages(doc, { pageIds: [page.id], byok, tier, modelOverride: override });
        return `Page ${page.n} isn't drawn yet, so there is nothing to edit. Drawing it is ${draw.nothing ? '$0 right now (it is busy or has no panels)' : `≈${formatUsd(draw.usd)}`}. Script and lettering changes before drawing are free.${tail}`;
      }
      const est = estimateSpendAction(doc, { type: 'edit_page', pageId: page.id, instruction: 'quote' }, byok);
      return `≈${formatUsd(est.usd)} per image edit of page ${page.n} on ${est.model} (keeps the rest of the page). Dialogue, balloons and lettering changes are free — no edit needed.${tail}`;
    }
    case 'translate': {
      const { codes, unknown } = languageList(args.languages);
      if (!codes.length) {
        return unknown.length
          ? `I don't know ${unknown.join(', ')} as a language. Supported: ${LANGUAGES.slice(0, 24).map((l) => l.english).join(', ')}…${tail}`
          : `Say which languages to price (languages: ["te", "hi"]).${tail}`;
      }
      const { pages } = resolvePageNumbers(doc, args.pages);
      try {
        const est = await estimateTranslation(ctx, { type: 'translate', languages: codes, ...(pages?.length ? { pageIds: pages.map((p) => p.id) } : {}) });
        const free = est.plans.reduce((n, p) => n + p.freeLines.length + p.upToDate, 0);
        const paid = est.plans.reduce((n, p) => n + p.toTranslate.reduce((m, t) => m + t.lineIds.length, 0), 0);
        const skip = unknown.length ? ` (Unknown: ${unknown.join(', ')}.)` : '';
        return `${est.usd > 0 ? `≈${formatUsd(est.usd)}` : '$0'} to translate into ${codes.map(languageName).join(', ')}: ${plural(paid, 'line')} by the translator with a linguist review${free ? `, ${plural(free, 'line')} free (already done or copied by software)` : ''}.${skip}${tail}`;
      } catch (err) {
        const why = err instanceof StudioError ? err.userMessage : 'the translation estimate failed';
        return `I can't price a translation right now: ${why}${/[.!?]$/.test(why) ? '' : '.'}${tail}`;
      }
    }
    default:
      throw toolArgError(`action must be one of ${QUOTE_ACTIONS.join(', ')}.`);
  }
}

function quoteTool(ctx: StudioContext): DirectorTool {
  return defineTool(
    'quote',
    'free',
    'Price an action from the model registry WITHOUT starting it. Use it when the user asks "how much…?", before suggesting anything paid, or to compare a free fix with a paid one. Drawn, up-to-date pages are never counted (they cost $0); the result says what a new take would cost separately.',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...QUOTE_ACTIONS], description: 'What to price.' },
        pages: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Page numbers (render_pages subset; edit_page uses the first).' },
        include_cover: { type: 'boolean', description: 'render_pages: also price the cover when it needs drawing.' },
        languages: { type: 'array', items: { type: 'string' }, description: 'translate: language codes or names, e.g. ["te", "Hindi"].' }
      },
      required: ['action'],
      additionalProperties: false
    },
    (args) => quoteText(ctx, args)
  );
}

export const breakdownToolGroup: ToolGroup = {
  id: 'breakdown',
  priority: 10,
  when: () => true,
  tools: (ctx, turn) => [showPagesTool(ctx, turn), quoteTool(ctx)],
  promptRules: (doc) =>
    doc.pages.length
      ? 'BREAKDOWN: to show pages, the plan, what is drawn or what is left, call show_pages (free; it posts a visual card) instead of typing the plan out. For "how much would…", call quote (free) and say the number; never start a spend to find out a price.'
      : 'BREAKDOWN: once pages are planned, show_pages (free) shows them visually; quote (free) prices anything without starting it.',
  summaryLines: (doc) => {
    if (!doc.pages.length) return [];
    const byok = byokFromLedger(doc);
    const targets = pageTargets(doc);
    const q = quoteRenderPages(doc, { byok, tier: doc.settings.quality, modelOverride: doc.settings.imageModelOverride });
    const drawn = doc.pages.filter((p) => p.render.status === 'ready').length;
    const toDraw = targets.length ? `to draw now: ${pagesLabel(targets.map((p) => p.n))} ≈${formatUsd(q.usd)}` : 'nothing left to draw ($0)';
    const c = doc.cover.render.status;
    const cover = c === 'queued' || c === 'rendering' ? 'drawing' : coverNeedsDraw(doc) ? 'not drawn' : 'drawn';
    return [`Breakdown: ${plural(doc.pages.length, 'page')}, ${drawn} drawn; ${toDraw}; cover ${cover}.`];
  },
  activity: { show_pages: 'Laying out the pages', quote: 'Pricing it' }
};
