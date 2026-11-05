// Dialogue understanding: which line(s) a LineRef means (agent-editor plan §3 B2 resolve.ts). Pure and free.
//
// Deterministic rules, in this order:
// 1. Selection wins: deixis ("this, that, it, these, both") or no other target means the selected balloons. A singular
//    word with 2 or more selected asks.
// 2. Quoted text (`textContains`) narrows the candidates.
// 3. Speaker (fuzzy, one candidate only), kind, panel, ordinal (`nth`) and `which` narrow further.
// 4. Scope widens only when empty: focus panel → focus page → pages touched in the last two turns → whole comic.
// 5. One match → apply. 2–5 → "Which line?" (one chip per candidate, with a picture). More than 5 → "tap the balloon".
//    None → an honest inventory of what exists.
// 6. Plural words ("all whispers", "every caption", "these") apply to every match; above 20 lines or 3 pages they
//    confirm first (free).

import type { ComicDoc, LineKind, NextStep, OptionChoice, Page } from '../doc.js';
import { normalizeLetteringText } from '../textLayout.js';
import { lineBox } from './placement.js';
import { castList, isSpeakerPronoun, matchSpeaker, noSuchSpeaker, pronounQuestion, speakerName } from './speakers.js';
import type { LineHit, LineRef, Resolution, ResolveContext } from './types.js';

/**
 * A LineRef that may be plural (`all`: "all / every / each / these / both"; every match applies). B1's LineRef has no
 * plural marker yet (amendment: `LineRef.all?: boolean`); the grammar sets it and the resolver reads it here.
 */
export type PluralLineRef = LineRef & { all?: boolean };
export const isPluralRef = (ref: LineRef | undefined): boolean => !!ref && (ref as PluralLineRef).all === true;

/**
 * A 'none' resolution that is really a question: a pronoun ("her", "his") with no selection or earlier name to point to.
 * askForResolution turns it into "Who do you mean by “her”?" with cast chips (`among`: the selection's speakers).
 */
export type PronounResolution = Extract<Resolution, { status: 'none' }> & { pronoun: string; among?: string[] };
export const isPronounResolution = (res: Resolution): res is PronounResolution => res.status === 'none' && typeof (res as PronounResolution).pronoun === 'string';

/** Resolver bounds (plan §3 B2 step 5–6). */
export const RESOLVE_LIMITS = { whichMax: 5, confirmLines: 20, confirmPages: 3 } as const;

/**
 * ResolveContext plus `confirmed` (amendment: `ResolveContext.confirmed?: boolean`): the creator already answered yes to
 * "That changes N lines on M pages. Go ahead?", so a big plural edit applies instead of asking again. It never widens a
 * match, never answers "Which line?" and never skips a lock; the compilers still keep DOC_LIMITS (line_style ops carry at
 * most lineIdsPerOp ids each).
 */
export type DialogueContext = ResolveContext & { confirmed?: boolean };
export const isConfirmed = (ctx: ResolveContext | undefined): boolean => !!ctx && (ctx as DialogueContext).confirmed === true;

