// The conflict guard: the creator's edit wins (agent-editor plan §3 A3.1, owner decision D3). Filled by wave 1 A3
// CONFLICT; wave 2 (B-TOOL) calls it from every director tool that writes a line, a balloon or a style.
//
// A director tool that writes a line, a balloon or a style first asks guardUserEdits which of its planned ops touch an
// entity (shared/comic/conflicts.ts entityKeys) the creator committed (origin 'user') after the turn's startRev
// (session.recentCommits). It applies the allowed part, tells the model "Conflict: … so I left it", and records the
// blocked part on turn.conflicts; after the loop, conflictCardFor turns those into ONE conflict card. Free; no model call.
//
// Off (caps.liveAgent.conflicts false, COMIC_CONFLICT_GUARD) the guard allows everything, exactly as before. Ops are
// split as finely as their entities allow: a restyle of five lines where the creator restyled one applies to the other
// four, and a page-wide balloon layout keeps the creator's balloon where they put it while every other balloon moves.

import { CONFLICT_LIMITS, findCharacter, findPage, letterStyleOf, newId, normalizeConflictCard, type Balloon, type ComicDoc, type ConflictCard, type ConflictItem, type ConflictWhere, type Line, type LineKind, type Page, type Panel } from '../../../shared/comic/doc.js';
import { conflictGuardOn } from '../../../shared/comic/capabilities.js';
import { entityKeys, keysCollide, type EntityKey } from '../../../shared/comic/conflicts.js';
import { LETTERING_PRESETS, type LetterStylePatch } from '../../../shared/comic/lettering/style.js';
import { CLIENT_PATCHABLE_OPS, type DocOp } from '../../../shared/comic/ops.js';
import { logger } from '../lib/logger.js';
import { recentCommitsOf } from './session.js';
import type { DirectorTurn } from './tools.js';
import type { StudioContext } from './types.js';

/** Director ops held back because the creator changed the same entity mid-turn. `mine` = the creator's current version. */
export interface BlockedEdit {
  where: ConflictWhere;
  mine: string;
  theirs: string;
  proposed: DocOp[];
}

/** What a tool may commit now, and what it must leave for the conflict card. */
export interface GuardResult {
  allowed: DocOp[];
  blocked: BlockedEdit[];
}

// ── Reading the doc ──────────────────────────────────────────────────────────

interface LineAt {
  page: Page;
  panel: Panel;
  line: Line;
  /** 0-based index of the line in its panel. */
  index: number;
}

/** Where a line is now (any page, any panel), or undefined once it was deleted. */
export const locateLine = (doc: ComicDoc, lineId: string): LineAt | undefined => {
  for (const page of doc.pages) {
    for (const panel of page.panels) {
      const index = panel.lines.findIndex((l) => l.id === lineId);
      if (index >= 0) return { page, panel, line: panel.lines[index], index };
    }
  }
  return undefined;
};

const clip = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};

const KIND_WORD: Record<LineKind, string> = {
  speech: 'speech',
  thought: 'a thought',
  whisper: 'a whisper',
  shout: 'a shout',
  caption: 'a caption',
  sfx: 'a sound effect'
};
const kindWord = (kind: unknown): string => (typeof kind === 'string' && kind in KIND_WORD ? KIND_WORD[kind as LineKind] : 'a line');

/** "the top left of the page" for a balloon box (its top-centre, in thirds of the page). */
const balloonSpot = (b: Pick<Balloon, 'x' | 'y' | 'w'>): string => {
  const third = (v: number) => Math.max(0, Math.min(2, Math.floor(v * 3)));
  const col = third(b.x + b.w / 2);
  const row = third(b.y + 0.03);
  const v = ['top', 'middle', 'bottom'][row];
  const h = ['left', '', 'right'][col];
  if (row === 1 && col === 1) return 'the middle of the page';
  return `the ${[v === 'middle' ? '' : v, h].filter(Boolean).join(' ') || v} of the page`;
};

