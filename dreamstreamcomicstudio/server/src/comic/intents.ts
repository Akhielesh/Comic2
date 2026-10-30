// Software-first intents (contract §12.8, softwarefirst.md §1.8, director.md §3.10).
//
// routeIntent: read-only requests the stream route answers BEFORE the director, for $0 and with
// no model call — "show me the pages", "how many panels?", "what's left / how much will it
// cost?", and "generate all pages" when every page is already drawn and current (the owner's
// real session redrew a ready page for that sentence). Anything it is not sure about returns
// null and goes to the director. Narrow, whole-message English patterns only.
//
// parseIntent: phase-2 structural edits (flag COMIC_FAST_INTENTS, wired by the route in wave 2):
// "swap pages 2 and 3", "delete page 4", "make the shouts red" → one FREE tool call with its args.

import { isPageStale, isTargetStale, totalPanels, type Card, type ComicDoc, type LineKind, type NextStep } from '../../../shared/comic/doc.js';
import { formatUsd } from '../../../shared/comic/models.js';
import { coverNeedsDraw, pageTargets, quoteRenderPages, unitPrice } from '../../../shared/comic/plan.js';
import { costFormatter, type CostFormatter } from './costText.js';
import { drawnBookLine, nothingNextSteps } from './replies.js';
import { breakdownCardFor } from './tools/breakdown.js';

export interface RoutedIntent {
  kind: 'show_pages' | 'nothing_to_draw';
  reply: string;
  cards: Card[];
  nextSteps: NextStep[];
}

// ── Normalization ────────────────────────────────────────────────────────────

