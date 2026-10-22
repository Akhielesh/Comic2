// Director tool group "reader" (contract §12.1/§12.2, reader.md §7.5). Owner: P1-READER.
//
//   set_reader_options   how the published comic reads: page-turn style, Guided View overview,
//                        paper texture, ambient colour, End-card credits, inside-cover dedication  → `reader`
//   set_chapter          mark (or clear) a chapter start on a page (scrubber marks, End-card list) → `page {chapterTitle}`
//
// Both are FREE (software settings: no spend, no gate, no redraw) and never change a page's spec hash.
// Phase gate: at least one page drawn — before that there is nothing to read.
// Results are honest sentences that say exactly what changed (or that nothing needed to), so the
// director always has something visible to tell the user. Guided View is never the default
// (decisions-final #11); asking for it gets an explanation, not a silent no-op.

import { readerOf, DEFAULT_READER, type ComicDoc, type Page, type ReaderSettings } from '../../../../shared/comic/doc.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import { DOC_LIMITS } from '../../../../shared/comic/limits.js';
import { defineTool, toolArgError, type DirectorTool, type ToolGroup } from '../extensions.js';
import { sanitizeCtxFor, sanitizePatchOps } from '../jobs.js';
import { prefilterText } from '../safety/index.js';
import type { DirectorTurn } from '../tools.js';
import type { StudioContext } from '../types.js';
import { READER_TURN_STYLES, cleanReaderText, sanitizeReaderPatch } from '../sanitize/reader.js';

const FREE_NOTE = 'Free — done by the editor, no AI cost.';
const TURN_WORD: Record<ReaderSettings['turn'], string> = {
  paper: 'paper page turns (the page curls like a real book)',
  slide: 'slide page turns',
  fade: 'gentle crossfades between pages'
};

const sortedPages = (doc: ComicDoc): Page[] => [...doc.pages].sort((a, b) => a.n - b.n);
const isDrawn = (p: Page) => !!p.render.asset?.path;
const drawnCount = (doc: ComicDoc) => doc.pages.filter(isDrawn).length;
const quote = (t: string, max = 60) => `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`;
const int = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/^page\s*/i, '')) : Number.NaN;
  return Number.isFinite(n) ? Math.round(n) : undefined;
};
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined);

/** Pages as "1–6" or "1, 3, 5" for honest error messages. */
const pageList = (doc: ComicDoc): string => {
  const ns = sortedPages(doc).map((p) => p.n);
  if (!ns.length) return 'no pages yet';
  const contiguous = ns.every((n, i) => i === 0 || n === ns[i - 1] + 1);
  return contiguous && ns.length > 2 ? `pages ${ns[0]}–${ns[ns.length - 1]}` : `pages ${ns.join(', ')}`;
};

/** Chapter marks in page order. */
export const chaptersOf = (doc: ComicDoc): { n: number; title: string }[] =>
  sortedPages(doc)
    .filter((p) => typeof p.chapterTitle === 'string' && p.chapterTitle.trim())
    .map((p) => ({ n: p.n, title: p.chapterTitle!.trim() }));

/** One-line description of the reader settings that differ from the defaults (empty when default). */
export function describeReader(settings: ReaderSettings): string[] {
  const out: string[] = [];
  if (settings.turn !== DEFAULT_READER.turn) out.push(`${settings.turn} turns`);
  if (settings.guidedOverview !== DEFAULT_READER.guidedOverview) out.push(`guided overview ${settings.guidedOverview ? 'on' : 'off'}`);
  if (settings.paperTexture !== DEFAULT_READER.paperTexture) out.push(`paper texture ${settings.paperTexture ? 'on' : 'off'}`);
  if (settings.ambient !== DEFAULT_READER.ambient) out.push(`ambient colour ${settings.ambient ? 'on' : 'off'}`);
  if (settings.credits) out.push(`credits ${quote(settings.credits, 40)}`);
  if (settings.dedication) out.push(`dedication ${quote(settings.dedication, 40)}`);
  return out;
}