const STYLE_WORDS: Record<string, string> = {
  font: 'font',
  sizeScale: 'size',
  weight: 'weight',
  italic: 'italic',
  textCase: 'case',
  letterSpacing: 'spacing',
  lineHeight: 'line height',
  align: 'alignment',
  textColor: 'text colour',
  textStroke: 'outline',
  shadow: 'shadow',
  fill: 'fill',
  border: 'border',
  borderWidth: 'border',
  borderStyle: 'border',
  shape: 'shape',
  tail: 'tail',
  tailWidth: 'tail',
  padding: 'padding',
  rotate: 'tilt',
  sfxEffect: 'effect',
  arc: 'arc'
};

/** "font, size and text colour" for a style patch (the first four things it changes). */
export const styleWords = (patch: unknown): string => {
  if (!patch || typeof patch !== 'object') return 'its look';
  const words = [...new Set(Object.keys(patch).map((k) => STYLE_WORDS[k]).filter(Boolean))];
  if (!words.length) return 'its look';
  const shown = words.slice(0, 4);
  const more = words.length - shown.length;
  const list = more > 0 ? [...shown, `${more} more`] : shown;
  return list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
};

const nameOf = (doc: ComicDoc, id?: string): string => (id ? findCharacter(doc, id)?.name || 'someone' : '');

// ── Grouping the held-back ops into card items ───────────────────────────────

interface HeldOp {
  op: DocOp;
  /** One item per entity: `line:<id>`, `panel:<id>`, `page:<id>`, `letter`, `plan`. */
  group: string;
}

/** The group (card item) a held-back op belongs to. */
const groupOf = (op: DocOp): string => {
  switch (op.op) {
    case 'line':
    case 'line_move':
      return `line:${op.id}`;
    case 'balloon':
      return `line:${op.lineId}`;
    case 'line_style':
      return op.lineIds.length === 1 ? `line:${op.lineIds[0]}` : `page:${op.pageId}`;
    case 'letter_style':
      return 'letter';
    case 'panel':
    case 'panel_remove':
      return `panel:${op.id}`;
    case 'panel_add':
      return `panel:${op.panel?.id ?? op.pageId}`;
    case 'page_panels':
      return `page:${op.id}`;
    case 'balloons':
      return `page:${op.pageId}`;
    case 'pages':
      return 'plan';
    default:
      return `op:${op.op}`;
  }
};

/** A line's place in words: "page 2 · panel 1 · line 2". */
const lineLabel = (at: LineAt): string => `page ${at.page.n} · panel ${at.panel.n} · line ${at.index + 1}`;

/** The pageId a held-back op names (for "Show me" when the entity itself is gone). */
const pageIdOf = (op: DocOp): string | undefined => {
  const o = op as unknown as { pageId?: unknown; id?: unknown; op: string };
  if (typeof o.pageId === 'string') return o.pageId;
  if (o.op === 'page_panels' && typeof o.id === 'string') return o.id;
  return undefined;
};

type LineOp = Extract<DocOp, { op: 'line' }>;

/**
 * A line the director wanted to ADD (edit_panel_text: a `line` op with an index and a patch) into a panel whose order
 * the creator changed mid-turn. The creator removed nothing: the item says what the director would have added.
 */
function addedLineItem(doc: ComicDoc, lineId: string, ops: DocOp[], add: LineOp): BlockedEdit {
  const page = findPage(doc, add.pageId);
  const panel = page?.panels.find((p) => p.id === add.panelId);
  let text = '';
  let kind: LineKind | undefined;
  for (const op of ops) {
    if (op.op !== 'line' || !op.patch) continue;
    if (typeof op.patch.text === 'string') text = op.patch.text;
    if (op.patch.kind) kind = op.patch.kind;
  }
  const label = page && panel ? `page ${page.n} · panel ${panel.n} · a new line` : page ? `page ${page.n} · a new line` : 'a new line';
  return {
    where: { ...(page ? { pageId: page.id } : {}), ...(panel ? { panelId: panel.id } : {}), lineId, label },
    mine: panel ? 'Your order of the lines in this panel.' : 'You removed this panel.',
    theirs: `Add “${clip(text, 120)}”${kind ? `, as ${kindWord(kind)}` : ''}.`,
    proposed: ops
  };
}

