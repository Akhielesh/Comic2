// Comic History — the pure view model of the History UI (versions plan §8; package H5).
//
// Everything the History components show that is not layout: time words in the viewer's zone, the actor words and
// icons, the money words of a row (governed users read usage, never dollars; own-key rows say "on your key"), the
// day groups, the filter chips, the scrubber's spoken value, what a whole-book restore would do (computed with the
// shared engine — restoreOps → history_restore → applyOps — never re-implemented here), the RestoreScope each
// "Use then" sends, the language status words, the undo-AI plan preview, the "Earlier (images only)" items of an
// older comic, and the no-git-words guard. No React, no network.

import { isPageStale, type ComicDoc, type Line, type Page } from '../../../shared/comic/doc';
import { editionProgress, i18nOf, translationStatus } from '../../../shared/comic/i18n';
import { languageSpec } from '../../../shared/comic/languages';
import { lockedModelId, lockedSpecId } from '../../../shared/comic/modelLock';
import { formatUsd } from '../../../shared/comic/models';
import { applyOps } from '../../../shared/comic/ops';
import { normalizeTimeZone } from '../../../shared/comic/events';
import {
  changedPageCount,
  diffBooks,
  drawnModelOf,
  historyRestoreOp,
  localParts,
  pageIdsOfKeys,
  pageRangeText,
  parseSectionKey,
  planUndoLastAi,
  restoreEffects,
  restoreOps,
  sectionChunks,
  semanticSectionContent,
  splitSections,
  dayGroupLabel,
  type ChangeGroup,
  type ChangeItem,
  type CompareSide,
  type HistoryActor,
  type RestorePart,
  type RestoreScope,
  type UndoAiDecision,
  type UndoAiPlan,
  type VersionRow
} from '../../../shared/comic/history/index';
import { HISTORY_LIMITS } from '../../../shared/comic/limits';
import { collectMedia, modelName, type MediaItem } from '../timeline/bookModel';
import type { HistoryFilter } from './historyApi';

// ── Copy that must never drift ───────────────────────────────────────────────

export const HISTORY_COPY = {
  title: 'History',
  subline: 'Saved automatically · Looking back and restoring are free',
  retention: 'Every change from the last 2 days, hourly for a week, daily for 3 months, weekly after that. Named versions are kept forever.',
  empty: 'History starts now. From here on, every change — yours or the AI’s — is saved automatically. Older drawings are still under each page’s versions.',
  free: 'Free — no AI.',
  saveFirst: 'Your book right now is saved first, so you can come back to it anytime.',
  namedForever: 'Named versions are kept forever.',
  readOnly: 'read-only',
  useThenFree: 'Taking back a piece is free and instant — no AI.',
  /** After a panel's "Use then" when its action, shot or cast changed: the drawing is still the newer one. */
  panelDrawing: 'The drawing still shows the newer panel.'
} as const;

/**
 * Words the creator must never read in History (versions plan §2): version control's jargon. HEAD only in capitals
 * (a "head" can be a character's); the rest in any case, as whole words.
 */
export const GIT_WORDS_RE = /\b(?:commit(?:s|ted|ting)?|branch(?:es|ed|ing)?|merg(?:e|es|ed|ing)|diff(?:s|ed|ing)?|checkout|check out|rebas(?:e|es|ed|ing)|revert(?:s|ed|ing)?|fork(?:s|ed|ing)?)\b|\bHEAD\b/i;
/** The case-sensitive HEAD check (GIT_WORDS_RE is case-insensitive for the rest). */
export const gitWordsIn = (text: string): string[] => {
  const out: string[] = [];
  const re = new RegExp(GIT_WORDS_RE.source.replace('|\\bHEAD\\b', ''), 'gi');
  for (const m of text.matchAll(re)) out.push(m[0]);
  for (const m of text.matchAll(/\bHEAD\b/g)) out.push(m[0]);
  return out;
};

// ── Time ─────────────────────────────────────────────────────────────────────

/** The viewer's IANA zone ('UTC' when the runtime can't tell). */
export const viewerTimeZone = (): string => {
  try {
    return normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC';
  } catch {
    return 'UTC';
  }
};

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const DAY_MS = 86_400_000;

