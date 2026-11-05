// Continuity ledger (Ship 2, B4; pro plan §4.2 "Continuity ledger", §4.4, §5.2). Pure and $0: no I/O, no clock.
//
// `doc.scenes` names where and when a run of pages happens; `page.continuity` records what CHANGES from that page on
// (outfits, what people hold, marks, where they stand, prop states, notes). This module folds the ledger into the
// state a page is drawn with (resolveContinuity), finds contradictions in it (lintContinuity), derives scenes for a
// book that has none (deriveScenes), picks the page a page job attaches for continuity (continuityAnchorFor) and
// groups a run's pages into scene chains (runChains).
//
// Carry rules (CONTINUITY_CARRY, one constant): outfit and marks carry book-wide, what someone holds carries for the
// rest of the scene, where someone stands holds for that page only; prop states carry book-wide; a null clears.
//
// Back-compat (I8): a book without ledger data resolves to an empty state (`content: false`), so no CONTINUITY block
// is written and nothing about its prompt changes; continuityAnchorFor then picks exactly today's previous page
// (sendable.ts nearestReadyBefore).

import { CONSISTENCY_LIMITS, PRO_PAGE_LIMITS } from './limits.js';
import { scenesOf, type CastStateChange, type ComicDoc, type Page, type Scene } from './doc.js';
import { canServeToOwner } from './safety.js';

// ── Carry rules ──────────────────────────────────────────────────────────────

export type CastStateField = 'outfit' | 'holding' | 'marks' | 'where';
export type CarryScope = 'book' | 'scene' | 'page';

/** How far each change carries (pro plan §4.2): outfit and marks book-wide, holding per scene, where per page. */
export const CONTINUITY_CARRY: Readonly<Record<CastStateField, CarryScope>> = { outfit: 'book', marks: 'book', holding: 'scene', where: 'page' };
/** Prop states (`page.continuity.props`) carry book-wide until changed or cleared. */
export const PROP_CARRY: CarryScope = 'book';

const FIELDS: readonly CastStateField[] = ['outfit', 'holding', 'marks', 'where'];

/** One character's state on a page; `since` is the page number each present field was set on. */
export interface CastState {
  outfit?: string;
  holding?: string[];
  marks?: string[];
  where?: string;
  since: Partial<Record<CastStateField, number>>;
}

export interface PropState {
  state: string;
  /** Page number the state was set on. */
  since: number;
}

/** Where a page's scene comes from: the ledger (page.continuity.sceneId, carried), derived from places, or none. */
export type SceneSource = 'ledger' | 'derived' | 'none';

/** The state a page is drawn with. */
export interface ContinuityState {
  pageId: string;
  n: number;
  sceneId?: string;
  /** The scene record (doc.scenes for the ledger; the derived scene otherwise). */
  scene?: Scene;
  /** Page number the current scene run began on. */
  sceneSince?: number;
  sceneFrom: SceneSource;
  /** castId → carried state (only characters the book has). */
  cast: Record<string, CastState>;
  /** prop name → its state. */
  props: Record<string, PropState>;
  /** Props the ledger says are gone, with the page they went on. */
  gone: Record<string, number>;
  /** This page's own notes. */
  notes: string[];
  /** The ledger says something for this page: the prompt gets a CONTINUITY block only then (I8). */
  content: boolean;
}

// ── Scenes ───────────────────────────────────────────────────────────────────

const byN = (doc: Pick<ComicDoc, 'pages'>): Page[] => [...doc.pages].sort((a, b) => a.n - b.n);

/** The place most of a page's panels use (ties: the first one used), or undefined. */
export const dominantPlaceOf = (page: Pick<Page, 'panels'>): string | undefined => {
  const counts = new Map<string, { count: number; first: number }>();
  page.panels.forEach((panel, i) => {
    if (!panel.placeId) return;
    const c = counts.get(panel.placeId) ?? { count: 0, first: i };
    c.count += 1;
    counts.set(panel.placeId, c);
  });
  let best: [string, { count: number; first: number }] | undefined;
  for (const entry of counts) if (!best || entry[1].count > best[1].count || (entry[1].count === best[1].count && entry[1].first < best[1].first)) best = entry;
  return best?.[0];
};

export interface DerivedScenes {
  scenes: Scene[];
  /** pageId → derived scene id. */
  byPage: Record<string, string>;
}

