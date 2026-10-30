// Comic History — plain words for a moment (versions plan §4.3 labels; package H0). Pure.
//
// "AI revised pages 3–4", "Before the AI drew pages 1–6", "AI translated 58 lines to Telugu", "Switched the image model
// and redrew pages 1–6", "You edited dialogue on pages 2 and 5", "The editor re-fitted balloons on page 2, no AI
// cost", "History starts here", "Where you left off".
// No git words (branch, merge, commit, checkout, fork, HEAD, diff, rebase, revert) — the creator never sees them.

import type { ComicDoc } from '../doc.js';
import { HISTORY_LIMITS } from '../limits.js';
import { languageSpec } from '../languages.js';
import { SECTION_KEYS } from './sections.js';
import type { BookDiff, ChangeItem, ChangeWhat, HistoryActor, HistoryKind } from './types.js';

export interface DescribeOptions {
  /** A name the user gave (named rows) or the line name (switch rows). */
  name?: string;
  /** What a restore came from: "Draft 2" / "Tue 10:42". */
  from?: string;
  /** The end-of-session flush ("Where you left off"). */
  final?: boolean;
  /** Language display names (default: the registry's English name). */
  languageName?: (code: string) => string;
}

/** "page 3" · "pages 3–4" · "pages 2 and 5" · "pages 1–3 and 6" · "pages 1, 3 and 5". */
export const pageRangeText = (ns: readonly number[]): string => {
  const sorted = [...new Set(ns.filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
  if (!sorted.length) return 'pages';
  if (sorted.length === 1) return `page ${sorted[0]}`;
  const runs: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const n of [...sorted.slice(1), Infinity]) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    runs.push(start === prev ? String(start) : prev === start + 1 ? `${start}–${prev}` : `${start}–${prev}`);
    start = n;
    prev = n;
  }
  const list = runs.length === 1 ? runs[0] : `${runs.slice(0, -1).join(', ')} and ${runs[runs.length - 1]}`;
  return `pages ${list}`;
};