/** '10:42' in the zone (tabular). */
export const clockText = (ms: number, tz: string): string => {
  const p = localParts(ms, tz);
  return `${pad(p.h)}:${pad(p.mi)}`;
};

/** "Tue 10:42" within the last week, else "27 Oct 10:42" (and the year when it is not this year). */
export const whenText = (ms: number, now: number, tz: string, long = false): string => {
  const p = localParts(ms, tz);
  const n = localParts(now, tz);
  const days = Math.round((Date.UTC(n.y, n.m - 1, n.d) - Date.UTC(p.y, p.m - 1, p.d)) / DAY_MS);
  const wd = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  const clock = `${pad(p.h)}:${pad(p.mi)}`;
  if (days >= 0 && days < 7) return `${(long ? WEEKDAY_LONG : WEEKDAY_SHORT)[wd]} ${clock}`;
  return `${p.d} ${MONTHS[p.m - 1]}${p.y !== n.y ? ` ${p.y}` : ''} ${clock}`;
};

/** "1 to 6" for a reader of the scrubber (en dashes are read as "minus" by some screen readers). */
const spokenRanges = (text: string): string => text.replace(/(\d)\s*–\s*(\d)/g, '$1 to $2');

/** The scrubber's aria-valuetext: "Tuesday 10:42, AI drew pages 1 to 6". */
export const scrubValueText = (row: Pick<VersionRow, 'contentAt' | 'label' | 'name'>, now: number, tz: string): string =>
  `${whenText(row.contentAt, now, tz, true)}, ${spokenRanges(row.name || row.label || 'a saved moment')}`;

/** Rows grouped Today / Yesterday / "Mon 27 Oct" (input newest first; group order kept). */
export const groupRowsByDay = (rows: readonly VersionRow[], now: number, tz: string): { label: string; rows: VersionRow[] }[] => {
  const out: { label: string; rows: VersionRow[] }[] = [];
  for (const row of rows) {
    const label = dayGroupLabel(row.contentAt, now, tz);
    const last = out[out.length - 1];
    if (last && last.label === label) last.rows.push(row);
    else out.push({ label, rows: [row] });
  }
  return out;
};

// ── Who and how much ─────────────────────────────────────────────────────────

export type ActorIcon = 'sparkles' | 'user' | 'wand' | 'history';
export const ACTOR_INFO: Readonly<Record<HistoryActor, { icon: ActorIcon; words: string }>> = {
  ai: { icon: 'sparkles', words: 'AI' },
  you: { icon: 'user', words: 'You' },
  editor: { icon: 'wand', words: 'Editor, no AI cost' },
  system: { icon: 'history', words: 'Saved automatically' }
};

/** The money words a viewer reads (conversation/cost.ts CostFormat subset). */
export interface MoneyWords {
  governed: boolean;
  exact(usd: number): string;
}

/**
 * What a moment cost, in the viewer's words: "Free" when nothing was spent; own-key spend "on your key" (with the
 * dollars only when the viewer reads dollars — a governed viewer never sees a $); included usage as a share.
 */
export const rowCostText = (row: Pick<VersionRow, 'stats'>, money: MoneyWords): string => {
  const spend = row.stats?.spend;
  const usd = spend && Number.isFinite(spend.usd) ? spend.usd : 0;
  if (!spend || usd <= 0) return 'Free';
  if (spend.byok) return money.governed ? 'on your key' : `${formatUsd(usd)} · on your key`;
  const words = money.exact(usd);
  return spend.estimated && !money.governed ? `about ${words}` : words;
};

/** The page numbers a row's changes name. */
export const rowPageNs = (row: Pick<VersionRow, 'changes'>): number[] => [...new Set((row.changes || []).flatMap((c) => c.pageNs || []))].sort((a, b) => a - b);

/** "10:42 · pages 3–4 · Free". */
export const rowMetaText = (row: VersionRow, money: MoneyWords, tz: string): string => {
  const ns = rowPageNs(row);
  return [clockText(row.contentAt, tz), ns.length ? pageRangeText(ns) : '', rowCostText(row, money)].filter(Boolean).join(' · ');
};

// ── Filters ──────────────────────────────────────────────────────────────────