/** What a change did, in words ("readers now get slide page turns; paper texture is off"). */
function changeSentence(before: ReaderSettings, after: ReaderSettings): string[] {
  const parts: string[] = [];
  if (before.turn !== after.turn) parts.push(`readers now get ${TURN_WORD[after.turn]}`);
  if (before.guidedOverview !== after.guidedOverview)
    parts.push(after.guidedOverview ? 'Guided View shows the whole page before zooming into panels' : 'Guided View goes straight to the first panel');
  if (before.paperTexture !== after.paperTexture) parts.push(`paper texture is ${after.paperTexture ? 'on' : 'off'}`);
  if (before.ambient !== after.ambient) parts.push(`the reading room ${after.ambient ? 'glows with each page’s colours' : 'stays plain dark'}`);
  if (before.credits !== after.credits) parts.push(after.credits ? `the End card credits read ${quote(after.credits, 80)}` : 'the End card credits line is cleared');
  if (before.dedication !== after.dedication) parts.push(after.dedication ? `the inside cover reads ${quote(after.dedication, 80)}` : 'the dedication is cleared');
  return parts;
}

/** Validate through the shared sanitizer + safety screen (the UI's path) and commit as a director edit. */
const commit = (ctx: StudioContext, ops: DocOp[], label: string): ComicDoc => {
  const clean = sanitizePatchOps(ctx.session.doc, ops, sanitizeCtxFor(ctx));
  return ctx.session.commit(clean, { origin: 'director', label });
};

function setReaderOptionsTool(ctx: StudioContext): DirectorTool {
  return defineTool(
    'set_reader_options',
    'free',
    'Choose how the published comic reads: page-turn style (paper curl, slide, or fade), whether Guided View (panel by panel, one tap away for readers) starts with the whole page, paper texture, ambient room colour from the pages, the End-card credits line and an inside-cover dedication. Use when the user talks about the reading experience. Guided View cannot be made the default.',
    {
      type: 'object',
      properties: {
        turn: { type: 'string', enum: [...READER_TURN_STYLES], description: 'paper = realistic page curl (default), slide = pages slide over each other, fade = crossfade.' },
        guidedOverview: { type: 'boolean', description: 'Guided View shows the whole page first, then each panel.' },
        paperTexture: { type: 'boolean', description: 'Subtle paper grain and page edges.' },
        ambient: { type: 'boolean', description: 'Tint the dark reading room with the colours of the current page.' },
        credits: { type: ['string', 'null'], description: `End-card credits line (≤ ${DOC_LIMITS.readerTextChars} characters). null clears it.` },
        dedication: { type: ['string', 'null'], description: `Inside-cover dedication (≤ ${DOC_LIMITS.readerTextChars} characters). null clears it.` }
      },
      additionalProperties: false
    },
    (args) => {
      const doc = ctx.session.doc;
      const askedGuidedDefault = args.guidedDefault === true || args.guided_default === true;
      const raw: Record<string, unknown> = {};
      if (args.turn !== undefined) raw.turn = typeof args.turn === 'string' ? args.turn.trim().toLowerCase() : args.turn;
      for (const key of ['guidedOverview', 'paperTexture', 'ambient'] as const) {
        if (args[key] !== undefined) raw[key] = bool(args[key]) ?? args[key];
      }
      for (const key of ['credits', 'dedication'] as const) {
        if (args[key] !== undefined) raw[key] = args[key];
      }
      if (!Object.keys(raw).length) {
        if (askedGuidedDefault) {
          return 'Guided View is never the default: readers open it with one tap (the panel button in the reader, a double-tap on a panel, or a link with ?guided=1). Nothing was changed. If the user wants guided reading to feel smoother, offer guidedOverview (show the whole page first).';
        }
        const now = describeReader(readerOf(doc));
        return `No reader setting was given, so nothing changed. Current reader: ${now.length ? now.join(', ') : 'the defaults (paper page turns, guided overview on, paper texture on, ambient colour on)'}.`;
      }
      // Validation errors come back to the model as "Error: …" with what to fix.
      const patch = sanitizeReaderPatch(raw);
      const before = readerOf(doc);
      const after = readerOf(commit(ctx, [{ op: 'reader', patch }], 'Reader settings'));
      const changed = changeSentence(before, after);
      const guidedNote = askedGuidedDefault ? ' Guided View itself stays one tap away rather than the default.' : '';
      if (!changed.length) return `Those reader settings were already in place — nothing changed.${guidedNote}`;
      return `Done — ${changed.join('; ')}. ${FREE_NOTE}${guidedNote} Readers can still pick their own turn style and layout in the reader.`;
    }
  );
}