/** Lowercase, collapse spaces, drop politeness and trailing punctuation/emoji. */
export const normalizeIntentText = (text: string): string =>
  String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}\s'&-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:ok(?:ay)?|hey|hi|so|now|alright|cool|great|thanks|thank you)\s+/, '')
    .replace(/^(?:please|pls|can you|could you|would you|will you|can i|could i|let me|i want to|i'd like to|i wanna)\s+/, '')
    .replace(/^(?:please|pls)\s+/, '')
    .replace(/\s+(?:please|pls|now|for me|thanks|thank you)$/, '')
    .replace(/\s+(?:please|pls|now|for me)$/, '')
    .trim();

// ── Read-only patterns ───────────────────────────────────────────────────────

const SHOW_RE = [
  /^(?:show|see|view|open|list|display)(?: me)?(?: the| my| our| all(?: of)?(?: the)?)? (?:pages?|plan|page plan|breakdown|storyboard|panels?|layout|script|book|comic so far|whole book|whole comic)(?: again| so far| now)?$/,
  /^(?:show|see|view)(?: me)? (?:the |my )?(?:pages?|panels?) (?:and|&) (?:panels?|pages?)$/,
  /^(?:what|which) (?:pages?|panels?) (?:do (?:we|i) have|are there|have we got)$/,
  /^how many (?:pages?|panels?)(?: (?:are there|do (?:we|i) have|is it|have we got|in total|so far))?$/,
  /^(?:page|plan) breakdown$/,
  /^(?:breakdown|storyboard|overview)$/
];
const STATUS_RE = [
  /^(?:what(?:'s| is)|whats) (?:left|done|drawn|the status|the progress|still to (?:draw|do)|missing)(?: so far)?$/,
  /^(?:status|progress)(?: update| check)?$/,
  /^where are we(?: at)?$/,
  /^(?:is|are) (?:it|everything|all (?:the )?pages?|the pages?) (?:done|drawn|ready|finished)(?: yet)?$/
];
const COST_RE = [
  /^how much (?:will|would|does|is) (?:it|this|that|the rest|everything|the comic|the book|the remaining pages|the pages|drawing(?: the)?(?: rest| pages| everything)?) (?:cost|be)(?: to (?:draw|finish|render|make)(?: (?:it|the rest|everything|all|the pages))?)?$/,
  /^how much (?:to|for) (?:draw|finish|render|make) (?:it|the rest|everything|all(?: the)? pages|the pages|the comic)$/,
  /^(?:what(?:'s| is)|whats) (?:the|my) (?:cost|price|quote|estimate|total)(?: so far)?$/,
  /^(?:quote|estimate|price)(?: it| the rest| everything)?$/
];
/** "Draw everything that is missing" — free only when nothing is missing. */
const DRAW_ALL_PAGES_RE = [
  /^(?:generate|draw|render|make|create|do|paint|illustrate) (?:all|every|all of|all the|all of the|the rest of the|the remaining|remaining|the rest|the other|my|the) ?(?:the )?pages?$/,
  /^(?:generate|draw|render|make|create|paint) (?:all|every) (?:the )?(?:remaining |missing |other )?pages?$/,
  /^(?:generate|draw|render|make|create) (?:the )?(?:missing|remaining|rest of the|undrawn) pages?$/,
  /^(?:go ahead and |just )?(?:generate|draw|render) (?:all|them all|all of them|the pages)$/
];
const DRAW_ALL_BOOK_RE = [
  /^(?:generate|draw|render|make|create|finish|complete|do) (?:everything|it all|all of it|the whole (?:thing|book|comic)|the (?:book|comic)|the rest)$/,
  /^(?:finish|complete) (?:it|the comic|the book|my comic|everything)$/,
  /^(?:draw|generate|render) everything(?: that'?s? (?:left|missing))?$/
];

const anyMatch = (list: RegExp[], t: string) => list.some((re) => re.test(t));

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "1 page · 3 panels · page 1 drawn · cover not drawn yet." */
export function bookStatusLine(doc: ComicDoc): string {
  const pages = [...doc.pages].sort((a, b) => a.n - b.n);
  const drawn = pages.filter((p) => p.render.status === 'ready' && !isPageStale(doc, p));
  const stale = pages.filter((p) => isPageStale(doc, p));
  const busy = pages.filter((p) => p.render.status === 'queued' || p.render.status === 'rendering');
  const failed = pages.filter((p) => p.render.status === 'failed');
  const parts = [plural(pages.length, 'page'), plural(totalPanels(doc), 'panel')];
  if (drawn.length === pages.length && pages.length) parts.push(pages.length === 1 ? 'page 1 drawn' : 'every page drawn');
  else if (drawn.length) parts.push(`${drawn.length} drawn`);
  else parts.push('nothing drawn yet');
  if (stale.length) parts.push(`${stale.length} out of date`);
  if (busy.length) parts.push(`${busy.length} drawing`);
  if (failed.length) parts.push(`${failed.length} failed`);
  const cover = doc.cover.render;
  // Same cover wording as the breakdown tool (tools/breakdown.ts): out of date / failed / drawing / not drawn.
  parts.push(
    cover.status === 'ready'
      ? isTargetStale(doc, { kind: 'cover' })
        ? 'cover out of date'
        : 'cover drawn'
      : cover.status === 'queued' || cover.status === 'rendering'
        ? 'cover drawing'
        : cover.status === 'failed'
          ? 'cover failed'
          : 'cover not drawn yet'
  );
  return `${parts.join(' · ')}.`;
}

/** The breakdown card the show_pages tool would show (one builder: cover tile only when it leads). */
const breakdownCard = (doc: ComicDoc, view: 'plan' | 'status' | 'cost'): Card => breakdownCardFor(doc, { view });

/** Chips for a breakdown answer: draw what is missing (quoted), the cover, read it. */
function breakdownNextSteps(doc: ComicDoc, byok: boolean): NextStep[] {
  const steps: NextStep[] = [];
  const quote = quoteRenderPages(doc, { byok, tier: doc.settings.quality, modelOverride: doc.settings.imageModelOverride });
  if (quote.pageIds.length) {
    steps.push({
      label: quote.pageIds.length === 1 ? `Draw page ${doc.pages.find((p) => p.id === quote.pageIds[0])?.n ?? ''}`.trim() : `Draw ${plural(quote.pageIds.length, 'page')}`,
      action: { type: 'render_pages', pageIds: quote.pageIds, quotedUsd: quote.usd },
      usd: quote.usd
    });
  }
  if (!quote.pageIds.length) return nothingNextSteps(doc, byok);
  if (coverNeedsDraw(doc) && doc.pages.some((p) => p.render.status === 'ready')) {
    const usd = unitPrice(doc, 'cover', { byok }).usd;
    steps.push({ label: 'Make the cover', action: { type: 'render_cover', quotedUsd: usd }, usd });
  }
  if (doc.pages.some((p) => p.render.status === 'ready')) steps.push({ label: 'Read it', client: { type: 'open_reader' } });
  return steps.slice(0, 6);
}

/**
 * Answer a read-only request for $0 (no model call), or null to let the director handle it.
 * Callers skip this when the message has attachments.
 */
export function routeIntent(doc: ComicDoc, text: string, opts: { byok?: boolean; cost?: CostFormatter } = {}): RoutedIntent | null {
  const t = normalizeIntentText(text);
  if (!t || t.length > 90 || !doc?.pages?.length) return null;
  const byok = !!opts.byok;
  // Prices in the user's terms (governed users: "≈2% of your usage").
  const cost = opts.cost ?? costFormatter();

  if (anyMatch(DRAW_ALL_PAGES_RE, t) || anyMatch(DRAW_ALL_BOOK_RE, t)) {
    const wantsBook = anyMatch(DRAW_ALL_BOOK_RE, t);
    const pages = pageTargets(doc);
    if (pages.length || (wantsBook && coverNeedsDraw(doc))) return null; // real work → the director quotes it
    const busy = doc.pages.some((p) => p.render.status === 'queued' || p.render.status === 'rendering');
    // Never "Everything is drawn" while the cover is missing or out of date (drawnBookLine says which).
    const reply = (!busy && drawnBookLine(doc, { offerCover: true })) || 'Everything is either drawn or already drawing — nothing new to start, and nothing was spent.';
    return { kind: 'nothing_to_draw', reply, cards: [breakdownCard(doc, 'status')], nextSteps: nothingNextSteps(doc, byok) };
  }

  if (anyMatch(COST_RE, t)) {
    const quote = quoteRenderPages(doc, { byok, tier: doc.settings.quality, modelOverride: doc.settings.imageModelOverride, includeCover: true });
    const what = [quote.pageIds.length ? plural(quote.pageIds.length, 'page') : '', quote.sheetIds.length ? plural(quote.sheetIds.length, 'character sheet') : '', quote.cover ? 'the cover' : '']
      .filter(Boolean)
      .join(' + ');
    const spent = cost.governed ? '' : ` Spent so far: ${formatUsd(doc.spend.totalUsd)}.`;
    const reply = quote.nothing
      ? `Nothing is left to draw — it's all done, so it costs ${cost.governed ? 'nothing' : '$0'}.${spent}`
      : `Drawing what's left (${what}) is about ${cost.governed ? cost(quote.usd).replace(/^≈/, '') : formatUsd(quote.usd)}.${spent} Text edits, balloons and page order are free.`;
    return { kind: 'show_pages', reply, cards: [breakdownCard(doc, 'cost')], nextSteps: breakdownNextSteps(doc, byok) };
  }

  if (anyMatch(STATUS_RE, t)) {
    return { kind: 'show_pages', reply: bookStatusLine(doc), cards: [breakdownCard(doc, 'status')], nextSteps: breakdownNextSteps(doc, byok) };
  }

  if (anyMatch(SHOW_RE, t)) {
    return { kind: 'show_pages', reply: `Here are the pages: ${bookStatusLine(doc)}`, cards: [breakdownCard(doc, 'plan')], nextSteps: breakdownNextSteps(doc, byok) };
  }
  return null;
}

// ── Phase 2: structural free edits (COMIC_FAST_INTENTS) ──────────────────────

export interface ParsedIntent {
  /** Director tool name (core or a feature group's). */
  tool: string;
  args: Record<string, unknown>;
  /** 0..1 — the route only acts at ≥ 0.95. */
  confidence: number;
}

const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, last: -1 };
const numOf = (s: string, doc: ComicDoc): number | undefined => {
  const n = /^\d+$/.test(s) ? Number(s) : NUM[s];
  if (n === -1) return doc.pages.length || undefined;
  return n && n >= 1 && n <= 40 ? n : undefined;
};
const N = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|last)';
const KIND_WORDS: Record<string, LineKind> = {
  shout: 'shout', shouts: 'shout', shouting: 'shout', caption: 'caption', captions: 'caption', narration: 'caption', thought: 'thought', thoughts: 'thought',
  whisper: 'whisper', whispers: 'whisper', sfx: 'sfx', 'sound effects': 'sfx', 'sound effect': 'sfx', speech: 'speech', dialogue: 'speech', dialog: 'speech'
};
const COLORS = 'red|blue|green|yellow|orange|purple|pink|black|white|grey|gray|brown|gold|teal|navy|crimson';

/** Narrow grammar → one free tool call (or null). Page numbers are validated against the doc. */
export function parseIntent(text: string, doc: ComicDoc): ParsedIntent | null {
  const t = normalizeIntentText(text);
  if (!t || t.length > 80) return null;
  const page = (s: string) => numOf(s, doc);
  const has = (n?: number) => !!n && doc.pages.some((p) => p.n === n);
  let m: RegExpExecArray | null;

  if ((m = new RegExp(`^(?:swap|switch|flip) (?:pages? )?${N} (?:and|&|with) (?:page )?${N}$`).exec(t))) {
    const a = page(m[1]);
    const b = page(m[2]);
    if (!has(a) || !has(b) || a === b || Math.abs(a! - b!) !== 1) return null; // non-adjacent swaps need two moves → director
    return { tool: 'move_page', args: { page: Math.max(a!, b!), to: Math.min(a!, b!) }, confidence: 0.97 };
  }
  if ((m = new RegExp(`^move page ${N} (?:to|to position|to be page) ${N}$`).exec(t))) {
    const a = page(m[1]);
    const b = page(m[2]);
    if (!has(a) || !has(b) || a === b) return null;
    return { tool: 'move_page', args: { page: a, to: b }, confidence: 0.97 };
  }
  if ((m = new RegExp(`^move page ${N} (?:after|behind) (?:page )?${N}$`).exec(t))) {
    const a = page(m[1]);
    const b = page(m[2]);
    if (!has(a) || !has(b) || a === b) return null;
    return { tool: 'move_page', args: { page: a, to: a! < b! ? b : b! + 1 }, confidence: 0.96 };
  }
  if ((m = new RegExp(`^(?:delete|remove|drop|get rid of) (?:the )?page ${N}$`).exec(t)) || (m = new RegExp(`^(?:delete|remove) the ${N} page$`).exec(t))) {
    const a = page(m[1]);
    return has(a) ? { tool: 'delete_page', args: { page: a }, confidence: 0.97 } : null;
  }
  if ((m = new RegExp(`^(?:duplicate|copy|clone) (?:the )?page ${N}$`).exec(t))) {
    const a = page(m[1]);
    return has(a) ? { tool: 'duplicate_page', args: { page: a }, confidence: 0.97 } : null;
  }
  if ((m = new RegExp(`^(?:add|insert) (?:a |one )?(?:new |blank |empty )?page (?:after|behind) (?:page )?${N}$`).exec(t))) {
    const a = page(m[1]);
    return has(a) ? { tool: 'insert_page', args: { after: a }, confidence: 0.96 } : null;
  }
  if (/^(?:add|insert) (?:a |one )?(?:new |blank |empty )?page (?:at the end|to the end)$/.test(t) && doc.pages.length) {
    return { tool: 'insert_page', args: { after: doc.pages.length }, confidence: 0.96 };
  }
  if (/^(?:add|insert) (?:a |one )?(?:new |blank |empty )?page (?:at the (?:start|beginning)|before page 1|first)$/.test(t)) {
    return { tool: 'insert_page', args: { after: 0 }, confidence: 0.96 };
  }
  if ((m = new RegExp(`^(?:use|go back to|restore|bring back) (?:the )?(earlier|previous|older|last|first|original) (?:version|one|take|drawing) of (?:page ${N}|the (cover))$`).exec(t))) {
    const which = m[1] === 'first' || m[1] === 'original' ? 'original' : 'previous';
    if (m[3] === 'cover') return doc.cover.render.history.length ? { tool: 'use_version', args: { target: 'cover', version: which }, confidence: 0.96 } : null;
    const a = page(m[2]);
    const p = doc.pages.find((x) => x.n === a);
    return p && p.render.history.length ? { tool: 'use_version', args: { target: 'page', page: a, version: which }, confidence: 0.96 } : null;
  }
  if ((m = /^make (?:all )?(?:the )?(text|lettering|letters|words|balloons?|bubbles?|font)(?: a bit| a little)? (bigger|larger|smaller)$/.exec(t))) {
    return { tool: 'set_lettering_style', args: { scope: 'comic', style: { size: m[2] === 'smaller' ? 'smaller' : 'larger' } }, confidence: 0.96 };
  }
  if ((m = new RegExp(`^make (?:all )?(?:the |every )?(shouts?|shouting|captions?|narration|thoughts?|whispers?|sfx|sound effects?|speech|dialogue|dialog)(?: balloons?| bubbles?| text| boxes)? (bigger|larger|smaller|bold|${COLORS})$`).exec(t))) {
    const kind = KIND_WORDS[m[1]] ?? KIND_WORDS[m[1].replace(/s$/, '')];
    if (!kind) return null;
    const v = m[2];
    const style = v === 'bigger' || v === 'larger' ? { size: 'larger' } : v === 'smaller' ? { size: 'smaller' } : v === 'bold' ? { bold: true } : { text_color: v };
    return { tool: 'set_lettering_style', args: { scope: 'kind', kind, style }, confidence: 0.96 };
  }
  if ((m = new RegExp(`^make (?:the |all (?:the )?)?(?:text|lettering|balloon text) (${COLORS})$`).exec(t))) {
    return { tool: 'set_lettering_style', args: { scope: 'comic', style: { text_color: m[1] } }, confidence: 0.95 };
  }
  return null;
}

/** Whether the route may run `parsed` without the director (flag, no attachments, no open gate). */
export const canFastPath = (parsed: ParsedIntent | null, opts: { enabled: boolean; attachments: number; gateOpen: boolean }): parsed is ParsedIntent =>
  !!parsed && opts.enabled && opts.attachments === 0 && !opts.gateOpen && parsed.confidence >= 0.95;