/** One line's item: where it is now, the creator's current version and what the director would have made of it. */
function lineItem(doc: ComicDoc, lineId: string, ops: DocOp[]): BlockedEdit {
  const at = locateLine(doc, lineId);
  const add = at ? undefined : ops.find((op): op is LineOp => op.op === 'line' && typeof op.index === 'number' && op.patch !== null);
  if (add) return addedLineItem(doc, lineId, ops, add);
  const pageId = at?.page.id ?? ops.map(pageIdOf).find(Boolean);
  const page = pageId ? findPage(doc, pageId) : undefined;
  const where: ConflictWhere = {
    ...(pageId ? { pageId } : {}),
    ...(at ? { panelId: at.panel.id } : {}),
    lineId,
    label: at ? lineLabel(at) : page ? `page ${page.n} · a line you removed` : 'a line you removed'
  };
  // What the director's ops change, folded in order.
  let text: string | undefined;
  let kind: LineKind | undefined;
  let speaker: string | null | undefined;
  let removed = false;
  let toPanel: string | undefined;
  let toIndex: number | undefined;
  let balloon: Partial<Balloon> | undefined;
  let style: LetterStylePatch | null | undefined;
  for (const op of ops) {
    if (op.op === 'line') {
      if (op.patch === null) removed = true;
      else {
        if (typeof op.patch.text === 'string') text = op.patch.text;
        if (op.patch.kind) kind = op.patch.kind;
        if ('speakerId' in op.patch) speaker = op.patch.speakerId ?? null;
        if (op.patch.style !== undefined) style = op.patch.style ?? null;
      }
    } else if (op.op === 'line_move') {
      toPanel = op.toPanelId;
      toIndex = op.index;
    }
    else if (op.op === 'balloon') balloon = { ...(balloon || {}), ...op.patch };
    else if (op.op === 'line_style') style = op.patch;
  }
  const line = at?.line;
  const current = line ? clip(line.text, CONFLICT_LIMITS.textChars) : '';
  const wordsOnly = text !== undefined && kind === undefined && speaker === undefined && !toPanel && !balloon && style === undefined && !removed;

  // Yours: the creator's current version of what collided.
  let mine: string;
  if (!line) mine = 'You removed this line.';
  else if (wordsOnly) mine = current;
  else {
    const parts = [`“${clip(line.text, 120)}”`];
    if (kind !== undefined) parts.push(`as ${kindWord(line.kind)}`);
    if (speaker !== undefined) parts.push(line.speakerId ? `said by ${nameOf(doc, line.speakerId)}` : 'with no speaker');
    if (toPanel) {
      // A move inside the same panel only changes the order, so name the line's place in it.
      const k = at!.panel.lines.findIndex((l) => l.id === lineId) + 1;
      parts.push(toPanel === at!.panel.id && k > 0 ? `line ${k} of panel ${at!.panel.n}` : `in panel ${at!.panel.n}`);
    }
    const placed = at!.page.balloons.find((b) => b.lineId === lineId);
    if (balloon) parts.push(placed ? `balloon where you put it, at ${balloonSpot(placed)}` : 'balloon placed automatically');
    if (style !== undefined) parts.push(line.style && Object.keys(line.style).length ? `your look (${styleWords(line.style)})` : 'the comic’s usual look');
    mine = parts.join(', ');
  }

  // The director's: the same line as its ops would have left it.
  let theirs: string;
  if (removed) theirs = 'Remove this line.';
  else if (wordsOnly) theirs = clip(text!, CONFLICT_LIMITS.textChars);
  else {
    const parts = [`“${clip(text ?? line?.text ?? '', 120)}”`];
    if (kind !== undefined) parts.push(`as ${kindWord(kind)}`);
    if (speaker !== undefined) parts.push(speaker ? `said by ${nameOf(doc, speaker)}` : 'with no speaker');
    if (toPanel) {
      const panel = at?.page.panels.find((p) => p.id === toPanel);
      if (!panel) parts.push('moved to another panel');
      else if (panel.id === at!.panel.id) {
        // B-TOOL #7: inside the same panel, say where in it the line lands (as applyLineMove places it).
        const rest = panel.lines.length - 1;
        const k = (typeof toIndex === 'number' && Number.isFinite(toIndex) ? Math.min(rest, Math.max(0, Math.floor(toIndex))) : rest) + 1;
        parts.push(`moved to line ${k} of panel ${panel.n}`);
      } else parts.push(`moved to panel ${panel.n}`);
    }
    if (balloon) {
      const placed = at?.page.balloons.find((b) => b.lineId === lineId);
      const box = { x: balloon.x ?? placed?.x ?? 0.5, y: balloon.y ?? placed?.y ?? 0.5, w: balloon.w ?? placed?.w ?? 0.2 };
      parts.push(balloon.x !== undefined || balloon.y !== undefined ? `balloon moved to ${balloonSpot(box)}` : 'balloon reshaped');
    }
    if (style !== undefined) parts.push(style === null ? 'its own look cleared' : `restyled (${styleWords(style)})`);
    theirs = parts.join(', ');
  }
  return { where, mine, theirs, proposed: ops };
}