/** Prefix of derived scene ids (never stored unless a writer or the user adopts them). */
export const DERIVED_SCENE_PREFIX = 'sc_auto_';

/**
 * Scenes for a book that has none, from its places: walking pages in order, a page whose main place differs from the
 * current scene's starts a new scene; a page with no place stays in the current one (a first scene with no place takes
 * the first place it meets). Ids `sc_auto_<k>` (never one doc.scenes uses), names from the place. ≤ CONSISTENCY_LIMITS
 * .scenes (later pages join the last scene). Deterministic; the ledger is ignored.
 */
export const deriveScenes = (doc: Pick<ComicDoc, 'pages' | 'places' | 'scenes'>): DerivedScenes => {
  const taken = new Set(scenesOf(doc).map((s) => s.id));
  const scenes: Scene[] = [];
  const byPage: Record<string, string> = {};
  let k = 0;
  const nextId = (): string => {
    let id = '';
    do {
      k += 1;
      id = `${DERIVED_SCENE_PREFIX}${k}`;
    } while (taken.has(id));
    return id;
  };
  const nameOf = (placeId: string | undefined, index: number): string => {
    const place = placeId ? doc.places.find((p) => p.id === placeId) : undefined;
    const name = place?.name?.trim();
    return (name || `Scene ${index}`).slice(0, PRO_PAGE_LIMITS.sceneNameChars);
  };
  let cur: Scene | undefined;
  for (const page of byN(doc)) {
    const place = dominantPlaceOf(page);
    if (cur && !cur.placeId && place) {
      cur.placeId = place;
      cur.name = nameOf(place, scenes.length);
    } else if ((!cur || (place && place !== cur.placeId)) && scenes.length < CONSISTENCY_LIMITS.scenes) {
      cur = { id: nextId(), name: nameOf(place, scenes.length + 1), ...(place ? { placeId: place } : {}) };
      scenes.push(cur);
    }
    if (cur) byPage[page.id] = cur.id;
  }
  return { scenes, byPage };
};

/** Every page's scene, where it came from, and the page each scene run began on. */
export interface SceneIndex {
  from: SceneSource;
  byPage: Record<string, string | undefined>;
  /** pageId → the page number its scene run began on (pages with a scene only). */
  since: Record<string, number>;
  /** The scene records the ids refer to. */
  scenes: Scene[];
}

/** The book has ledger scenes: at least one page names its scene. */
export const hasLedgerScenes = (doc: Pick<ComicDoc, 'pages'>): boolean => doc.pages.some((p) => !!p.continuity?.sceneId);

/**
 * Scenes per page: the ledger's (a page's sceneId carries forward until another page names one) when any page names
 * one; else, with `derive`, deriveScenes; else none.
 */
export const sceneIndex = (doc: Pick<ComicDoc, 'pages' | 'places' | 'scenes'>, opts: { derive?: boolean } = {}): SceneIndex => {
  const pages = byN(doc);
  const byPage: Record<string, string | undefined> = {};
  let from: SceneSource = 'none';
  let scenes: Scene[] = [];
  if (hasLedgerScenes(doc)) {
    from = 'ledger';
    scenes = scenesOf(doc);
    let cur: string | undefined;
    for (const p of pages) {
      if (p.continuity?.sceneId) cur = p.continuity.sceneId;
      byPage[p.id] = cur;
    }
  } else if (opts.derive) {
    const derived = deriveScenes(doc);
    from = derived.scenes.length ? 'derived' : 'none';
    scenes = derived.scenes;
    for (const p of pages) byPage[p.id] = derived.byPage[p.id];
  } else for (const p of pages) byPage[p.id] = undefined;
  const since: Record<string, number> = {};
  let prev: Page | undefined;
  for (const p of pages) {
    const s = byPage[p.id];
    if (s !== undefined) since[p.id] = prev && byPage[prev.id] === s ? since[prev.id] : p.n;
    prev = p;
  }
  return { from, byPage, since, scenes };
};

// ── The fold ─────────────────────────────────────────────────────────────────

interface Fold {
  cast: Map<string, CastState>;
  props: Map<string, PropState>;
  gone: Map<string, number>;
}