export const FILTER_LABEL: Readonly<Record<HistoryFilter, string>> = { all: 'All', saved: 'Saved by you', ai: 'AI changes', page: 'This page' };

/** Saved by you = a named version (or one you named later). */
export const isSavedByYou = (row: VersionRow): boolean => row.kind === 'named' || !!row.name;
export const isAiRow = (row: VersionRow): boolean => row.kind === 'ai' || row.kind === 'before_ai' || row.actor === 'ai';
export const touchesPage = (row: VersionRow, pageId: string): boolean =>
  (row.changes || []).some((c) => (c.pageIds || []).includes(pageId) || c.key === `page:${pageId}` || c.key === `art:${pageId}`);

/** The client side of a filter (rows that arrive live are filtered the same way the server filters a page). */
export const filterRows = (rows: readonly VersionRow[], filter: HistoryFilter, pageId?: string | null): VersionRow[] => {
  if (filter === 'saved') return rows.filter(isSavedByYou);
  if (filter === 'ai') return rows.filter(isAiRow);
  if (filter === 'page' && pageId) return rows.filter((r) => touchesPage(r, pageId));
  return rows.slice();
};

/** Merge a live row (the `history` event) into a newest-first list: replaces the same id, else goes first. */
export const mergeLiveRow = (rows: readonly VersionRow[], row: VersionRow): VersionRow[] => {
  const i = rows.findIndex((r) => r.id === row.id);
  if (i >= 0) return rows.map((r, k) => (k === i ? row : r));
  return [row, ...rows].sort((a, b) => b.contentAt - a.contentAt || b.createdAt - a.createdAt);
};

