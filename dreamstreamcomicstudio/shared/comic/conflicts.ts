// Conflict keys: which doc entity an op changes, fine enough that two different balloons on one page never collide
// (agent-editor plan §3 A3.1; filled by wave 1 A3 CONFLICT).
//
// History's touchedKeys (history/touched.ts) is page-level, too coarse for "you edited this while I was working": the
// guard (server/src/comic/conflictGuard.ts) compares these keys between the creator's commits after a turn's startRev
// and the director's planned ops. Pure; imports only types from ops.ts.
//
// The keys, per entity:
// - `line:<id>`     a line's words, kind, speaker, language or translate flag, and which panel it sits in (a move);
// - `balloon:<id>`  its balloon box: position, width, tail, pin, lock, link, rotation, height;
// - `lstyle:<id>`   its own lettering style (line_style, Line.style, Line.styleId);
// - `panel:<id>`    a panel's art direction (shot, action, cast, size, frame…);
// - `order:<id>`    the order of the lines inside a panel (a line inserted at an index, a move into it);
// - `letter:<scope>` the comic-wide lettering: `letter:preset`, `letter:base`, `letter:kind:<kind>`,
//   `letter:speaker:<characterId>`, `letter:margin`, `letter:auto`;
// - `motion:<pageId>:<id>` one motion clip on a page (its upsert or delete);
// - `page_motion:<pageId>` a page's camera moves and hold (page_motion never touches the clips).
// A reset is a WILDCARD: `letter:*` (the whole lettering back to default) collides with every `letter:` key, and
// `letter:kind:*` (a preset switch that drops the kind overrides) with every `letter:kind:` key. An op this module
// does not know (a newer op, a render, a message) changes no tracked entity: [].

import type { DocOp } from './ops.js';

/**
 * One entity an op changes: a line's words / kind / speaker (`line:`), its balloon box (`balloon:`), its own style
 * (`lstyle:`), a panel (`panel:`), a panel's line order (`order:`), a comic-wide lettering scope (`letter:base`,
 * `letter:kind:shout`, `letter:speaker:<id>`), a page's motion clip (`motion:<pageId>:<id>`) or its camera and hold
 * (`page_motion:<pageId>`).
 */
export type EntityKey =
  | `line:${string}`
  | `balloon:${string}`
  | `lstyle:${string}`
  | `panel:${string}`
  | `order:${string}`
  | `letter:${string}`
  | `motion:${string}`
  | `page_motion:${string}`;

/** Line fields that are the line's own lettering style, not its words. */
const STYLE_FIELDS: ReadonlySet<string> = new Set(['style', 'styleId']);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** The keys of a panel snapshot: the panel, its line order and every line inside it (words and style). */
const panelKeys = (panel: unknown, out: EntityKey[]): void => {
  if (!isObj(panel) || !str(panel.id)) return;
  out.push(`panel:${panel.id}`, `order:${panel.id}`);
  for (const line of Array.isArray(panel.lines) ? panel.lines : []) {
    if (isObj(line) && str(line.id)) out.push(`line:${line.id}`, `lstyle:${line.id}`);
  }
};

/** Keys of a `letter_style` patch (null = reset everything). */
const letterKeys = (patch: unknown, out: EntityKey[]): void => {
  if (patch === null) {
    out.push('letter:*');
    return;
  }
  if (!isObj(patch)) return;
  if (str(patch.presetId)) {
    out.push('letter:preset');
    // Switching the preset without keepOverrides drops the base and kind overrides (ops.ts applyLetterStyle).
    if (patch.keepOverrides !== true) out.push('letter:base', 'letter:kind:*');
  }
  if (patch.auto !== undefined) out.push('letter:auto');
  if (patch.base !== undefined) out.push('letter:base');
  if (isObj(patch.kinds)) for (const kind of Object.keys(patch.kinds)) if (patch.kinds[kind] !== undefined) out.push(`letter:kind:${kind}`);
  if (isObj(patch.speakers)) for (const id of Object.keys(patch.speakers)) if (patch.speakers[id] !== undefined) out.push(`letter:speaker:${id}`);
  if (patch.safeMargin !== undefined) out.push('letter:margin');
};