const KIND_ONE: Record<string, string> = { speech: 'speech', thought: 'thought', whisper: 'whisper', shout: 'shout', caption: 'caption', sfx: 'sound effect' };
const KIND_MANY: Record<string, string> = { speech: 'speech', thought: 'thoughts', whisper: 'whispers', shout: 'shouts', caption: 'captions', sfx: 'sound effects' };
const presetName = (id: unknown): string =>
  typeof id === 'string' && Object.prototype.hasOwnProperty.call(LETTERING_PRESETS, id) ? LETTERING_PRESETS[id as keyof typeof LETTERING_PRESETS].name : String(id);
/** " (text colour)" for a stored look, '' when it has nothing to name. */
const lookWords = (patch: unknown): string => (patch && typeof patch === 'object' && Object.keys(patch).length ? ` (${styleWords(patch)})` : '');

/** One lettering scope the CREATOR changed, in words: the card label, their current version, and what a switch drops. */
interface LetterScope {
  label: string;
  mine: string;
  /** "your look for shouts": what a preset switch (switch) or a reset (reset) by the director would drop. */
  dropped?: { words: string; by: 'switch' | 'reset' };
}

const letterScope = (doc: ComicDoc, key: EntityKey): LetterScope => {
  const ls = letterStyleOf(doc);
  const scope = key.slice('letter:'.length);
  const pick = { label: 'the lettering preset', mine: `Your pick: the ${presetName(ls.presetId)} lettering.` };
  if (scope === '*') return { label: 'the lettering', mine: 'You reset the lettering to its default look.' };
  // The creator's own preset switch (its wildcard) or auto flag: their pick of preset.
  if (scope === 'preset' || scope === 'auto' || scope === 'kind:*') return pick;
  if (scope === 'base') return { label: 'the base lettering', mine: `Your base look${lookWords(ls.base)}.`, dropped: { words: 'your base look', by: 'switch' } };
  if (scope === 'margin') return { label: 'the lettering margin', mine: 'Your safe margin for the balloons.' };
  if (scope.startsWith('kind:')) {
    const k = scope.slice('kind:'.length);
    const many = KIND_MANY[k] ?? k;
    return {
      label: `the ${KIND_ONE[k] ?? k} lettering`,
      mine: `Your look for ${many}${lookWords((ls.kinds as Record<string, unknown> | undefined)?.[k])}.`,
      dropped: { words: `your look for ${many}`, by: 'switch' }
    };
  }
  if (scope.startsWith('speaker:')) {
    const id = scope.slice('speaker:'.length);
    const name = nameOf(doc, id);
    return { label: `${name}’s lettering`, mine: `Your look for ${name}${lookWords(ls.speakers?.[id])}.`, dropped: { words: `your look for ${name}`, by: 'reset' } };
  }
  return { label: 'the lettering', mine: 'Your lettering choices.' };
};