const KIND_NOUN: Record<LineKind, [string, string]> = {
  speech: ['speech balloon', 'speech balloons'],
  thought: ['thought balloon', 'thought balloons'],
  whisper: ['whisper', 'whispers'],
  shout: ['shout', 'shouts'],
  caption: ['caption', 'captions'],
  sfx: ['sound effect', 'sound effects']
};
const KIND_SHORT: Record<LineKind, string> = { speech: 'speech', thought: 'thought', whisper: 'whisper', shout: 'shout', caption: 'caption', sfx: 'sound effect' };

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const quote = (text: string, max = 32): string => {
  const t = normalizeLetteringText(text).replace(/\s+/g, ' ').trim();
  return `“${t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t}”`;
};
const pageRange = (ns: number[]): string => {
  const sorted = [...new Set(ns)].sort((a, b) => a - b);
  if (!sorted.length) return '';
  if (sorted.length === 1) return `page ${sorted[0]}`;
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
  return contiguous ? `pages ${sorted[0]}–${sorted[sorted.length - 1]}` : `pages ${sorted.join(', ')}`;
};
const norm = (s: string): string => normalizeLetteringText(s).toLowerCase().replace(/[’‘`]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

// ── Lines ────────────────────────────────────────────────────────────────────

/** Every lettered line (non-empty words) of the given pages (default: the whole comic), in reading order. */
export function lineHits(doc: ComicDoc, pages: readonly Page[] = doc.pages): LineHit[] {
  const out: LineHit[] = [];
  for (const page of pages) {
    for (const panel of page.panels) {
      for (const line of panel.lines) {
        if (!normalizeLetteringText(line.text)) continue;
        out.push({
          lineId: line.id,
          pageId: page.id,
          panelId: panel.id,
          pageN: page.n,
          panelN: panel.n,
          kind: line.kind,
          ...(line.speakerId ? { speakerId: line.speakerId } : {}),
          text: line.text
        });
      }
    }
  }
  return out;
}

/** The hit of one line id (undefined when it is not a lettered line of a live page). */
export const hitOf = (doc: ComicDoc, lineId: string): LineHit | undefined => lineHits(doc).find((h) => h.lineId === lineId);

/** "P2 · panel 1 · MIRA PATEL: “We have to go”" — the chip label of a "Which line?" option. */
export const lineChipLabel = (doc: ComicDoc, hit: LineHit): string => {
  const who = hit.speakerId ? (speakerName(doc, hit.speakerId) ?? '?').toUpperCase() : KIND_SHORT[hit.kind].toUpperCase();
  return `P${hit.pageN} · panel ${hit.panelN} · ${who}: ${quote(hit.text, 28)}`;
};

/** "page 2, panel 1: “We have to go”" — how a reply or a chip names one line. */
export const lineWords = (hit: LineHit): string => `page ${hit.pageN}, panel ${hit.panelN}: ${quote(hit.text)}`;

/** One option per candidate for the "Which line?" card: the chip label, a crop of the balloon, and a precise reply. */
export function whichLineChoices(doc: ComicDoc, candidates: readonly LineHit[]): OptionChoice[] {
  return candidates.slice(0, RESOLVE_LIMITS.whichMax).map((hit) => ({
    id: hit.lineId,
    label: lineChipLabel(doc, hit),
    reply: `The one on ${lineWords(hit)}`,
    visual: { kind: 'balloon', pageId: hit.pageId, lineId: hit.lineId }
  }));
}

// ── Describing a ref ─────────────────────────────────────────────────────────

const describeRef = (doc: ComicDoc, ref: LineRef, speakerIds?: string[]): string => {
  const bits: string[] = [];
  if (ref.selected) bits.push('selected');
  bits.push(ref.kind ? KIND_NOUN[ref.kind][1] : 'balloons');
  if (speakerIds?.length) bits.push(`by ${castList(doc, speakerIds)}`);
  if (ref.textContains) bits.push(`containing ${quote(ref.textContains, 40)}`);
  if (ref.panel !== undefined) bits.push(typeof ref.panel === 'number' ? `in panel ${ref.panel}` : `in the ${ref.panel} panel`);
  if (typeof ref.page === 'number') bits.push(`on page ${ref.page}`);
  else if (ref.page === 'this') bits.push('on this page');
  return bits.join(' ');
};

/** "page 1 has speech ×2, caption ×1; page 2 has …" (what exists, so "nothing matched" is never a dead end). */
export const inventory = (doc: ComicDoc, pages: readonly Page[]): string => {
  const parts = pages.slice(0, 4).map((page) => {
    const counts = new Map<LineKind, number>();
    for (const h of lineHits(doc, [page])) counts.set(h.kind, (counts.get(h.kind) ?? 0) + 1);
    const list = [...counts.entries()].map(([k, n]) => `${KIND_SHORT[k]} ×${n}`).join(', ');
    return `page ${page.n} has ${list || 'no lettered lines'}`;
  });
  if (pages.length > 4) parts.push(`…and ${plural(pages.length - 4, 'more page')}`);
  if (!parts.length) return 'The comic has no pages yet';
  const s = parts.join('; ');
  return s[0].toUpperCase() + s.slice(1);
};

// ── The resolver ─────────────────────────────────────────────────────────────

const narrowing = (ref: LineRef): boolean =>
  ref.page !== undefined ||
  ref.panel !== undefined ||
  !!ref.speaker ||
  !!ref.kind ||
  !!ref.textContains ||
  !!ref.lineIds?.length ||
  ref.nth !== undefined ||
  ref.which !== undefined;

/** Reading order key of a hit (page, panel, line position). */
const orderOf = (doc: ComicDoc): Map<string, number> => new Map(lineHits(doc).map((h, i) => [h.lineId, i]));

/** Pick one candidate by geometry ("the top one", "the biggest"); undefined when no box is known. */
const pickWhich = (doc: ComicDoc, hits: LineHit[], which: NonNullable<LineRef['which']>): LineHit | undefined => {
  const boxed = hits
    .map((h) => {
      const page = doc.pages.find((p) => p.id === h.pageId);
      return { h, box: page ? lineBox(doc, page, h.lineId) : undefined };
    })
    .filter((x): x is { h: LineHit; box: NonNullable<ReturnType<typeof lineBox>> } => !!x.box);
  if (!boxed.length) return undefined;
  const score = (b: { x: number; y: number; w: number; h: number }): number =>
    which === 'top' ? b.y : which === 'bottom' ? -(b.y + b.h) : which === 'left' ? b.x : which === 'right' ? -(b.x + b.w) : -(b.w * b.h);
  return boxed.reduce((best, cur) => (score(cur.box) < score(best.box) - 1e-9 ? cur : best)).h;
};

/** Pick the nth candidate in reading order (1-based; 'first', 'last', or a negative count from the end). */
const pickNth = (hits: LineHit[], nth: NonNullable<LineRef['nth']>): LineHit | undefined => {
  if (nth === 'first') return hits[0];
  if (nth === 'last') return hits[hits.length - 1];
  if (!Number.isFinite(nth) || nth === 0) return undefined;
  return nth > 0 ? hits[nth - 1] : hits[hits.length + nth];
};

const finish = (doc: ComicDoc, hits: LineHit[], many: boolean, ctx: ResolveContext): Resolution => {
  const order = orderOf(doc);
  const sorted = [...hits].sort((a, b) => (order.get(a.lineId) ?? 0) - (order.get(b.lineId) ?? 0));
  if (many) {
    const pages = new Set(sorted.map((h) => h.pageId)).size;
    const big = sorted.length > RESOLVE_LIMITS.confirmLines || pages > RESOLVE_LIMITS.confirmPages;
    if (big && !isConfirmed(ctx)) return { status: 'confirm', lines: sorted, pages };
    return { status: 'lines', lines: sorted };
  }
  if (sorted.length === 1) return { status: 'lines', lines: sorted };
  if (sorted.length <= RESOLVE_LIMITS.whichMax) return { status: 'which', candidates: sorted };
  const pageIds = [...new Set(sorted.map((h) => h.pageId))];
  const pageId = pageIds.length === 1 ? pageIds[0] : ctx.pageId && pageIds.includes(ctx.pageId) ? ctx.pageId : sorted[0].pageId;
  return { status: 'tap', count: sorted.length, pageId };
};

/**
 * LineRef → lines (B2 resolve.ts): selection wins; quoted text, speaker, kind, ordinal and `which` narrow; scope widens
 * only when empty (focus panel → focus page → recent pages → whole comic); plurals apply to every match.
 */
export function resolveLineRef(doc: ComicDoc, ref: LineRef, ctx: ResolveContext = {}): Resolution {
  const r: LineRef = ref ?? {};
  const isPlural = isPluralRef(r);
  const all = lineHits(doc);
  const byId = new Map(all.map((h) => [h.lineId, h]));
  const selected = (ctx.lineIds ?? []).map((id) => byId.get(id)).filter((h): h is LineHit => !!h);

  // Explicit ids are exact: every one of them applies.
  if (r.lineIds?.length) {
    const hits = [...new Set(r.lineIds)].map((id) => byId.get(id)).filter((h): h is LineHit => !!h);
    if (!hits.length) return { status: 'none', note: `Those lines are not in the comic any more — nothing was changed. ${inventory(doc, doc.pages)}.` };
    return finish(doc, hits, true, ctx);
  }

  // Speaker: fuzzy, resolved only on one candidate ("her" = the selection's speaker). Several → every candidate's lines
  // are candidates, so the "Which line?" card names who says each one.
  let speakerIds: string[] | undefined;
  if (r.speaker) {
    const pronounOf = [...new Set(selected.map((h) => h.speakerId).filter((x): x is string => !!x))];
    const m = matchSpeaker(doc, r.speaker, { pronounOf: pronounOf.length === 1 ? pronounOf[0] : undefined });
    if (m.status === 'none' && isSpeakerPronoun(r.speaker)) {
      // "her second line" with nothing to point to: ask who (cast chips; the selection's speakers first when several).
      const who: PronounResolution = { status: 'none', note: pronounQuestion(r.speaker), pronoun: r.speaker, ...(pronounOf.length > 1 ? { among: pronounOf } : {}) };
      return who;
    }
    if (m.status === 'none') return { status: 'none', note: `${noSuchSpeaker(doc, r.speaker)} Nothing was changed.` };
    speakerIds = m.status === 'one' ? [m.characterId] : m.characterIds;
  }
  const contains = r.textContains ? norm(r.textContains).replace(/^["']|["']$/g, '') : '';
  const pass = (h: LineHit, page?: Page): boolean => {
    if (r.kind && h.kind !== r.kind) return false;
    if (speakerIds && !(h.speakerId && speakerIds.includes(h.speakerId))) return false;
    if (contains && !norm(h.text).includes(contains)) return false;
    if (r.panel !== undefined) {
      const pg = page ?? doc.pages.find((p) => p.id === h.pageId);
      const n = r.panel === 'first' ? 1 : r.panel === 'last' ? (pg?.panels.length ?? 0) : r.panel;
      if (h.panelN !== n) return false;
    }
    return true;
  };
  const narrow = (hits: LineHit[]): LineHit[] | undefined => {
    let out = hits.filter((h) => pass(h));
    if (!out.length) return undefined;
    if (r.nth !== undefined) {
      const one = pickNth(out, r.nth);
      if (!one) return undefined;
      out = [one];
    }
    if (r.which && out.length > 1) {
      const one = pickWhich(doc, out, r.which);
      if (one) out = [one];
    }
    return out;
  };

  // 1. Selection wins: deixis, or no other target at all.
  if (selected.length && (r.selected || !narrowing(r))) {
    const hits = narrow(selected);
    if (!hits) {
      return { status: 'none', note: `None of the selected balloons is one of the ${describeRef(doc, { ...r, selected: false }, speakerIds)} — nothing was changed.` };
    }
    return finish(doc, hits, isPlural, ctx);
  }

  // 2–4. Narrow inside the smallest scope that has a match.
  const pageById = (id?: string) => (id ? doc.pages.find((p) => p.id === id) : undefined);
  const focusPage = pageById(ctx.pageId);
  let scopes: { pages: Page[]; panelN?: number }[];
  if (r.page !== undefined) {
    const page = r.page === 'this' ? focusPage : doc.pages.find((p) => p.n === r.page);
    if (!page) {
      return {
        status: 'none',
        note: r.page === 'this' ? `Which page? Open the page first or say its number — nothing was changed.` : `There's no page ${r.page}: the comic has ${plural(doc.pages.length, 'page')}. Nothing was changed.`
      };
    }
    scopes = [{ pages: [page] }];
  } else {
    const recent = (ctx.recentPageIds ?? []).map(pageById).filter((p): p is Page => !!p);
    const pluralWide = isPlural && !!(r.kind || speakerIds || contains);
    scopes = [];
    if (!pluralWide) {
      if (focusPage && ctx.panelN !== undefined && r.panel === undefined) scopes.push({ pages: [focusPage], panelN: ctx.panelN });
      if (focusPage) scopes.push({ pages: [focusPage] });
      if (!(isPlural && !narrowing(r))) {
        if (recent.length) scopes.push({ pages: recent });
      }
    }
    // A bare plural ("these", "all of them") never widens to the whole comic.
    if (!(isPlural && !narrowing(r))) scopes.push({ pages: doc.pages });
  }
  for (const scope of scopes) {
    const inScope = lineHits(doc, scope.pages).filter((h) => scope.panelN === undefined || h.panelN === scope.panelN);
    const hits = narrow(inScope);
    if (hits) return finish(doc, hits, isPlural, ctx);
  }

  // Nothing matched: say what exists.
  const pages = r.page !== undefined ? scopes[0]?.pages ?? [] : focusPage ? [focusPage] : doc.pages;
  const extra: string[] = [];
  if (speakerIds?.length === 1) {
    const theirs = all.filter((h) => h.speakerId === speakerIds![0]);
    const name = speakerName(doc, speakerIds[0]) ?? 'They';
    extra.push(theirs.length ? `${name} speaks on ${pageRange(theirs.map((h) => h.pageN))}` : `${name} has no lines yet`);
  }
  if (isPlural && !narrowing(r) && !selected.length) extra.push('select the balloons first, or say which ones (a speaker, a kind or a few words)');
  if (r.nth !== undefined && typeof r.nth === 'number') extra.push(`there aren't ${r.nth} of them`);
  return {
    status: 'none',
    note: `No ${describeRef(doc, r, speakerIds)} matched — nothing was changed. ${inventory(doc, pages)}.${extra.length ? ` ${extra.join('; ')}.` : ''}`
  };
}