/** What one page's ledger did, for the lint. */
interface PageEvents {
  clearedNothing: { castId: string; field?: CastStateField }[];
  propClearedNothing: string[];
  repeats: { castId: string; field: CastStateField }[];
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const cloneCast = (s: CastState): CastState => ({
  ...s,
  ...(s.holding ? { holding: [...s.holding] } : {}),
  ...(s.marks ? { marks: [...s.marks] } : {}),
  since: { ...s.since }
});

const applyChange = (fold: Fold, castId: string, change: CastStateChange | null, n: number, ev: PageEvents): void => {
  const cur = fold.cast.get(castId);
  if (change === null) {
    if (!cur) ev.clearedNothing.push({ castId });
    fold.cast.delete(castId);
    return;
  }
  const next: CastState = cur ? cloneCast(cur) : { since: {} };
  for (const field of FIELDS) {
    if (!(field in change)) continue;
    const value = change[field];
    if (value === undefined) continue;
    if (value === null) {
      if (next[field] === undefined) ev.clearedNothing.push({ castId, field });
      delete next[field];
      delete next.since[field];
      continue;
    }
    if (next[field] !== undefined && sameValue(next[field], value)) {
      ev.repeats.push({ castId, field });
      continue;
    }
    (next as unknown as Record<string, unknown>)[field] = Array.isArray(value) ? [...value] : value;
    next.since[field] = n;
  }
  if (FIELDS.some((f) => next[f] !== undefined)) fold.cast.set(castId, next);
  else fold.cast.delete(castId);
};

/**
 * Walk the book in page order up to `stopAt` (inclusive), applying each page's ledger with the carry rules.
 * `visit` sees each page with the state after its changes.
 */
const foldLedger = (
  doc: ComicDoc,
  scenes: SceneIndex,
  visit: (page: Page, fold: Fold, ev: PageEvents) => boolean | void
): void => {
  const known = new Set(doc.cast.map((c) => c.id));
  const fold: Fold = { cast: new Map(), props: new Map(), gone: new Map() };
  let prev: Page | undefined;
  for (const page of byN(doc)) {
    // A new page: `where` holds for one page only; a new scene drops what people were holding.
    const newScene = !!prev && scenes.byPage[prev.id] !== scenes.byPage[page.id];
    for (const [id, s] of [...fold.cast]) {
      const next = cloneCast(s);
      for (const field of FIELDS) {
        const scope = CONTINUITY_CARRY[field];
        if (scope === 'page' || (scope === 'scene' && newScene)) {
          delete next[field];
          delete next.since[field];
        }
      }
      if (FIELDS.some((f) => next[f] !== undefined)) fold.cast.set(id, next);
      else fold.cast.delete(id);
    }
    const ev: PageEvents = { clearedNothing: [], propClearedNothing: [], repeats: [] };
    const cont = page.continuity;
    if (cont?.cast) {
      for (const [id, change] of Object.entries(cont.cast)) {
        if (!known.has(id)) continue;
        applyChange(fold, id, change, page.n, ev);
      }
    }
    if (cont?.props) {
      for (const [name, state] of Object.entries(cont.props)) {
        if (state === null) {
          if (!fold.props.has(name) && !fold.gone.has(name)) ev.propClearedNothing.push(name);
          fold.props.delete(name);
          if (!fold.gone.has(name)) fold.gone.set(name, page.n);
        } else {
          fold.gone.delete(name);
          if (fold.props.get(name)?.state !== state) fold.props.set(name, { state, since: page.n });
        }
      }
    }
    if (visit(page, fold, ev) === false) return;
    prev = page;
  }
};

const pageOf = (doc: ComicDoc, pageOrId: Page | string): Page | undefined =>
  typeof pageOrId === 'string' ? doc.pages.find((p) => p.id === pageOrId) : doc.pages.find((p) => p.id === pageOrId.id) ?? pageOrId;

/**
 * The continuity a page is drawn with: its scene, every character's carried state (with `since`), prop states, props
 * that are gone and the page's own notes. Undefined when the page is not in the book. Pure, $0.
 */
export const resolveContinuity = (doc: ComicDoc, pageOrId: Page | string): ContinuityState | undefined => {
  const target = pageOf(doc, pageOrId);
  if (!target || !doc.pages.some((p) => p.id === target.id)) return undefined;
  const scenes = sceneIndex(doc, { derive: true });
  let out: ContinuityState | undefined;
  foldLedger(doc, scenes, (page, fold) => {
    if (page.id !== target.id) return true;
    const sceneId = scenes.byPage[page.id];
    const scene = sceneId ? scenes.scenes.find((s) => s.id === sceneId) : undefined;
    const cast: Record<string, CastState> = {};
    for (const [id, s] of fold.cast) cast[id] = cloneCast(s);
    const props: Record<string, PropState> = {};
    for (const [name, p] of fold.props) props[name] = { ...p };
    const gone: Record<string, number> = {};
    for (const [name, n] of fold.gone) gone[name] = n;
    const notes = [...(page.continuity?.notes ?? [])];
    const ledgerScene = scenes.from === 'ledger' && !!sceneId;
    out = {
      pageId: page.id,
      n: page.n,
      ...(sceneId ? { sceneId } : {}),
      ...(scene ? { scene } : {}),
      ...(sceneId !== undefined && scenes.since[page.id] !== undefined ? { sceneSince: scenes.since[page.id] } : {}),
      sceneFrom: sceneId ? scenes.from : 'none',
      cast,
      props,
      gone,
      notes,
      content: ledgerScene || Object.keys(cast).length > 0 || Object.keys(props).length > 0 || Object.keys(gone).length > 0 || notes.length > 0
    };
    return false;
  });
  return out;
};

// ── Lint ─────────────────────────────────────────────────────────────────────

export type ContinuityIssueKind =
  | 'unknown_scene'
  | 'unknown_cast'
  | 'not_on_page'
  | 'held_twice'
  | 'prop_gone_held'
  | 'scene_place'
  | 'clears_nothing'
  | 'repeats';

export interface ContinuityIssue {
  pageId: string;
  n: number;
  kind: ContinuityIssueKind;
  severity: 'minor' | 'major';
  castId?: string;
  prop?: string;
  /** Plain words for the card and the editor. */
  text: string;
}

const FIELD_WORDS: Record<CastStateField, string> = { outfit: 'outfit', holding: 'what they hold', marks: 'marks', where: 'where they are' };

/** "MEERA" (the name upper-cased, as prompts and cards name people), else the id. */
export const castNameOf = (doc: Pick<ComicDoc, 'cast'>, id: string): string => (doc.cast.find((c) => c.id === id)?.name?.trim() || id).toUpperCase();

const ARTICLE_RE = /^(?:the|a|an|his|her|their|its|my|your|our)\s+/;
/** An item or prop name for matching: lower case, no leading article, single spaces. */
export const itemKey = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim().replace(ARTICLE_RE, '');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "the old lantern" matches the prop "lantern" (whole words); equal keys match. */
export const itemMatches = (item: string, prop: string): boolean => {
  const a = itemKey(item);
  const b = itemKey(prop);
  if (!a || !b) return false;
  return a === b || new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(b)}($|[^\\p{L}\\p{N}])`, 'u').test(a);
};

const onPage = (page: Page, castId: string): boolean => page.panels.some((p) => p.castIds.includes(castId));

/**
 * Contradictions and slips in the ledger, page by page ($0; the breakdown card and the editor show them): a scene the
 * book doesn't have, changes for someone not in the cast, where someone stands on a page they're not drawn on, one
 * item held by two people, a gone prop still held, a scene set somewhere the page's panels are not, a clear with
 * nothing to clear, a change to what is already true. A book without ledger data has none.
 */
export const lintContinuity = (doc: ComicDoc): ContinuityIssue[] => {
  const out: ContinuityIssue[] = [];
  const known = new Set(doc.cast.map((c) => c.id));
  const sceneIds = new Set(scenesOf(doc).map((s) => s.id));
  const scenes = sceneIndex(doc, { derive: true });
  const name = (id: string) => castNameOf(doc, id);
  foldLedger(doc, scenes, (page, fold, ev) => {
    const at = { pageId: page.id, n: page.n };
    const cont = page.continuity;
    if (cont?.sceneId && !sceneIds.has(cont.sceneId)) {
      out.push({ ...at, kind: 'unknown_scene', severity: 'major', text: `Page ${page.n} is set in a scene the book doesn't have.` });
    }
    for (const [id, change] of Object.entries(cont?.cast ?? {})) {
      if (!known.has(id)) {
        out.push({ ...at, kind: 'unknown_cast', severity: 'major', castId: id, text: `Page ${page.n} changes someone who isn't in the cast.` });
        continue;
      }
      if (change && typeof change.where === 'string' && !onPage(page, id)) {
        out.push({ ...at, kind: 'not_on_page', severity: 'minor', castId: id, text: `Page ${page.n} says where ${name(id)} is, but ${name(id)} isn't drawn on page ${page.n}.` });
      }
    }
    for (const c of ev.clearedNothing) {
      out.push({
        ...at,
        kind: 'clears_nothing',
        severity: 'minor',
        castId: c.castId,
        text: c.field
          ? `Page ${page.n} clears ${name(c.castId)}'s ${FIELD_WORDS[c.field]}, but nothing was set before.`
          : `Page ${page.n} clears every change for ${name(c.castId)}, but none was set before.`
      });
    }
    for (const prop of ev.propClearedNothing) {
      out.push({ ...at, kind: 'clears_nothing', severity: 'minor', prop, text: `Page ${page.n} says “${prop}” is gone, but it was never there.` });
    }
    for (const r of ev.repeats) {
      out.push({ ...at, kind: 'repeats', severity: 'minor', castId: r.castId, text: `Page ${page.n} sets ${name(r.castId)}'s ${FIELD_WORDS[r.field]} to what it already is.` });
    }
    // One item, two hands — reported on the page where it arises (either holder changed here).
    const holders = [...fold.cast].filter(([, s]) => s.holding?.length);
    for (let i = 0; i < holders.length; i += 1) {
      for (let j = i + 1; j < holders.length; j += 1) {
        const [a, sa] = holders[i];
        const [b, sb] = holders[j];
        if (sa.since.holding !== page.n && sb.since.holding !== page.n) continue;
        const shared = sa.holding!.find((x) => sb.holding!.some((y) => itemKey(x) === itemKey(y)));
        if (shared) {
          out.push({ ...at, kind: 'held_twice', severity: 'major', castId: b, text: `On page ${page.n} ${name(a)} and ${name(b)} both hold “${shared}”.` });
        }
      }
    }
    // A gone prop still held — reported where the hold or the loss is recorded.
    for (const [prop, goneAt] of fold.gone) {
      for (const [id, s] of fold.cast) {
        if (!s.holding?.length) continue;
        if (goneAt !== page.n && s.since.holding !== page.n) continue;
        const item = s.holding.find((x) => itemMatches(x, prop));
        if (item) {
          out.push({ ...at, kind: 'prop_gone_held', severity: 'major', castId: id, prop, text: `On page ${page.n} ${name(id)} still holds “${item}”, but “${prop}” is gone from page ${goneAt}.` });
        }
      }
    }
    // The ledger's scene is somewhere none of the page's panels are.
    const sceneId = scenes.from === 'ledger' ? scenes.byPage[page.id] : undefined;
    const scene = sceneId ? scenes.scenes.find((s) => s.id === sceneId) : undefined;
    const places = page.panels.map((p) => p.placeId).filter((p): p is string => !!p);
    if (scene?.placeId && places.length && !places.includes(scene.placeId)) {
      const sceneAt = doc.places.find((p) => p.id === scene.placeId)?.name?.toUpperCase() || 'another place';
      out.push({ ...at, kind: 'scene_place', severity: 'minor', text: `Page ${page.n}'s scene is at ${sceneAt}, but none of its panels are there.` });
    }
    return true;
  });
  return out;
};