/** "Draft n" for the Save sheet (one more than the named versions so far). */
export const nextDraftName = (rows: readonly VersionRow[]): string => {
  let n = rows.filter((r) => r.kind === 'named').length;
  for (const r of rows) {
    const m = /^Draft (\d+)\b/.exec(r.name || '');
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `Draft ${n + 1}`;
};

// ── The filmstrip of a moment ────────────────────────────────────────────────

export interface FilmFrame {
  key: string;
  label: string;
  path?: string;
  /** "Changed" / "New" (word + icon), else none. */
  mark?: 'changed' | 'new';
  pageId?: string;
}

const nFromChanges = (changes: readonly ChangeItem[], pageId: string): number | undefined => {
  for (const c of changes) {
    const i = (c.pageIds || []).indexOf(pageId);
    if (i >= 0 && c.pageNs?.[i]) return c.pageNs[i];
  }
  return undefined;
};

/** Cover + pages of a moment from its thumbs (≤ thumbsPerRow), marked from its changes. */
export const filmFrames = (row: VersionRow, doc?: Pick<ComicDoc, 'pages'> | null): FilmFrame[] => {
  const added = new Set<string>();
  const changed = new Set<string>();
  for (const c of row.changes || []) {
    if (c.what === 'pages_moved' || c.what === 'pages_removed') continue;
    for (const id of c.pageIds || []) (c.what === 'pages_added' ? added : changed).add(id);
  }
  const coverChanged = (row.changes || []).some((c) => c.what === 'cover');
  const frames: FilmFrame[] = [];
  for (const t of (row.thumbs || []).slice(0, HISTORY_LIMITS.thumbsPerRow)) {
    if (t.key === 'cover') {
      frames.push({ key: 'cover', label: 'Cover', path: t.path, ...(coverChanged ? { mark: 'changed' as const } : {}) });
      continue;
    }
    const pageId = t.key.startsWith('page:') ? t.key.slice(5) : t.key;
    const n = doc?.pages.find((p) => p.id === pageId)?.n ?? nFromChanges(row.changes || [], pageId);
    frames.push({
      key: t.key,
      pageId,
      label: n ? `Page ${n}` : 'Page',
      path: t.path,
      ...(added.has(pageId) ? { mark: 'new' as const } : changed.has(pageId) ? { mark: 'changed' as const } : {})
    });
  }
  return frames;
};

/** A client-side "What changed" when the detail route has none (from the row's own change items). */
export const changeGroupsOf = (changes: readonly ChangeItem[]): ChangeGroup[] => {
  const byPage = new Map<string, { n?: number; lines: string[] }>();
  const other: ChangeGroup[] = [];
  const page = (id: string, n?: number) => {
    const g = byPage.get(id) || { n, lines: [] };
    if (n && !g.n) g.n = n;
    byPage.set(id, g);
    return g;
  };
  for (const c of changes) {
    const id = c.pageIds?.[0];
    const n = c.pageNs?.[0];
    if (c.what === 'dialogue' && id) page(id, n).lines.push(`Dialogue: ${c.count ?? c.lineIds?.length ?? 0} ${(c.count ?? c.lineIds?.length ?? 0) === 1 ? 'line' : 'lines'}`);
    else if ((c.what === 'panels' || c.what === 'page_text') && id) page(id, n).lines.push('Panels and words');
    else if (c.what === 'art' && id) page(id, n).lines.push('Art: redrawn');
    else if (c.what === 'balloons' && id) page(id, n).lines.push('Balloons moved');
    else if (c.what === 'pages_added' && id) page(id, n).lines.push('New page');
    else if (c.what === 'pages_removed' && id) page(id, n).lines.push('Moved to Deleted');
    else if (c.what === 'translation' && c.lang) {
      const name = languageSpec(c.lang)?.english || c.lang;
      const count = c.count ?? c.lineIds?.length ?? 0;
      other.push({ key: `ed:${c.lang}`, title: name, lang: c.lang, lines: [count ? `${count} ${count === 1 ? 'line' : 'lines'} changed` : 'Edition updated'] });
    } else if (c.what === 'character') other.push({ key: `char:${c.id}`, title: c.name || 'A character', lines: ['Look or voice changed'] });
    else if (c.what === 'place') other.push({ key: `place:${c.id}`, title: c.name || 'A place', lines: ['Changed'] });
    else if (c.what === 'cover') other.push({ key: 'cover', title: 'Cover', lines: ['Changed'] });
    else if (c.what === 'style' || c.what === 'option') other.push({ key: 'style', title: 'Style', lines: ['Changed'] });
    else if (c.what === 'script') other.push({ key: 'source', title: 'Script', lines: ['Changed'] });
    else if (c.what === 'pages_moved') other.push({ key: 'order', title: 'Page order', lines: ['Pages were reordered'] });
    else if (c.what === 'model') other.push({ key: 'model', title: 'Image model', lines: ['Switched'] });
    else if (c.what === 'details' || c.what === 'glossary') other.push({ key: 'meta', title: 'Story details', lines: ['Changed'] });
  }
  const pages: ChangeGroup[] = [...byPage.entries()]
    .sort((a, b) => (a[1].n ?? 1e9) - (b[1].n ?? 1e9))
    .map(([id, g]) => ({ key: `page:${id}`, pageId: id, title: g.n ? `Page ${g.n}` : 'A page', lines: [...new Set(g.lines)] }));
  const seen = new Set<string>();
  return [...pages, ...other.filter((g) => (seen.has(g.key) ? false : (seen.add(g.key), true)))];
};

// ── "Use then": the RestoreScope each control sends (§6.3) ───────────────────

export const lineScope = (pageId: string, lineId: string): RestoreScope => ({ kind: 'line', pageId, lineId });
export const panelScope = (pageId: string, panelId: string): RestoreScope => ({ kind: 'panel', pageId, panelId });
/** A page deleted since comes back where it was ('replace' re-inserts it); a page that only exists then is inserted. */
export const pageScope = (pageId: string, part: RestorePart, live?: Pick<ComicDoc, 'pages'> | null): RestoreScope => ({
  kind: 'page',
  pageId,
  mode: live && !live.pages.some((p) => p.id === pageId) ? 'insert' : 'replace',
  part
});
export const languageScope = (lang: string): RestoreScope => ({ kind: 'language', lang });

/**
 * What the creator may want next after a piece came back (§6.3 Panel): the panel's action, shot or cast came back
 * but the page's drawing is still the newer one — offer the earlier drawing (free) or a quoted redraw.
 */
export interface RestoreFollowUp {
  kind: 'panel_drawing';
  pageId: string;
  pageN?: number;
}

/** Panel fields the drawing shows: when one of these comes back, the newer drawing no longer matches the panel. */
export const DRAWN_PANEL_FIELDS: ReadonlySet<string> = new Set(['action', 'shot', 'castIds']);

/** "Page 3 restored from Tue 10:42" — the toast after a partial "Use then". */
export const restoredText = (scope: RestoreScope, at: string, doc?: Pick<ComicDoc, 'pages'> | null): string => {
  const n = (id: string) => doc?.pages.find((p) => p.id === id)?.n;
  switch (scope.kind) {
    case 'book':
      return `Restored to ${at}`;
    case 'page':
      return `Page ${n(scope.pageId) ?? ''}${scope.part === 'text' ? ' words' : scope.part === 'art' ? ' art' : ''} restored from ${at}`.replace('Page  ', 'The page ');
    case 'panel':
      return `Panel restored from ${at}`;
    case 'line':
      return `Line restored from ${at}`;
    case 'language':
      return `${languageSpec(scope.lang)?.english || scope.lang} restored from ${at}`;
    default:
      return `Restored from ${at}`;
  }
};

// ── What a piece taken back would put "Out of date" (§6.3: listed first, then confirmed) ─────

/** Scopes whose restore can change the spec of pages it does not name (a look, a place, the style…). */
export const STALE_CHECK_SCOPES: ReadonlySet<RestoreScope['kind']> = new Set(['character', 'place', 'style', 'cover', 'script']);

/**
 * The page numbers a restore of `scope` from `version` would newly show "Out of date" (fresh now, stale after),
 * computed with the shared engine — the same restoreOps + history_restore + applyOps the server commits. null when
 * it can't be worked out (the caller then asks anyway). Pages already out of date are not listed again.
 */
export const staleImpact = (live: ComicDoc, version: ComicDoc, scope: RestoreScope, versionId: string, now = Date.now()): number[] | null => {
  try {
    const after = applyOps(live, [historyRestoreOp(restoreOps(live, version, scope), { versionId, at: now })], now);
    const ns: number[] = [];
    for (const p of live.pages) {
      if (isPageStale(live, p)) continue;
      const q = after.pages.find((x) => x.id === p.id);
      if (q && isPageStale(after, q)) ns.push(q.n);
    }
    return ns.sort((a, b) => a - b);
  } catch {
    return null;
  }
};

/** "Maya" · "the earlier style" — what a whole-piece "Use then" brings back, in words. */
export const scopeThing = (scope: RestoreScope, ...docs: (Pick<ComicDoc, 'cast' | 'places'> | null | undefined)[]): string => {
  switch (scope.kind) {
    case 'character':
      return docs.map((d) => d?.cast.find((c) => c.id === scope.id)?.name).find(Boolean) || 'this character';
    case 'place':
      return docs.map((d) => d?.places.find((p) => p.id === scope.id)?.name).find(Boolean) || 'this place';
    case 'style':
      return 'the earlier style';
    case 'cover':
      return 'the earlier cover';
    case 'script':
      return 'the earlier script';
    default:
      return 'it';
  }
};

/**
 * The confirm before a piece that would put pages out of date: "Pages 2 and 4 will show Out of date until redrawn.
 * Bring Maya back anyway?" (ns null: "Some pages may show…").
 */
export const staleConfirmText = (ns: readonly number[] | null, thing: string): string => {
  const pages = ns === null ? 'Some pages may show' : `${capitalize(pageRangeText(ns))} will show`;
  return `${pages} Out of date until redrawn. Bring ${thing} back anyway?`;
};

// ── Compare sides ────────────────────────────────────────────────────────────

/** "Now" · "Published" · "Draft 2" · "Tue 10:42". */
export const sideLabel = (side: CompareSide | undefined, now: number, tz: string): string => {
  if (!side) return '';
  if (side.kind === 'now') return 'Now';
  if (side.kind === 'published') return 'Published';
  if (side.row) return side.row.name || whenText(side.row.contentAt, now, tz);
  return 'Then';
};

/** The saved moment "Use then" restores from (a version id, or the row behind 'published' / 'alt:'). */
export const restorableId = (side: CompareSide | undefined): string | null => {
  if (!side) return null;
  if (side.kind === 'version') return side.row?.id ?? side.ref;
  return side.row?.id ?? null;
};

// ── Languages ────────────────────────────────────────────────────────────────

/** The source language plus every edition either side has (chip order: source, then by code). */
export const languageChips = (a: ComicDoc, b: ComicDoc): { lang: string; label: string; source: boolean }[] => {
  const source = b.format.language || a.format.language || 'en';
  const langs = [...new Set([...Object.keys(i18nOf(a).editions), ...Object.keys(i18nOf(b).editions)])].filter((l) => l !== source).sort();
  const name = (l: string) => languageSpec(l)?.english || l;
  return [{ lang: source, label: name(source), source: true }, ...langs.map((l) => ({ lang: l, label: name(l), source: false }))];
};

/** "AI translation" · "Reviewed" · "You edited" · "Needs update" · "Not translated" (derived from sourceHash). */
export const lineLanguageStatus = (doc: ComicDoc, lang: string, line: Line): string | null => {
  const s = translationStatus(doc, lang, line);
  switch (s) {
    case 'machine':
      return 'AI translation';
    case 'reviewed':
      return 'Reviewed';
    case 'edited':
      return 'You edited';
    case 'stale':
    case 'stale_edited':
      return 'Needs update';
    case 'missing':
      return 'Not translated';
    default:
      return null;
  }
};

/** A line's text in a language (the edition's translation, else the source). */
export const lineTextIn = (doc: ComicDoc, lang: string, line: Line): string => {
  if (lang === doc.format.language) return line.text;
  return i18nOf(doc).editions[lang]?.lines[line.id]?.text ?? line.text;
};

// ── The whole-book restore sheet (§8 "Restore sheet") ─────────────────────────

export interface RestorePreview {
  /** "3 pages change", "1 page added since goes to Deleted", "Cover stays", "Telugu kept (12 lines will need updating)", "Image model stays Nano Banana 2.1". */
  lines: string[];
  pagesChanged: number;
  pagesToDeleted: number;
  editionsKept: string[];
  /** The model notice when the restored art was drawn with another model than the lock. */
  modelNotice?: string;
}

const pagesWord = (n: number) => `${n} ${n === 1 ? 'page' : 'pages'}`;
const langName = (l: string) => languageSpec(l)?.english || l;

/**
 * What restoring the whole book to `version` would do to `live`, computed with the shared engine (the same
 * restoreOps + history_restore + applyOps the server commits; server-side image filtering can only hold images back,
 * and the server says so after).
 */
export const restorePreview = (live: ComicDoc, version: ComicDoc, versionId: string, now = Date.now()): RestorePreview => {
  const set = restoreOps(live, version, { kind: 'book' });
  const after = applyOps(live, [historyRestoreOp(set, { versionId, at: now })], now);
  const diff = diffBooks(live, after);
  const effects = restoreEffects(live, version);
  const lines: string[] = [];
  // Pages that change in place: not the ones going to Deleted, not the ones coming back (each has its own line).
  const changed = diff.pages.filter((p) => p.status === 'changed' && !effects.pagesToDeleted.includes(p.pageId)).length;
  const pagesChanged = changedPageCount(diff);
  const moved = diff.pages.filter((p) => p.status === 'moved').length;
  const back = diff.pages.filter((p) => p.status === 'added').length;
  if (changed) lines.push(`${pagesWord(changed)} ${changed === 1 ? 'changes' : 'change'}`);
  else if (!moved && !back && !effects.pagesToDeleted.length) lines.push('No page changes');
  if (moved) lines.push(`${pagesWord(moved)} move back to ${moved === 1 ? 'its' : 'their'} earlier place`);
  if (effects.pagesToDeleted.length) lines.push(`${pagesWord(effects.pagesToDeleted.length)} added since ${effects.pagesToDeleted.length === 1 ? 'goes' : 'go'} to Deleted`);
  if (back) lines.push(`${pagesWord(back)} ${back === 1 ? 'comes' : 'come'} back`);
  lines.push(diff.cover.text || diff.cover.art ? 'Cover changes' : 'Cover stays');
  const liveEditions = Object.keys(i18nOf(live).editions).sort();
  const editionsKept: string[] = [];
  for (const lang of liveEditions) {
    editionsKept.push(lang);
    const p = editionProgress(after, lang);
    // Lines whose source changed under their translation (never-translated lines are not "updating").
    const stale = p.stale + p.staleEdited;
    lines.push(`${langName(lang)} kept${stale ? ` (${stale} ${stale === 1 ? 'line' : 'lines'} will need updating)` : ''}`);
  }
  for (const lang of Object.keys(i18nOf(after).editions).filter((l) => !liveEditions.includes(l)).sort()) lines.push(`${langName(lang)} comes back`);
  if (effects.keptCast.length) {
    const names = effects.keptCast.map((id) => live.cast.find((c) => c.id === id)?.name || 'a character');
    lines.push(`Kept: ${names.join(', ')} (added since)`);
  }
  if (effects.keptPlaces.length) lines.push(`${effects.keptPlaces.length === 1 ? '1 place' : `${effects.keptPlaces.length} places`} added since ${effects.keptPlaces.length === 1 ? 'stays' : 'stay'}`);
  const lock = lockedModelId(live);
  const lockName = lock ? modelName(lock) || lock : undefined;
  lines.push(lockName ? `Image model stays ${lockName}` : 'Image model stays as it is');
  const drawn = drawnModelOf(version);
  let modelNotice: string | undefined;
  // Compared as registry entries: older assets may name the same model by a provider route id.
  if (lock && drawn && lockedSpecId(drawn) !== lockedSpecId(lock)) {
    const drawnSpec = lockedSpecId(drawn);
    const drawnPages = version.pages.filter((p) => p.render.asset && lockedSpecId(p.render.asset.model || p.render.model || '') === drawnSpec).map((p) => p.n);
    modelNotice = `${drawnPages.length ? `${capitalize(pageRangeText(drawnPages))} were` : 'Some pages were'} drawn with ${modelName(drawn) || drawn}; this comic now draws with ${lockName}. New drawings use ${lockName}.`;
  }
  return { lines, pagesChanged, pagesToDeleted: effects.pagesToDeleted.length, editionsKept, ...(modelNotice ? { modelNotice } : {}) };
};

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ── "Undo the last AI change" preview (§6.4; the server re-plans authoritatively) ───

/** key → content after the semantic filter (QC, size variants and safety verdicts are not changes). */
export const semanticSignatures = (doc: ComicDoc): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const c of sectionChunks(splitSections(doc))) out[c.key] = semanticSectionContent(c.body);
  return out;
};