const listWords = (items: string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * The lettering item, labelled from what the CREATOR changed (`creatorKeys`, the creator's keys these ops collide with):
 * a kind look that collided with the director's preset switch reads "the shout lettering" / "Your look for shouts
 * (text colour)" / "Switch to the Manga lettering, which drops your look for shouts." — never "the lettering preset".
 */
function letterItem(doc: ComicDoc, ops: DocOp[], creatorKeys: readonly EntityKey[]): BlockedEdit {
  const scopes: LetterScope[] = [];
  for (const key of creatorKeys) {
    const scope = letterScope(doc, key);
    if (!scopes.some((s) => s.label === scope.label)) scopes.push(scope);
  }
  const label = scopes.length === 1 ? scopes[0].label : 'the lettering';
  const mine = scopes.length ? scopes.slice(0, 3).map((s) => s.mine).join(' ') : 'Your lettering choices.';
  const preset = ops.map((op) => (op.op === 'letter_style' && op.patch?.presetId ? op.patch.presetId : undefined)).filter(Boolean).pop();
  const keeps = ops.some((op) => op.op === 'letter_style' && !!op.patch?.presetId && op.patch.keepOverrides === true);
  const reset = ops.some((op) => op.op === 'letter_style' && op.patch === null);
  const patches = ops.flatMap((op) =>
    op.op === 'letter_style' && op.patch ? [op.patch.base, ...Object.values(op.patch.kinds || {}), ...Object.values(op.patch.speakers || {})] : []
  );
  const changed = Object.assign({}, ...patches.filter((p) => p && typeof p === 'object')) as LetterStylePatch;
  const drops = (by: 'switch' | 'reset') => {
    const words = scopes.flatMap((s) => (s.dropped && (by === 'reset' || s.dropped.by === 'switch') ? [s.dropped.words] : []));
    return words.length ? `, which drops ${listWords(words)}` : '';
  };
  // What the director's own change is about ("the look for shouts"), when it is about one thing.
  const theirScopes = new Set<string>();
  for (const op of ops) {
    if (op.op !== 'letter_style' || !op.patch) continue;
    if (op.patch.base !== undefined) theirScopes.add('the base look');
    for (const k of Object.keys(op.patch.kinds || {})) theirScopes.add(`the look for ${KIND_MANY[k] ?? k}`);
    for (const id of Object.keys(op.patch.speakers || {})) theirScopes.add(`the look for ${nameOf(doc, id)}`);
  }
  const what = theirScopes.size === 1 ? [...theirScopes][0] : 'the lettering';
  const theirs = reset
    ? `Reset the lettering to the default look${drops('reset')}.`
    : preset
      ? `Switch to the ${presetName(preset)} lettering${keeps ? '' : drops('switch')}${Object.keys(changed).length ? `, and change its ${styleWords(changed)}` : ''}.`
      : `Change ${what} (${styleWords(changed)}).`;
  return { where: { label }, mine, theirs, proposed: ops };
}

function panelItem(doc: ComicDoc, group: string, ops: DocOp[]): BlockedEdit {
  const id = group.slice('panel:'.length);
  let page: Page | undefined;
  let panel: Panel | undefined;
  for (const p of doc.pages) {
    const hit = p.panels.find((x) => x.id === id);
    if (hit) {
      page = p;
      panel = hit;
      break;
    }
  }
  const pageId = page?.id ?? ops.map(pageIdOf).find(Boolean);
  const label = page && panel ? `page ${page.n} · panel ${panel.n}` : 'a panel you changed';
  const action = ops.map((op) => (op.op === 'panel' && typeof op.patch.action === 'string' ? op.patch.action : undefined)).filter(Boolean).pop();
  const removed = ops.some((op) => op.op === 'panel_remove');
  return {
    where: { ...(pageId ? { pageId } : {}), ...(panel ? { panelId: panel.id } : {}), label },
    mine: panel ? clip(panel.action || 'Your version of this panel.', CONFLICT_LIMITS.textChars) : 'You removed this panel.',
    theirs: removed ? 'Remove this panel.' : action ? clip(action, CONFLICT_LIMITS.textChars) : 'A rewritten panel.',
    proposed: ops
  };
}

function pageItem(doc: ComicDoc, group: string, ops: DocOp[]): BlockedEdit {
  if (group === 'plan') return { where: { label: 'the page plan' }, mine: 'Your changes to the pages.', theirs: 'A rewritten page plan.', proposed: ops };
  const pageId = group.slice(group.indexOf(':') + 1);
  const page = findPage(doc, pageId);
  const label = page ? `page ${page.n}` : 'a page';
  const restyle = ops.every((op) => op.op === 'line_style');
  const layout = ops.every((op) => op.op === 'balloons');
  return {
    where: { ...(page ? { pageId: page.id } : {}), label },
    mine: restyle ? 'Your look for these lines.' : layout ? 'Your balloons, where you put them.' : 'Your changes on this page.',
    theirs: restyle ? `Restyle these lines (${styleWords(Object.assign({}, ...ops.map((op) => (op.op === 'line_style' ? op.patch : {}))))}).` : layout ? 'A new balloon layout.' : 'Rewritten panels.',
    proposed: ops
  };
}

/** The entity an item is about (merging two holds of the same line in one turn into one item). */
const itemKey = (where: ConflictWhere): string => where.lineId ?? where.panelId ?? where.pageId ?? where.label;

/** Join two descriptions of the director's version, once each ("Rewritten panels. A new balloon layout."). */
const joinTheirs = (a: string, b: string): string => {
  const end = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`);
  return a === b || !a ? b : !b ? a : `${end(a)} ${b}`;
};

/**
 * One BlockedEdit per entity, in the order the director planned them. An entity already held earlier this turn
 * (`earlier`, turn.conflicts) is described from ALL its held ops, earlier ones first, so the card's Yours / The
 * director's show exactly what "Use the director's" would apply; `proposed` stays this call's ops (recordConflicts
 * appends them to the item's).
 */
function blockedEdits(doc: ComicDoc, held: HeldOp[], creatorKeys: readonly EntityKey[], earlier: readonly ConflictItem[] = []): BlockedEdit[] {
  const groups = new Map<string, DocOp[]>();
  for (const { op, group } of held) groups.set(group, [...(groups.get(group) || []), op]);
  const build = (group: string, ops: DocOp[]): BlockedEdit => {
    if (group.startsWith('line:')) return lineItem(doc, group.slice(5), ops);
    if (group === 'letter') {
      const keys = creatorKeys.filter((k) => ops.some((op) => entityKeys(op).some((d) => keysCollide(d, k))));
      return letterItem(doc, ops, keys);
    }
    return group.startsWith('panel:') ? panelItem(doc, group, ops) : pageItem(doc, group, ops);
  };
  return [...groups].map(([group, ops]) => {
    const first = build(group, ops);
    const prev = earlier.find((it) => itemKey(it.where) === itemKey(first.where));
    if (!prev) return first;
    if (prev.tooBig) return { ...first, where: prev.where, theirs: joinTheirs(prev.theirs, first.theirs) };
    const merged = build(group, [...prev.proposed, ...ops]);
    // The item keeps its identity even if its words broaden ("the shout lettering" → "the lettering").
    const where = itemKey(merged.where) === itemKey(prev.where) ? merged.where : prev.where;
    return { where, mine: merged.mine, theirs: merged.theirs, proposed: ops };
  });
}

// ── The guard ────────────────────────────────────────────────────────────────

/** The entity keys the creator committed after the turn started (origin 'user'), or [] when there is nothing to guard. */
export function userKeysSince(ctx: StudioContext, startRev: number): EntityKey[] {
  const commits = recentCommitsOf(ctx.session, startRev).filter((c) => c.origin === 'user' && c.rev > startRev);
  return [...new Set(commits.flatMap((c) => (Array.isArray(c.ops) ? c.ops.flatMap((op) => entityKeys(op)) : [])))];
}

/**
 * Whether the session's recent-commit ring still holds every commit after `startRev`. The ring keeps the last
 * RECENT_COMMITS_MAX commits and RECENT_COMMITS_BYTES of ops (session.ts); past that it drops the oldest, so some of
 * the creator's edits since the turn began would be unseen. A session without the ring (a test double) counts as
 * complete: it has nothing to drop.
 */
const ringCovers = (ctx: StudioContext, startRev: number): boolean =>
  (ctx.session as { recentCommitsComplete?: (sinceRev: number) => boolean }).recentCommitsComplete?.(startRev) ?? true;

/**
 * Split `plannedOps` into the ones that may commit and the ones the creator's mid-turn edits block (plan §3 A3.1).
 * Off (caps.liveAgent.conflicts false), on a turn without a startRev, or when the creator committed nothing since,
 * it allows everything, exactly as before. When the recent-commit ring no longer reaches back to startRev
 * (recentCommitsComplete false), every planned entity is held back and the gap is logged: unseen edits never lose to
 * the director. Pure apart from reading the session (and that log line); synchronous; never throws.
 */
export function guardUserEdits(ctx: StudioContext, turn: DirectorTurn, plannedOps: DocOp[]): GuardResult {
  const pass: GuardResult = { allowed: plannedOps, blocked: [] };
  if (!plannedOps.length || !conflictGuardOn(ctx.caps) || typeof turn.startRev !== 'number') return pass;
  let mine = userKeysSince(ctx, turn.startRev);
  if (!ringCovers(ctx, turn.startRev)) {
    // The ring dropped commits since the turn began, so the creator may have changed anything the director is about
    // to touch. Never guess in the director's favour: hold every planned entity back and let the card ask.
    mine = [...new Set([...mine, ...plannedOps.flatMap((op) => entityKeys(op))])];
    logger.warn('comic_conflict_ring_incomplete', { projectId: ctx.projectId, startRev: turn.startRev, rev: ctx.session.doc.rev, planned: plannedOps.length });
  }
  if (!mine.length) return pass;
  const hit = (key: EntityKey) => mine.some((k) => keysCollide(key, k));
  const doc = ctx.session.doc;
  const allowed: DocOp[] = [];
  const held: HeldOp[] = [];
  for (const op of plannedOps) {
    if (op.op === 'line_style' && Array.isArray(op.lineIds) && op.lineIds.length > 1) {
      // A restyle of several lines: the creator's restyled lines keep their look, the rest take the new one.
      const blockedIds = op.lineIds.filter((id) => hit(`lstyle:${id}`));
      const rest = op.lineIds.filter((id) => !blockedIds.includes(id));
      if (rest.length) allowed.push(blockedIds.length ? { ...op, lineIds: rest } : op);
      for (const id of blockedIds) held.push({ op: { ...op, lineIds: [id] }, group: `line:${id}` });
      continue;
    }
    if (op.op === 'balloons' && Array.isArray(op.balloons)) {
      // A page-wide layout: the creator's balloons stay where they put them; every other balloon moves.
      const touched = new Set(mine.flatMap((k) => (k.startsWith('balloon:') ? [k.slice(8)] : [])));
      const live = new Map((findPage(doc, op.pageId)?.balloons || []).map((b) => [b.lineId, b]));
      const listed = new Set(op.balloons.map((b) => b.lineId));
      const blocked = op.balloons.filter((b) => touched.has(b.lineId));
      // A balloon the creator placed that the layout would drop stays too (the layout did not mean to remove it).
      const dropped = [...touched].filter((id) => !listed.has(id) && live.has(id));
      if (!blocked.length && !dropped.length) {
        allowed.push(op);
        continue;
      }
      const kept: Balloon[] = op.balloons.flatMap((b) => (!touched.has(b.lineId) ? [b] : live.has(b.lineId) ? [live.get(b.lineId)!] : []));
      for (const id of dropped) kept.push(live.get(id)!);
      allowed.push({ ...op, balloons: kept });
      for (const b of blocked) {
        const { lineId, ...patch } = b;
        held.push({ op: { op: 'balloon', pageId: op.pageId, lineId, patch }, group: `line:${lineId}` });
      }
      continue;
    }
    if (entityKeys(op).some(hit)) held.push({ op, group: groupOf(op) });
    else allowed.push(op);
  }
  if (!held.length) return { allowed, blocked: [] };
  return { allowed, blocked: blockedEdits(doc, held, mine, turn.conflicts ?? []) };
}

/**
 * The tool result for blocked edits (plan §3 A3.1): "Conflict: you changed page 2 · panel 1 · line 2 ("We have to go")
 * while I was working, so I left it. Do not redo it; the studio will ask." Empty when nothing was blocked.
 */
export function conflictToolNote(blocked: readonly BlockedEdit[]): string {
  if (!blocked.length) return '';
  const where = blocked.map((b) => (b.mine ? `${b.where.label} ("${b.mine}")` : b.where.label)).join('; ');
  return `Conflict: you changed ${where} while I was working, so I left it. Do not redo it; the studio will ask.`;
}

/**
 * Record blocked edits on the turn (each becomes a ConflictItem the card will show). The same entity held back twice
 * in one turn stays ONE item: its ops in order, and the words of the newest BlockedEdit, which guardUserEdits already
 * built from ALL the item's ops (so the card shows everything "Use the director's" applies). An item whose ops a card cannot apply
 * (a server-only op such as a whole page rewrite) keeps `proposed: []` and `tooBig`, so "Use the director's" refuses it
 * in plain words instead of failing half-way.
 */
export function recordConflicts(turn: DirectorTurn, blocked: readonly BlockedEdit[]): void {
  if (!blocked.length) return;
  const items: ConflictItem[] = [...(turn.conflicts ?? [])];
  for (const b of blocked) {
    const at = items.findIndex((it) => itemKey(it.where) === itemKey(b.where));
    const prev = at >= 0 ? items[at] : undefined;
    const proposed = [...(prev && !prev.tooBig ? prev.proposed : []), ...b.proposed];
    const tooBig = !!prev?.tooBig || proposed.some((op) => !CLIENT_PATCHABLE_OPS.has(op.op));
    const item: ConflictItem = {
      id: prev?.id ?? newId('cf'),
      where: b.where,
      mine: b.mine,
      theirs: b.theirs,
      proposed: tooBig ? [] : proposed,
      ...(tooBig ? { tooBig: true as const } : {})
    };
    if (at >= 0) items[at] = item;
    else items.push(item);
  }
  turn.conflicts = items;
}

/**
 * The conflict card as words for the director's history (director.ts cardText, A2): "[conflict: page 2 · panel 1 ·
 * line 2 — kept the creator's; page 3 · panel 1 — waiting for an answer]", so the next turn knows what was answered
 * and never redoes a held-back edit on its own.
 */
export function conflictCardText(card: ConflictCard): string {
  const items = Array.isArray(card?.items) ? card.items : [];
  if (!items.length) return '';
  const state = (it: ConflictItem) => (it.resolved === 'mine' ? "kept the creator's" : it.resolved === 'theirs' ? "used the director's" : 'waiting for an answer');
  const parts = items.slice(0, 5).map((it) => `${it.where?.label ?? 'a change'} — ${state(it)}`);
  const more = Math.max(0, items.length - 5) + (typeof card.more === 'number' && card.more > 0 ? card.more : 0);
  return `[conflict: ${parts.join('; ')}${more > 0 ? `; and ${more} more left alone` : ''}]`;
}

/**
 * After the director loop: one conflict card for everything the guard held back this turn ("We both changed page 2 ·
 * panel 1." Keep mine / Use the director's / Show me), or null (plan §3 A3.1). Cheap and synchronous: it runs on a
 * Stopped turn too and assumes nothing about how the turn ended; bounded by normalizeConflictCard (items past
 * CONFLICT_LIMITS.items are counted in `more`, an op list that does not fit makes its item `tooBig`).
 */
export function conflictCardFor(turn: DirectorTurn): ConflictCard | null {
  if (!turn.conflicts?.length) return null;
  return normalizeConflictCard({ type: 'conflict', id: newId('card'), items: turn.conflicts }) ?? null;
}