// ── The previous page a page job attaches ────────────────────────────────────

export type ContinuityAnchorWhy =
  /** The page right before, in the same scene, drawn: "PREVIOUS PAGE (same scene)". */
  | 'same_scene'
  /** No ledger scene for this page: today's rule, the nearest earlier drawn page. */
  | 'previous'
  /** The page starts a scene: nothing from another scene is attached. */
  | 'scene_start'
  /** The page right before is in the same scene but not drawn (yet): a run waits for it, else nothing. */
  | 'waiting'
  /** Nothing drawn before this page. */
  | 'none';

export interface ContinuityAnchor {
  page?: Page;
  why: ContinuityAnchorWhy;
  /** The anchor page is not drawn yet; it is drawn earlier in the same run (assumeDrawn). */
  pending?: true;
}

const drawnNow = (p: Page): boolean => p.render.status === 'ready' && !!p.render.asset?.path && canServeToOwner(p.render.asset);

/**
 * The page whose drawing a page job attaches for continuity. With a ledger scene: the page right before, when it is in
 * the same scene and drawn (never a page further back: a non-adjacent page of the scene is never the anchor). Without
 * one: the nearest earlier drawn page, exactly sendable.ts nearestReadyBefore (I8). `assumeDrawn` = page ids a run draws
 * first (the quote and the run plan treat them as drawn; the anchor is `pending`).
 */
