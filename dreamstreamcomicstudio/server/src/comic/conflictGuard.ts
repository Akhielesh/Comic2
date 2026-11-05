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

import { CONFLICT_LIMITS, findCharacter, findPage, newId, normalizeConflictCard, type Balloon, type ComicDoc, type ConflictCard, type ConflictItem, type ConflictWhere, type Line, type LineKind, type Page, type Panel } from '../../../shared/comic/doc.js';
import { conflictGuardOn } from '../../../shared/comic/capabilities.js';
import { entityKeys, keysCollide, type EntityKey } from '../../../shared/comic/conflicts.js';
import { LETTERING_PRESETS, type LetterStylePatch } from '../../../shared/comic/lettering/style.js';
import { CLIENT_PATCHABLE_OPS, type DocOp } from '../../../shared/comic/ops.js';
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

/** One line's item: where it is now, the creator's current version and what the director would have made of it. */
function lineItem(doc: ComicDoc, lineId: string, ops: DocOp[]): BlockedEdit {
  const at = locateLine(doc, lineId);
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
    } else if (op.op === 'line_move') toPanel = op.toPanelId;
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
    if (toPanel) parts.push(`in panel ${at!.panel.n}`);
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
      parts.push(panel ? `moved to panel ${panel.n}` : 'moved to another panel');
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

/** "Mira's lettering", "the shout lettering", "the lettering". */
const letterScopeWords = (doc: ComicDoc, ops: DocOp[]): string => {
  const scopes = new Set<string>();
  for (const op of ops) {
    if (op.op !== 'letter_style' || !op.patch) continue;
    if (op.patch.presetId) scopes.add('preset');
    for (const k of Object.keys(op.patch.kinds || {})) scopes.add(`kind:${k}`);
    for (const id of Object.keys(op.patch.speakers || {})) scopes.add(`speaker:${id}`);
  }
  if (scopes.size !== 1) return 'the lettering';
  const [only] = [...scopes];
  if (only === 'preset') return 'the lettering preset';
  if (only.startsWith('kind:')) return `the ${only.slice(5)} lettering`;
  const name = nameOf(doc, only.slice(8));
  return `${name}’s lettering`;
};

function letterItem(doc: ComicDoc, ops: DocOp[]): BlockedEdit {
  const label = letterScopeWords(doc, ops);
  const preset = ops.map((op) => (op.op === 'letter_style' && op.patch?.presetId ? op.patch.presetId : undefined)).filter(Boolean).pop();
  const reset = ops.some((op) => op.op === 'letter_style' && op.patch === null);
  const patches = ops.flatMap((op) =>
    op.op === 'letter_style' && op.patch ? [op.patch.base, ...Object.values(op.patch.kinds || {}), ...Object.values(op.patch.speakers || {})] : []
  );
  const changed = Object.assign({}, ...patches.filter((p) => p && typeof p === 'object')) as LetterStylePatch;
  const theirs = reset
    ? 'Reset the lettering to the default look.'
    : preset
      ? `Switch to the ${LETTERING_PRESETS[preset]?.name ?? preset} lettering${Object.keys(changed).length ? `, and change its ${styleWords(changed)}` : ''}.`
      : `Change its ${styleWords(changed)}.`;
  const mine = label === 'the lettering' ? 'Your lettering choices.' : `Your choices for ${label}.`;
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

/** One BlockedEdit per entity, in the order the director planned them. */
function blockedEdits(doc: ComicDoc, held: HeldOp[]): BlockedEdit[] {
  const groups = new Map<string, DocOp[]>();
  for (const { op, group } of held) groups.set(group, [...(groups.get(group) || []), op]);
  return [...groups].map(([group, ops]) =>
    group.startsWith('line:')
      ? lineItem(doc, group.slice(5), ops)
      : group === 'letter'
        ? letterItem(doc, ops)
        : group.startsWith('panel:')
          ? panelItem(doc, group, ops)
          : pageItem(doc, group, ops)
  );
}

// ── The guard ────────────────────────────────────────────────────────────────

/** The entity keys the creator committed after the turn started (origin 'user'), or [] when there is nothing to guard. */
export function userKeysSince(ctx: StudioContext, startRev: number): EntityKey[] {
  const commits = recentCommitsOf(ctx.session, startRev).filter((c) => c.origin === 'user' && c.rev > startRev);
  return [...new Set(commits.flatMap((c) => (Array.isArray(c.ops) ? c.ops.flatMap((op) => entityKeys(op)) : [])))];
}

/**
 * Split `plannedOps` into the ones that may commit and the ones the creator's mid-turn edits block (plan §3 A3.1).
 * Off (caps.liveAgent.conflicts false), on a turn without a startRev, or when the creator committed nothing since,
 * it allows everything, exactly as before. Pure apart from reading the session; synchronous; never throws.
 */
export function guardUserEdits(ctx: StudioContext, turn: DirectorTurn, plannedOps: DocOp[]): GuardResult {
  const pass: GuardResult = { allowed: plannedOps, blocked: [] };
  if (!plannedOps.length || !conflictGuardOn(ctx.caps) || typeof turn.startRev !== 'number') return pass;
  const mine = userKeysSince(ctx, turn.startRev);
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
  return { allowed, blocked: blockedEdits(doc, held) };
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

/** The entity an item is about (merging two holds of the same line in one turn into one item). */
const itemKey = (where: ConflictWhere): string => where.lineId ?? where.panelId ?? where.pageId ?? where.label;

/**
 * Record blocked edits on the turn (each becomes a ConflictItem the card will show). The same entity held back twice
 * in one turn stays ONE item (its ops in order, the director's latest version). An item whose ops a card cannot apply
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
      mine: prev?.mine ?? b.mine,
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
 * After the director loop: one conflict card for everything the guard held back this turn ("We both changed page 2 ·
 * panel 1." Keep mine / Use the director's / Show me), or null (plan §3 A3.1). Cheap and synchronous: it runs on a
 * Stopped turn too and assumes nothing about how the turn ended; bounded by normalizeConflictCard (items past
 * CONFLICT_LIMITS.items are counted in `more`, an op list that does not fit makes its item `tooBig`).
 */
export function conflictCardFor(turn: DirectorTurn): ConflictCard | null {
  if (!turn.conflicts?.length) return null;
  return normalizeConflictCard({ type: 'conflict', id: newId('card'), items: turn.conflicts }) ?? null;
}