const clip = (s: string): string => (s.length <= HISTORY_LIMITS.labelChars ? s : `${s.slice(0, HISTORY_LIMITS.labelChars - 1).trimEnd()}…`);
const langName = (code: string, opts: DescribeOptions) => opts.languageName?.(code) || languageSpec(code)?.english || code;
const pagesOf = (items: ChangeItem[]): number[] => items.flatMap((i) => i.pageNs || []);
const linesOf = (items: ChangeItem[]): number => items.reduce((n, i) => n + (i.count ?? i.lineIds?.length ?? 0), 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const groupBy = (changes: ChangeItem[]): Map<ChangeWhat, ChangeItem[]> => {
  const out = new Map<ChangeWhat, ChangeItem[]>();
  for (const c of changes) {
    if (!c || typeof c.what !== 'string') continue;
    const list = out.get(c.what) || [];
    list.push(c);
    out.set(c.what, list);
  }
  return out;
};

/**
 * The verb phrases of a set of changes, most important first ("revised pages 3–4", "drew page 5"). An image-model
 * switch leads, with its redraw right after it ("switched the image model", "redrew pages 1–6").
 */
const phrases = (changes: ChangeItem[], opts: DescribeOptions, actor: HistoryActor): string[] => {
  const g = groupBy(changes);
  const out: string[] = [];
  const model = !!g.get('model');
  const art = g.get('art');
  if (model) {
    out.push('switched the image model');
    if (art) out.push(`redrew ${pageRangeText(pagesOf(art))}`);
  }
  const text = [...(g.get('dialogue') || []), ...(g.get('panels') || []), ...(g.get('page_text') || [])];
  if (text.length) {
    const onlyDialogue = text.every((c) => c.what === 'dialogue');
    const pages = pageRangeText(pagesOf(text));
    out.push(actor === 'ai' ? `revised ${pages}` : onlyDialogue ? `edited dialogue on ${pages}` : `edited ${pages}`);
  }
  const added = g.get('pages_added');
  if (added) out.push(`added ${pageRangeText(pagesOf(added))}`);
  const removed = g.get('pages_removed');
  if (removed) out.push(`removed ${pageRangeText(pagesOf(removed))}`);
  if (art && !model) out.push(actor === 'ai' ? `drew ${pageRangeText(pagesOf(art))}` : `changed the art on ${pageRangeText(pagesOf(art))}`);
  const balloons = g.get('balloons');
  if (balloons) out.push(actor === 'editor' ? `re-fitted balloons on ${pageRangeText(pagesOf(balloons))}` : `moved balloons on ${pageRangeText(pagesOf(balloons))}`);
  for (const c of g.get('translation') || []) {
    const n = c.count ?? c.lineIds?.length ?? 0;
    out.push(n ? `translated ${plural(n, 'line')} to ${langName(c.lang || '', opts)}` : `updated the ${langName(c.lang || '', opts)} edition`);
  }
  const chars = g.get('character');
  if (chars) out.push(chars.length === 1 ? `updated ${chars[0].name || 'a character'}` : `updated ${plural(chars.length, 'character')}`);
  const places = g.get('place');
  if (places) out.push(places.length === 1 ? `updated ${places[0].name || 'a place'}` : `updated ${plural(places.length, 'place')}`);
  if (g.get('style') || g.get('option')) out.push('changed the style');
  if (g.get('cover')) out.push('changed the cover');
  if (g.get('script')) out.push('changed the script');
  if (g.get('pages_moved')) out.push('reordered the pages');
  if (g.get('details') || g.get('glossary')) out.push(actor === 'ai' ? 'updated the story details' : 'changed the story details');
  return out;
};

/** "a" · "a and b" · "a, b and c" · "a, b, c and more" (up to three phrases are named). */
const join = (parts: string[]): string => {
  if (parts.length <= 1) return parts[0] || '';
  if (parts.length <= 3) return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${parts.slice(0, 3).join(', ')} and more`;
};
const capitalize = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
const hasModel = (list: ChangeItem[]): boolean => list.some((c) => c?.what === 'model');

/** The row label for `kind` from its changes (≤ HISTORY_LIMITS.labelChars). Pure. */
export const describeChanges = (changes: readonly ChangeItem[], kind: HistoryKind, opts: DescribeOptions = {}): string => {
  const list = Array.isArray(changes) ? changes.filter(Boolean) : [];
  switch (kind) {
    case 'start':
      return 'History starts here';
    case 'import':
      return 'Brought into the new studio';
    case 'legacy':
      return clip(opts.name?.trim() || 'Classic snapshot');
    case 'named':
      return clip(opts.name?.trim() || 'Saved version');
    case 'publish':
      return 'Published';
    case 'before_restore':
      return clip(opts.from ? `Before restoring ${opts.from}` : 'Before restoring');
    case 'restore':
      return clip(opts.from ? `Restored from ${opts.from}` : 'Restored an earlier version');
    case 'switch':
      return clip(opts.name ? `Switched to “${opts.name}”` : 'Switched versions');
    case 'before_ai': {
      const p = phrases(list, opts, 'ai');
      if (hasModel(list)) {
        // "Before switching the image model and redrawing pages 1–6" (the switch is the creator's consented choice).
        const art = list.filter((c) => c.what === 'art');
        const rest = p.length - (art.length ? 2 : 1);
        return clip(`Before switching the image model${art.length ? ` and redrawing ${pageRangeText(pagesOf(art))}` : ''}${rest > 0 ? ' and more' : ''}`);
      }
      return clip(p.length ? `Before the AI ${join(p)}` : 'Before an AI change');
    }
    case 'ai': {
      const p = phrases(list, opts, 'ai');
      // A model switch is the creator's consented choice: "Switched the image model and redrew pages 1–6".
      if (hasModel(list)) return clip(capitalize(join(p)));
      return clip(p.length ? `AI ${join(p)}` : 'AI changed the book');
    }
    case 'edits':
    default: {
      if (opts.final) return 'Where you left off';
      const editor = list.length > 0 && list.every((c) => c.by === 'editor');
      const p = phrases(list, opts, editor ? 'editor' : 'you');
      if (editor) return clip(`The editor ${p.length ? join(p) : 'tidied the pages'}, no AI cost`);
      return clip(p.length ? `You ${join(p)}` : 'Your edits');
    }
  }
};

/**
 * The ChangeItems of a diff a → b (≤ HISTORY_LIMITS.changesPerRow; semantic, since diffBooks already hides QC,
 * variant and safety-only differences). `b` supplies page numbers and names as they are now.
 */
export const changeItemsFromDiff = (diff: BookDiff, by: HistoryActor, b?: Pick<ComicDoc, 'pages'>): ChangeItem[] => {
  const out: ChangeItem[] = [];
  const nOf = (id: string, fallback?: number) => b?.pages.find((p) => p.id === id)?.n ?? fallback;
  const moved: string[] = [];
  for (const p of diff.pages) {
    const n = nOf(p.pageId, p.toN ?? p.fromN);
    const page = { pageIds: [p.pageId], ...(n ? { pageNs: [n] } : {}) };
    if (p.status === 'added') out.push({ what: 'pages_added', by, key: SECTION_KEYS.page(p.pageId), ...page });
    else if (p.status === 'removed') out.push({ what: 'pages_removed', by, key: SECTION_KEYS.page(p.pageId), pageIds: [p.pageId], ...(p.fromN ? { pageNs: [p.fromN] } : {}) });
    else if (p.status === 'moved') moved.push(p.pageId);
    else {
      if (p.text) {
        const onlyDialogue = p.panels.length > 0 && p.panels.every((x) => x.status === 'changed' && !x.fields.length && x.lines.length);
        const lineIds = p.panels.flatMap((x) => x.lines.map((l) => l.lineId));
        out.push({ what: onlyDialogue ? 'dialogue' : p.panels.length ? 'panels' : 'page_text', by, key: SECTION_KEYS.page(p.pageId), ...page, ...(lineIds.length ? { lineIds: lineIds.slice(0, 40), count: lineIds.length } : {}) });
      }
      if (p.art) out.push({ what: 'art', by, key: SECTION_KEYS.art(p.pageId), ...page });
    }
  }
  if (moved.length) out.push({ what: 'pages_moved', by, pageIds: moved });
  for (const c of diff.cast) out.push({ what: 'character', by, key: SECTION_KEYS.char(c.id), id: c.id, name: c.name });
  for (const pl of diff.places) out.push({ what: 'place', by, key: SECTION_KEYS.places, id: pl.id, name: pl.name });
  for (const o of diff.options) out.push({ what: 'option', by, key: SECTION_KEYS.option(o.id), id: o.id, name: o.name });
  if (diff.style) out.push({ what: 'style', by, key: SECTION_KEYS.style });
  if (diff.script) out.push({ what: 'script', by, key: SECTION_KEYS.source });
  if (diff.cover.text || diff.cover.art) out.push({ what: 'cover', by, key: SECTION_KEYS.cover });
  if (diff.meta.length) out.push({ what: 'details', by, key: SECTION_KEYS.meta });
  for (const e of diff.editions) out.push({ what: 'translation', by, key: SECTION_KEYS.edition(e.lang), lang: e.lang, count: e.lineIds.length, lineIds: e.lineIds.slice(0, 40) });
  if (diff.glossary) out.push({ what: 'glossary', by, key: SECTION_KEYS.glossary });
  if (diff.model) out.push({ what: 'model', by });
  return out.slice(0, HISTORY_LIMITS.changesPerRow);
};

/** How many lines a set of changes touched (the "12 lines need updating" count). */
export const changedLineCount = (changes: readonly ChangeItem[]): number => linesOf(changes.filter((c) => c.what === 'dialogue' || c.what === 'translation'));