export const continuityAnchorFor = (doc: ComicDoc, page: Page, opts: { assumeDrawn?: ReadonlySet<string> } = {}): ContinuityAnchor => {
  const assume = opts.assumeDrawn;
  const drawn = (p: Page) => drawnNow(p) || !!assume?.has(p.id);
  const pick = (p: Page, why: ContinuityAnchorWhy): ContinuityAnchor => ({ page: p, why, ...(!drawnNow(p) ? { pending: true as const } : {}) });
  const scenes = sceneIndex(doc);
  const sceneId = scenes.from === 'ledger' ? scenes.byPage[page.id] : undefined;
  if (!sceneId) {
    const nearest = doc.pages.filter((p) => p.n < page.n && p.id !== page.id && drawn(p)).sort((a, b) => b.n - a.n)[0];
    return nearest ? pick(nearest, 'previous') : { why: 'none' };
  }
  const before = doc.pages.filter((p) => p.n < page.n && p.id !== page.id).sort((a, b) => b.n - a.n)[0];
  if (!before) return { why: 'none' };
  if (scenes.byPage[before.id] !== sceneId) return { why: 'scene_start' };
  return drawn(before) ? pick(before, 'same_scene') : { why: 'waiting' };
};

// ── Scene chains for a run ───────────────────────────────────────────────────