export interface UndoAiPreview {
  plan: UndoAiPlan;
  /**
   * Conflicts grouped by page ("You've changed page 3 since."), each with its question (§6.4): "You've changed page 3
   * since. Undo the AI's change only on pages 4–5, or on page 3 too?"
   */
  conflicts: { key: string; keys: string[]; title: string; question: string; pageId?: string; n?: number }[];
  /** "pages 4–5" the undo reverts without asking. */
  revertText: string;
}

const PART_WORDS: Readonly<Record<string, string>> = { page: 'words', art: 'drawing', edp: 'translation' };
/** "words" / "drawing" / "translation" when every key is that part of a page, else undefined. */
const partWord = (keys: readonly string[]): string | undefined => {
  const words = new Set(keys.map((k) => PART_WORDS[parseSectionKey(k)?.kind ?? '']));
  return words.size === 1 ? [...words][0] : undefined;
};

/** The three-way plan of P (before the AI), R (the AI's result) and live, with conflicts worded per page. */
export const undoAiPreview = (P: ComicDoc, R: ComicDoc, live: ComicDoc, decisions: Readonly<Record<string, UndoAiDecision>> = {}): UndoAiPreview => {
  const plan = planUndoLastAi(semanticSignatures(P), semanticSignatures(R), semanticSignatures(live), decisions);
  const nOf = (id: string) => live.pages.find((p) => p.id === id)?.n ?? R.pages.find((p) => p.id === id)?.n;
  const groups = new Map<string, { keys: string[]; pageId?: string }>();
  for (const k of plan.conflicts) {
    const pageId = pageIdsOfKeys([k])[0];
    const g = groups.get(pageId ?? k) || { keys: [], ...(pageId ? { pageId } : {}) };
    g.keys.push(k);
    groups.set(pageId ?? k, g);
  }
  const revertNs = pageIdsOfKeys(plan.revert).map(nOf).filter((n): n is number => !!n);
  const conflicts = [...groups.entries()].map(([key, g]) => {
    const n = g.pageId ? nOf(g.pageId) : undefined;
    const title = g.pageId ? `You've changed page ${n ?? ''} since.`.replace('page  ', 'this page ') : 'You changed this since.';
    // §6.4: "Undo the AI's change only on pages 4–5, or on page 3 too?" — the pages taken back without asking, other
    // than this one; when part of this page goes back anyway (its drawing, say), that part is named too.
    const others = revertNs.filter((x) => x !== n);
    const ownReverted = g.pageId ? plan.revert.filter((k) => pageIdsOfKeys([k])[0] === g.pageId) : [];
    const ownPart = ownReverted.length ? partWord(ownReverted) ?? 'other changes' : undefined;
    const askedPart = ownPart ? partWord(g.keys) : undefined;
    const lead = others.length ? `${pageRangeText(others)}${ownPart && n ? ` (and page ${n}’s ${ownPart})` : ''}` : ownPart && n ? `page ${n}’s ${ownPart}` : '';
    const target = n ? (askedPart ? `on page ${n}’s ${askedPart}` : `on page ${n}`) : 'here';
    const question = lead ? `${title} Undo the AI’s change only on ${lead}, or ${target} too?` : `${title} Undo the AI’s change ${target} too?`;
    return { key, keys: g.keys, title, question, ...(g.pageId ? { pageId: g.pageId } : {}), ...(n ? { n } : {}) };
  });
  return { plan, conflicts, revertText: revertNs.length ? pageRangeText(revertNs) : plan.revert.length ? 'the rest' : '' };
};