// ── Asking ───────────────────────────────────────────────────────────────────

/** What the studio says and offers when a resolution does not apply (the deterministic question card). */
export interface ResolutionAsk {
  question: string;
  options?: OptionChoice[];
  followUps: NextStep[];
}

/** The question for a resolution that cannot apply as is (which / tap / confirm / none); undefined for `lines`. */
export function askForResolution(doc: ComicDoc, res: Resolution): ResolutionAsk | undefined {
  switch (res.status) {
    case 'lines':
      return undefined;
    case 'which':
      return { question: 'Which line?', options: whichLineChoices(doc, res.candidates), followUps: [] };
    case 'tap': {
      const page = doc.pages.find((p) => p.id === res.pageId);
      return {
        question: `That could be any of ${res.count} lines. Tap the balloon on the page, then say it again.`,
        followUps: page ? [{ label: `Open page ${page.n}`, client: { type: 'open_page', pageId: page.id } }] : []
      };
    }
    case 'confirm':
      return {
        question: `That changes ${plural(res.lines.length, 'line')} on ${plural(res.pages, 'page')}. Go ahead? It's free and undoable.`,
        followUps: [{ label: `Yes, all ${res.lines.length}`, say: `Yes, change all ${res.lines.length} of them.` }]
      };
    case 'none': {
      if (!isPronounResolution(res)) return { question: res.note, followUps: [] };
      const ids = [...new Set([...(res.among ?? []), ...doc.cast.map((c) => c.id)])];
      const names = ids.map((id) => speakerName(doc, id)).filter((n): n is string => !!n && !!n.trim());
      return { question: res.note, followUps: names.slice(0, 4).map((name) => ({ label: name, say: `I mean ${name}.` })) };
    }
  }
}