function setChapterTool(ctx: StudioContext): DirectorTool {
  return defineTool(
    'set_chapter',
    'free',
    `Mark (or clear) a chapter start on a page. The title shows as a chapter mark on the reader's page scrubber and on the End card. title ≤ ${DOC_LIMITS.chapterTitleChars} characters; null clears the mark.`,
    {
      type: 'object',
      properties: {
        page: { type: 'integer', minimum: 1, description: '1-based page number where the chapter starts.' },
        title: { type: ['string', 'null'], description: 'Chapter title, e.g. "Chapter 2: The Lake". null removes the mark.' }
      },
      required: ['page', 'title'],
      additionalProperties: false
    },
    (args) => {
      const doc = ctx.session.doc;
      const n = int(args.page ?? args.pageN ?? args.page_n);
      if (n === undefined) throw toolArgError(`page must be a page number (${pageList(doc)}).`);
      const page = sortedPages(doc).find((p) => p.n === n);
      if (!page) throw toolArgError(`There is no page ${n} — the comic has ${pageList(doc)}.`);
      const rawTitle = args.title;
      const clearing = rawTitle === null || rawTitle === undefined || (typeof rawTitle === 'string' && !cleanReaderText(rawTitle));
      if (!clearing && typeof rawTitle !== 'string') throw toolArgError('title must be text, or null to clear the chapter mark.');
      if (clearing) {
        if (!page.chapterTitle) return `Page ${n} has no chapter mark, so nothing changed.${chaptersOf(doc).length ? ` Chapters: ${chaptersOf(doc).map((c) => `p${c.n} ${quote(c.title, 40)}`).join(', ')}.` : ''}`;
        // Shallow-merge op: null is stored and every consumer treats it as unset (contract R4).
        ctx.session.commit([{ op: 'page', id: page.id, patch: { chapterTitle: null as unknown as undefined } }], { origin: 'director', label: `Clear chapter on page ${n}` });
        return `Removed the chapter mark from page ${n}. ${FREE_NOTE}`;
      }
      const title = cleanReaderText(rawTitle as string);
      if (title.length > DOC_LIMITS.chapterTitleChars) {
        throw toolArgError(`Chapter titles are at most ${DOC_LIMITS.chapterTitleChars} characters (that one has ${title.length}). Use a shorter title.`);
      }
      const rating = sanitizeCtxFor(ctx).rating;
      const screen = prefilterText(title, rating);
      if (screen.decision === 'block') throw toolArgError('That chapter title can’t be used in this comic. Suggest a different, gentler title.');
      if (screen.decision === 'ambiguous') throw toolArgError(`That chapter title may be too strong for a ${rating} comic. Suggest a softer title.`);
      if (page.chapterTitle === title) return `Page ${n} already starts the chapter ${quote(title)} — nothing changed.`;
      ctx.session.commit([{ op: 'page', id: page.id, patch: { chapterTitle: title } }], { origin: 'director', label: `Chapter on page ${n}` });
      const all = chaptersOf(ctx.session.doc);
      return `Done — page ${n} now starts the chapter ${quote(title)}; readers see it on the page scrubber${all.length > 1 ? ` (chapters: ${all.map((c) => `p${c.n} ${quote(c.title, 30)}`).join(', ')})` : ''}. ${FREE_NOTE}`;
    }
  );
}

export const readerToolGroup: ToolGroup = {
  id: 'reader',
  priority: 70,
  when: (ctx: StudioContext) => drawnCount(ctx.session.doc) > 0,
  tools: (ctx: StudioContext, _turn: DirectorTurn): DirectorTool[] => [setReaderOptionsTool(ctx), setChapterTool(ctx)],
  promptRules: () =>
    'READER (free): how the finished comic reads — page-turn style (paper curl / slide / fade), Guided View overview, paper texture, ambient colour, End-card credits and an inside-cover dedication — is set with set_reader_options; chapter marks with set_chapter. Guided View (panel by panel) is never the default: readers open it with one tap. Confirm every change in one visible sentence.',
  summaryLines: (doc: ComicDoc) => {
    const lines: string[] = [];
    const changed = describeReader(readerOf(doc));
    if (changed.length) lines.push(`Reader: ${changed.join(', ')}.`);
    const chapters = chaptersOf(doc);
    if (chapters.length) lines.push(`Chapters: ${chapters.map((c) => `p${c.n} ${quote(c.title, 30)}`).join(', ')}.`);
    return lines;
  },
  activity: {
    set_reader_options: 'Setting up the reader',
    set_chapter: 'Marking a chapter'
  }
};