export interface RunChain {
  sceneId?: string;
  /** In drawing order: each page after the first starts when the one before has its image stored. */
  pageIds: string[];
}

export interface RunChains {
  /** The book's first page, drawn alone before every other chain starts (it sets the look). */
  first?: string;
  chains: RunChain[];
  /** pageId → the page whose image must be stored before it starts. */
  after: Record<string, string>;
}

/**
 * Group a run's pages into scene chains (pro plan §4.2 "Scene-ordered runs"; PD-3). A page joins the chain of the page
 * right before it in the book when that page is also drawn in this run and in the same scene (ledger scenes, else
 * scenes derived from places), so a chain only ever waits on its adjacent page. When the book's first page is in the
 * run it is drawn alone first and every other chain starts after it. `storyOrder: false` = every page on its own
 * (today's order). Chains are listed by their first page. Pure; the scheduler (B7) runs them, ≤ its own parallel cap.
 */
export const runChains = (doc: ComicDoc, pageIds: readonly string[], opts: { storyOrder?: boolean } = {}): RunChains => {
  const ids = new Set(pageIds);
  const pages = byN(doc);
  const targets = pages.filter((p) => ids.has(p.id));
  if (opts.storyOrder === false) {
    return { chains: targets.map((p) => ({ pageIds: [p.id] })), after: {} };
  }
  const scenes = sceneIndex(doc, { derive: true });
  const prevOf = new Map<string, Page | undefined>();
  pages.forEach((p, i) => prevOf.set(p.id, i > 0 ? pages[i - 1] : undefined));
  const chains: RunChain[] = [];
  const chainOf = new Map<string, RunChain>();
  const after: Record<string, string> = {};
  for (const page of targets) {
    const before = prevOf.get(page.id);
    const sceneId = scenes.byPage[page.id];
    const joined = before && ids.has(before.id) && scenes.byPage[before.id] === sceneId ? chainOf.get(before.id) : undefined;
    if (joined && before) {
      joined.pageIds.push(page.id);
      after[page.id] = before.id;
      chainOf.set(page.id, joined);
    } else {
      const chain: RunChain = { ...(sceneId ? { sceneId } : {}), pageIds: [page.id] };
      chains.push(chain);
      chainOf.set(page.id, chain);
    }
  }
  const bookFirst = pages[0];
  const first = bookFirst && ids.has(bookFirst.id) ? bookFirst.id : undefined;
  if (first) for (const chain of chains) if (chain.pageIds[0] !== first) after[chain.pageIds[0]] = first;
  return { ...(first ? { first } : {}), chains, after };
};