/**
 * The fine keys `op` changes (plan §3 A3.1; e.g. a `balloon` op → `balloon:<lineId>`), deduped in first-seen order.
 * - `line` with a patch: `line:` for its words / kind / speaker, `lstyle:` for its style; a new line placed at an
 *   `index` also changes its panel's order. A delete (patch null) takes the line, its balloon and its style with it.
 * - `line_move`: the line (which panel it sits in) and the order of the panel it goes to.
 * - `line_style`: each named line's style. `balloon`: that balloon; `balloons`: every balloon in the new list.
 * - `panel`, `panel_add`, `panel_remove`, `page_panels`, `pages`: the panels (and every line inside a snapshot).
 * - `letter_style`: the lettering scopes it touches (see the header for the reset wildcards).
 * - `motion`: that clip of that page (an upsert or a delete); `page_motion`: that page's camera moves and hold.
 */
export function entityKeys(op: DocOp): EntityKey[] {
  const out: EntityKey[] = [];
  const o = op as unknown as Record<string, unknown>;
  if (!isObj(o)) return out;
  switch (o.op) {
    case 'line': {
      if (!str(o.id)) break;
      if (o.patch === null) {
        out.push(`line:${o.id}`, `balloon:${o.id}`, `lstyle:${o.id}`);
        break;
      }
      if (!isObj(o.patch)) break;
      const fields = Object.keys(o.patch);
      if (fields.some((f) => !STYLE_FIELDS.has(f))) out.push(`line:${o.id}`);
      if (fields.some((f) => STYLE_FIELDS.has(f))) out.push(`lstyle:${o.id}`);
      if (typeof o.index === 'number' && str(o.panelId)) out.push(`order:${o.panelId}`);
      break;
    }
    case 'line_move':
      if (str(o.id)) out.push(`line:${o.id}`);
      if (str(o.toPanelId)) out.push(`order:${o.toPanelId}`);
      break;
    case 'line_style':
      for (const id of Array.isArray(o.lineIds) ? o.lineIds : []) if (str(id)) out.push(`lstyle:${id}`);
      break;
    case 'balloon':
      if (str(o.lineId)) out.push(`balloon:${o.lineId}`);
      break;
    case 'balloons':
      for (const b of Array.isArray(o.balloons) ? o.balloons : []) if (isObj(b) && str(b.lineId)) out.push(`balloon:${b.lineId}`);
      break;
    case 'panel':
      if (str(o.id)) out.push(`panel:${o.id}`);
      break;
    case 'panel_remove':
      if (str(o.id)) out.push(`panel:${o.id}`, `order:${o.id}`);
      break;
    case 'panel_add':
      panelKeys(o.panel, out);
      break;
    case 'page_panels':
      for (const panel of Array.isArray(o.panels) ? o.panels : []) panelKeys(panel, out);
      break;
    case 'pages':
      for (const page of Array.isArray(o.pages) ? o.pages : []) {
        if (!isObj(page)) continue;
        for (const panel of Array.isArray(page.panels) ? page.panels : []) panelKeys(panel, out);
        for (const b of Array.isArray(page.balloons) ? page.balloons : []) if (isObj(b) && str(b.lineId)) out.push(`balloon:${b.lineId}`);
      }
      break;
    case 'letter_style':
      letterKeys(o.patch, out);
      break;
    case 'motion':
      if (str(o.pageId) && str(o.id)) out.push(`motion:${o.pageId}:${o.id}`);
      break;
    case 'page_motion':
      if (str(o.pageId)) out.push(`page_motion:${o.pageId}`);
      break;
    default:
      break;
  }
  return [...new Set(out)];
}

/**
 * Whether two keys name the same entity: equal, or a reset wildcard covering the other (`letter:*` covers every
 * `letter:` key; `letter:kind:*` every `letter:kind:` key).
 */
export function keysCollide(a: EntityKey, b: EntityKey): boolean {
  if (a === b) return true;
  const covers = (wild: string, key: string) => wild.endsWith(':*') && key.startsWith(wild.slice(0, -1));
  return covers(a, b) || covers(b, a);
}

/** Keys both op lists change, in first-seen order of `a` (the conflict guard's test). Built on entityKeys. */
export function collidingKeys(a: readonly DocOp[], b: readonly DocOp[]): EntityKey[] {
  const theirs = [...new Set(b.flatMap((op) => entityKeys(op)))];
  const exact = new Set(theirs);
  const out: EntityKey[] = [];
  for (const key of a.flatMap((op) => entityKeys(op))) {
    if (out.includes(key)) continue;
    if (exact.has(key) || theirs.some((k) => keysCollide(key, k))) out.push(key);
  }
  return out;
}

/** The line id a `line:` / `balloon:` / `lstyle:` key names (undefined for panel, order and lettering keys). */
export function lineIdOfKey(key: EntityKey): string | undefined {
  const m = /^(?:line|balloon|lstyle):(.+)$/.exec(key);
  return m ? m[1] : undefined;
}