// ── "Earlier (images only)" for comics older than History (§8, §11) ──────────

export interface EarlierGroup {
  label: string;
  items: MediaItem[];
}

const EARLIER_ROLES: ReadonlySet<MediaItem['role']> = new Set(['page', 'cover', 'sheet', 'place', 'style_option', 'deleted_page']);

/**
 * The drawings an older comic already holds (every version and archived image, from AssetRef.at), older than the
 * moment History started — newest first, by day. A missing date reads "Date not recorded". (Shared derivation:
 * shared/comic/history/earlier.ts, H6a, replaces this adapter when it lands — see the wave notes.)
 */
export const earlierImageGroups = (doc: ComicDoc, startedAt: number | null, now: number, tz: string): EarlierGroup[] => {
  const items = collectMedia(doc).filter((m) => EARLIER_ROLES.has(m.role) && !m.current && !m.blocked && (startedAt === null || !(m.at > 0) || m.at < startedAt));
  items.sort((a, b) => (b.at || 0) - (a.at || 0) || a.owner.order - b.owner.order);
  const out: EarlierGroup[] = [];
  for (const item of items) {
    const label = item.at > 0 ? dayGroupLabel(item.at, now, tz) : 'Date not recorded';
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(item);
    else out.push({ label, items: [item] });
  }
  return out;
};

/** "Only drawings were recorded before 29 Oct." */
export const earlierNote = (startedAt: number | null, tz: string): string => {
  if (!startedAt) return 'Only drawings were recorded before History started.';
  const p = localParts(startedAt, tz);
  return `Only drawings were recorded before ${p.d} ${MONTHS[p.m - 1]}.`;
};

// ── Small helpers ────────────────────────────────────────────────────────────

export const pageById = (doc: ComicDoc | null | undefined, id?: string | null): Page | undefined => (doc && id ? doc.pages.find((p) => p.id === id) : undefined);

/** The oldest `start` row of a list, when History started inside it. */
export const startRowOf = (rows: readonly VersionRow[]): VersionRow | undefined => [...rows].reverse().find((r) => r.kind === 'start');

/** The `import` row that links this comic to its classic project's snapshots. */
export const classicSourceOf = (rows: readonly VersionRow[]): string | undefined => rows.find((r) => r.kind === 'import' && r.legacy?.projectId)?.legacy?.projectId;
