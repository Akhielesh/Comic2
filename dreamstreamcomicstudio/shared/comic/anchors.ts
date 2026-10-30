// Consistency anchors (Ship 2, B4; pro plan §4.2 "Reference planner" and "Anchors", §4.8, §8 "Model lock"). Pure, $0.
//
// planAnchors(doc, page, spec, lock) decides which reference images a page job attaches, in which slot and in which
// order, and says why anything else is described in words — the same function on the client and the server, so the
// breakdown card, the director and the page prompt (B5 builds planPageReferences from it) never disagree.
//
// Two modes:
//  - 'ship1' (every COMIC_CONSISTENCY_ANCHORS kind off — the default until the A/B): exactly today's
//    server/src/comic/prompts.ts planPageReferences selection and order (a parity test pins it), so a doc without new
//    data compiles byte for byte (I8). The previous page is the continuity anchor (nearestReadyBefore without ledger
//    scenes).
//  - 'anchors' (the places, props or styleKey kind on — ANCHOR_PLAN_KINDS; sheetV2 only changes how new sheets are laid
//    out, so it alone leaves the page plan in 'ship1'): the plan's priority — beings by page rank (character slots) →
//    style board, else the style key page (styleKey) → the same-scene previous page → ≤ ANCHOR_CAPS.placesPerPage
//    places (the cap only with places on) → ≤ ANCHOR_CAPS.propsPerPage props (props on: object slots, so props stop
//    using character slots) → spare character slots for likeness photos; one object slot reserved first for the layout
//    guide when it is on. The total is capped by the locked model's refs.total and doc.consistency.maxRefs
//    (CONSISTENCY_LIMITS.maxRefsDefault).
//
// Caps come only from the model registry (spec.refs) and the K2a limits; the lock's model always wins over the tier
// (a job never draws on another model). Anchors (sheets worth making, once per book): lead/support beings and props as
// today, recurring extras, and places/props on ≥ CONSISTENCY_LIMITS.recurringPages pages and ≥ recurringPanels panels.
//
// Also here: partsStale / staleReasons (what changed since a page version was drawn, from VersionMeta.parts).

import { continuityAnchorFor } from './continuity.js';
import { castKindOf, consistencyOf, type AssetRef, type Character, type ComicDoc, type ImageModelLock, type Page, type PanelParts, type Place, type RefAsset, type RenderState, type Resolution, type VersionMeta } from './doc.js';
import { CONSISTENCY_LIMITS } from './limits.js';
import { lockOf } from './modelLock.js';
import { getImageModel, resolveImageJob, type ImageModelSpec } from './models.js';
import { partsOf } from './parts.js';
import { isPhotoLikeness, pickRefs, type RefContext } from './refRanking.js';
import { REF_LIMITS } from './refs.js';
import { canServeToOwner, effectiveRating, type ContentRating } from './safety.js';

// ── Flags and constants ──────────────────────────────────────────────────────

/** The COMIC_CONSISTENCY_ANCHORS kinds (pro plan §4.8): each turns on only after the A/B and C5's ticked line items. */
export type AnchorKind = 'places' | 'props' | 'styleKey' | 'sheetV2';
export type AnchorKinds = Readonly<Record<AnchorKind, boolean>>;
export const ANCHOR_KINDS: readonly AnchorKind[] = ['places', 'props', 'styleKey', 'sheetV2'];
/** Provisional default (PD-7, PD-8): every kind off. */
export const ANCHOR_KINDS_OFF: AnchorKinds = { places: false, props: false, styleKey: false, sheetV2: false };
/** The server env var; the server reads it and passes anchorKindsFromFlag(value). */
export const ANCHORS_ENV = 'COMIC_CONSISTENCY_ANCHORS';

/** "1" / "true" / "all" = every kind; "places,props" = those; anything else = none. */
export const anchorKindsFromFlag = (value: unknown): AnchorKinds => {
  if (typeof value !== 'string') return ANCHOR_KINDS_OFF;
  const v = value.trim();
  if (/^(1|true|all|on)$/i.test(v)) return { places: true, props: true, styleKey: true, sheetV2: true };
  const set = new Set(v.split(/[\s,]+/).filter(Boolean));
  return { places: set.has('places'), props: set.has('props'), styleKey: set.has('styleKey'), sheetV2: set.has('sheetV2') };
};

/** A full kinds record from a partial one (absent = off). */
export const anchorKindsOf = (kinds?: Partial<AnchorKinds>): AnchorKinds => ({ ...ANCHOR_KINDS_OFF, ...(kinds ?? {}) });
export const anyAnchorKind = (kinds?: Partial<AnchorKinds>): boolean => ANCHOR_KINDS.some((k) => !!kinds?.[k]);

/** The kinds that change which references a page attaches. sheetV2 changes only how NEW sheets are laid out (one image,
 *  same spec hash), so with it alone every page plans exactly as today ('ship1'). */
export const ANCHOR_PLAN_KINDS: readonly AnchorKind[] = ['places', 'props', 'styleKey'];
/** planAnchors runs in 'anchors' mode (priorities, maxRefs default) only when one of ANCHOR_PLAN_KINDS is on. */
export const plansWithAnchors = (kinds?: Partial<AnchorKinds>): boolean => ANCHOR_PLAN_KINDS.some((k) => !!kinds?.[k]);

/** K2a's limits, read with the per-page anchor counts B4 asked for (CONSISTENCY_LIMITS.placeAnchors / propAnchors,
 *  amendment 1); until the contract carries them the plan's numbers (§4.2) stand in. */
const LIMITS = CONSISTENCY_LIMITS as typeof CONSISTENCY_LIMITS & Partial<Record<'placeAnchors' | 'propAnchors', number>>;
/**
 * Per-page caps of the plan (§4.2: "≤ 2 place sheets → ≤ 2 prop sheets", one reserved slot for the layout guide) and
 * the style-slot rule today's page compile uses (prompts.ts styleReferences: a style-class model takes the board plus
 * up to styleUserRefs ranked user style references, at most styleClassMax in its style slots). One place for each
 * number; B5 reads the style pair from here when it rebuilds planPageReferences on planAnchors.
 */
export const ANCHOR_CAPS = {
  placesPerPage: LIMITS.placeAnchors ?? 2,
  propsPerPage: LIMITS.propAnchors ?? 2,
  layoutGuide: 1,
  styleClassMax: 3,
  styleUserRefs: 2
} as const;
/** Place and prop sheets draw at 1K (pro plan §4.2); the quote prices them there. */
export const ANCHOR_SHEET_RES: Resolution = '1K';

// ── Keys ─────────────────────────────────────────────────────────────────────

/** Anchor keys (VersionMeta.anchorKeys, consistency.skip): stable per entity, ≤ PRO_PAGE_LIMITS.anchorKeyChars. */
export const anchorKeys = {
  cast: (c: Pick<Character, 'id' | 'kind'>): string => (castKindOf(c as Character) === 'object' ? `prop:${c.id}` : `char:${c.id}`),
  likeness: (id: string): string => `photo:${id}`,
  photo2: (id: string): string => `photo2:${id}`,
  place: (id: string): string => `place:${id}`,
  style: 'style',
  styleKey: (pageId: string): string => `stylekey:${pageId}`,
  previous: (pageId: string): string => `prev:${pageId}`,
  layout: 'layout'
} as const;

// ── Appearances and eligibility ──────────────────────────────────────────────

export interface Appearance {
  /** Page ids in page order. */
  pages: string[];
  panels: number;
}
export interface Appearances {
  cast: Map<string, Appearance>;
  places: Map<string, Appearance>;
}

/** Where every cast member and place appears: pages (in order) and panels (each panel once). */
export const appearances = (doc: Pick<ComicDoc, 'pages'>): Appearances => {
  const cast = new Map<string, Appearance>();
  const places = new Map<string, Appearance>();
  const add = (map: Map<string, Appearance>, id: string, pageId: string) => {
    const a = map.get(id) ?? { pages: [], panels: 0 };
    a.panels += 1;
    if (a.pages[a.pages.length - 1] !== pageId && !a.pages.includes(pageId)) a.pages.push(pageId);
    map.set(id, a);
  };
  for (const page of [...doc.pages].sort((a, b) => a.n - b.n)) {
    for (const panel of page.panels) {
      for (const id of new Set(panel.castIds)) add(cast, id, page.id);
      if (panel.placeId) add(places, panel.placeId, page.id);
    }
  }
  return { cast, places };
};

/** On ≥ CONSISTENCY_LIMITS.recurringPages pages and in ≥ recurringPanels panels. */
export const isRecurring = (a: Appearance | undefined): boolean =>
  !!a && a.pages.length >= CONSISTENCY_LIMITS.recurringPages && a.panels >= CONSISTENCY_LIMITS.recurringPanels;

/**
 * Whether an entity deserves an anchor (a sheet made once and attached everywhere): beings and props of lead/support
 * tier (as today) or recurring; places that recur. Keys: 'char:<id>', 'prop:<id>', 'place:<id>'. Presence-based page
 * references are wider (any being with a ready sheet or photo is attached); this decides what is worth MAKING.
 */
export const anchorEligible = (doc: Pick<ComicDoc, 'cast' | 'places' | 'pages'>, key: string, apps: Appearances = appearances(doc)): boolean => {
  const at = key.indexOf(':');
  if (at <= 0) return false;
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  if (!id) return false;
  if (kind === 'char' || kind === 'prop') {
    const c = doc.cast.find((x) => x.id === id);
    if (!c || anchorKeys.cast(c) !== key) return false;
    return c.tier !== 'extra' || isRecurring(apps.cast.get(id));
  }
  if (kind === 'place') return doc.places.some((p) => p.id === id) && isRecurring(apps.places.get(id));
  return false;
};

// ── The plan ─────────────────────────────────────────────────────────────────

export type AnchorRole = 'layout' | 'character' | 'likeness' | 'photo2' | 'style' | 'style_key' | 'previous' | 'place' | 'prop';
export type AnchorSlot = 'character' | 'object' | 'style';

export interface PlannedAnchor {
  key: string;
  role: AnchorRole;
  slot: AnchorSlot;
  /** What is attached: a sheet, a user photo, the style board, a user style reference, a page drawing, the guide. */
  source: 'sheet' | 'photo' | 'board' | 'style_ref' | 'page' | 'guide';
  /** The image path; absent for the layout guide (rendered by the runner) and for pending anchors. */
  path?: string;
  /** The character, place or page id. */
  id?: string;
  /** "MEERA", "NIGHT MARKET", "STYLE BOARD", "PAGE 2". */
  name: string;
  /** Not drawn yet: the run draws it first (assumeReady / assumeDrawn). */
  pending?: true;
}

export type AnchorOverflowWhy = 'cap' | 'no_ref' | 'blocked' | 'off' | 'skipped';

export interface AnchorOverflow {
  key: string;
  role: 'character' | 'prop' | 'place' | 'previous' | 'style_key';
  id: string;
  name: string;
  why: AnchorOverflowWhy;
  /** With why 'cap': which limit ran out. */
  slot?: 'character' | 'object' | 'total' | 'kind';
  /** "This model keeps 4 characters on model per page. FROG is described in words on this page." */
  text: string;
}

export interface AnchorCaps {
  total: number;
  characters: number;
  objects: number;
  style: number;
  /** doc.consistency.maxRefs, or the default in 'anchors' mode; absent = the model's total only. */
  maxRefs?: number;
}

export interface AnchorPlan {
  mode: 'ship1' | 'anchors';
  /** The registry id of the model the plan is for (the lock's when locked). */
  modelId: string;
  caps: AnchorCaps;
  /** In attachment order (C19): layout guide → characters → places → props → style → previous page. */
  attached: PlannedAnchor[];
  overflow: AnchorOverflow[];
  /** Beings, places and props on the page that are described in words only. */
  textOnly: string[];
  /** One object slot is kept for the layout guide. */
  reserved: boolean;
  /** Attached keys for VersionMeta.anchorKeys (≤ CONSISTENCY_LIMITS.anchorKeys). */
  keys: string[];
}

export interface AnchorOptions {
  /** COMIC_CONSISTENCY_ANCHORS kinds that are on (absent = all off = 'ship1'; only ANCHOR_PLAN_KINDS change the plan,
   *  each gating its own behaviour: places the per-page place cap, props the object slots for props, any of the three
   *  the anchors order and the maxRefs default). */
  kinds?: Partial<AnchorKinds>;
  /** COMIC_LAYOUT_GUIDE: reserve one object slot (first) for the layout guide. */
  layoutGuide?: boolean;
  /** The job's effective content rating (prompts.ts artRatingFor); default the doc's effective rating. */
  rating?: ContentRating;
  /** The page the runner attaches for continuity (null = none); absent = continuityAnchorFor. */
  previousPage?: Page | null;
  /** Anchor keys whose sheet the run draws first ('char:…', 'prop:…', 'place:…'): planned as pending. */
  assumeReady?: ReadonlySet<string>;
  /** Page ids the run draws before this page (continuity and style key anchors may be pending). */
  assumeDrawn?: ReadonlySet<string>;
}

const servable = (a?: AssetRef): a is AssetRef => !!a?.path && canServeToOwner(a);
const usableSheet = (r?: RenderState): string | undefined => (r && r.status === 'ready' && servable(r.asset) ? r.asset.path : undefined);
const blockedSheet = (r?: RenderState): boolean => !!r && r.status === 'ready' && !!r.asset?.path && !canServeToOwner(r.asset);
const upper = (s: string | undefined, fallback: string): string => (s?.trim() || fallback).toUpperCase();
const TIER_RANK: Record<string, number> = { lead: 0, support: 1, extra: 2 };

/**
 * The page's cast ranked by importance on THIS page (the server's prompts.ts rankPageCast, kept identical): panel
 * appearances, then tier, then lines spoken (counted once the speaker has appeared), then the book's cast order.
 */
export const rankPageCast = (doc: Pick<ComicDoc, 'cast'>, page: Pick<Page, 'panels'>): Character[] => {
  const stats = new Map<string, { panels: number; lines: number }>();
  const known = new Set(doc.cast.map((c) => c.id));
  for (const panel of page.panels) {
    for (const id of new Set(panel.castIds)) {
      if (!known.has(id)) continue;
      const s = stats.get(id) ?? { panels: 0, lines: 0 };
      s.panels += 1;
      stats.set(id, s);
    }
    for (const line of panel.lines) {
      if (!line.speakerId || !stats.has(line.speakerId)) continue;
      stats.get(line.speakerId)!.lines += 1;
    }
  }
  const order = new Map(doc.cast.map((c, i) => [c.id, i]));
  return doc.cast
    .filter((c) => stats.has(c.id))
    .sort((a, b) => {
      const sa = stats.get(a.id)!;
      const sb = stats.get(b.id)!;
      return sb.panels - sa.panels || (TIER_RANK[a.tier] ?? 1) - (TIER_RANK[b.tier] ?? 1) || sb.lines - sa.lines || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
    });
};

/** Places used on a page, most-used first (ties: first use) — prompts.ts's location order. */
const rankPagePlaces = (page: Pick<Page, 'panels'>): string[] => {
  const counts = new Map<string, { count: number; first: number }>();
  page.panels.forEach((panel, i) => {
    if (!panel.placeId) return;
    const e = counts.get(panel.placeId) ?? { count: 0, first: i };
    e.count += 1;
    counts.set(panel.placeId, e);
  });
  return [...counts.entries()].sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first).map(([id]) => id);
};

/**
 * The model a page job draws on: the lock's model when the registry knows it, else `spec`, else the doc's tier. `lock`
 * follows plan.ts's convention: absent (undefined) = the comic's own lock (lockOf: persisted, else the migration lock),
 * so a card that passes only the tier's spec still shows the locked model's caps; null = as if unlocked.
 */
export const anchorModelOf = (doc: ComicDoc, spec?: ImageModelSpec, lock?: ImageModelLock | null): ImageModelSpec => {
  const l = lock === undefined ? lockOf(doc) : (lock ?? undefined);
  const locked = l ? getImageModel(l.modelId) : undefined;
  if (locked) return locked;
  if (spec) return spec;
  return resolveImageJob('page', doc.settings.quality, doc.settings.imageModelOverride, l).spec;
};

/** The style key page for `page` (consistency.styleKeyPageId, else the book's first page), when drawn and not `page`. */
const styleKeyPageFor = (doc: ComicDoc, page: Page, assumeDrawn?: ReadonlySet<string>): { page: Page; pending: boolean } | undefined => {
  const id = consistencyOf(doc).styleKeyPageId ?? [...doc.pages].sort((a, b) => a.n - b.n)[0]?.id;
  const key = id ? doc.pages.find((p) => p.id === id) : undefined;
  if (!key || key.id === page.id) return undefined;
  if (key.render.status === 'ready' && servable(key.render.asset)) return { page: key, pending: false };
  return assumeDrawn?.has(key.id) ? { page: key, pending: true } : undefined;
};

interface Group {
  c: Character;
  refs: PlannedAnchor[];
  /** pass-1 photo (for pass 3). */
  photo?: string;
}

/**
 * Which references a page job attaches, in order, within the model's caps — and every being, place and prop it leaves
 * to words, with the reason. `spec` is the model the page job resolves to; `lock` is the comic's lock (its model wins;
 * undefined = the doc's own lock, null = unlocked — see anchorModelOf). See the header for the two modes. Pure; the
 * server's page compile and the client's card call the same function.
 */
export const planAnchors = (doc: ComicDoc, page: Page, spec: ImageModelSpec | undefined, lock: ImageModelLock | null | undefined, opts: AnchorOptions = {}): AnchorPlan => {
  const model = anchorModelOf(doc, spec, lock);
  const kinds = anchorKindsOf(opts.kinds);
  const mode: AnchorPlan['mode'] = plansWithAnchors(kinds) ? 'anchors' : 'ship1';
  const anchors = mode === 'anchors';
  const userMax = consistencyOf(doc).maxRefs;
  const maxRefs = userMax ?? (anchors ? CONSISTENCY_LIMITS.maxRefsDefault : undefined);
  const caps: AnchorCaps = {
    total: Math.max(0, Math.min(model.refs.total, maxRefs ?? Number.POSITIVE_INFINITY)),
    characters: Math.max(0, model.refs.characters),
    objects: Math.max(0, model.refs.objects),
    style: Math.max(0, model.refs.style),
    ...(maxRefs !== undefined ? { maxRefs } : {})
  };
  const budget = { total: caps.total, objects: caps.objects };
  const rating = opts.rating ?? effectiveRating(doc).rating;
  const ready = opts.assumeReady;
  const skip = new Set(consistencyOf(doc).skip ?? []);
  const overflow: AnchorOverflow[] = [];
  const totalBinds = maxRefs !== undefined && maxRefs < model.refs.total;
  const capText = (name: string, slot: 'character' | 'object' | 'total' | 'kind', what: 'places' | 'props' | 'characters', charSlots: number): string => {
    if (slot === 'total') {
      return totalBinds
        ? `This comic attaches at most ${caps.total} reference images per page. ${name} is described in words on this page.`
        : `This model takes at most ${caps.total} reference images per page. ${name} is described in words on this page.`;
    }
    if (slot === 'character') return `This model keeps ${charSlots} character${charSlots === 1 ? '' : 's'} on model per page. ${name} is described in words on this page.`;
    if (slot === 'kind') return `Only ${what === 'places' ? ANCHOR_CAPS.placesPerPage : ANCHOR_CAPS.propsPerPage} ${what} are attached per page. ${name} is described in words on this page.`;
    return `No reference slot is left for ${name} on this page. It is described in words.`;
  };
  const missText = (name: string, why: AnchorOverflowWhy): string =>
    why === 'blocked'
      ? `${name}'s picture can't be sent to the model, so it is described in words on this page.`
      : why === 'skipped'
        ? `You chose not to make a sheet for ${name}, so it is described in words on this page.`
        : why === 'off'
          ? `${name} is described in words on this page.`
          : `${name} has no sheet or photo yet, so it is described in words on this page.`;

  // 1. The layout guide: ANCHOR_CAPS.layoutGuide object slot(s), first — never a model's only object slot, and never
  //    the last reference (prompts.ts rule).
  const guide: PlannedAnchor[] = [];
  const guideSlots = ANCHOR_CAPS.layoutGuide;
  if (opts.layoutGuide && caps.objects > guideSlots && budget.objects >= guideSlots && budget.total > guideSlots) {
    guide.push({ key: anchorKeys.layout, role: 'layout', slot: 'object', source: 'guide', name: 'PAGE LAYOUT GUIDE' });
    budget.objects -= guideSlots;
    budget.total -= guideSlots;
  }

  // 2. Beings (pass 1): one reference each, in the page's rank order, within the character slots.
  const shotsOf = (id: string) => page.panels.filter((p) => p.castIds.includes(id)).map((p) => p.shot);
  const ctxFor = (c: Character): RefContext => ({ shots: shotsOf(c.id), effectiveRating: rating });
  const ranked = rankPageCast(doc, page);
  const isProp = (c: Character) => castKindOf(c) === 'object';
  const propsAsObjects = anchors && kinds.props;
  let slots = Math.min(caps.characters, budget.total);
  const charSlots = slots;
  const groups: Group[] = [];
  const missOf = (key: string, sheet: RenderState): AnchorOverflowWhy => (blockedSheet(sheet) ? 'blocked' : skip.has(key) ? 'skipped' : 'no_ref');
  for (const c of ranked) {
    const key = anchorKeys.cast(c);
    const name = upper(c.name, c.id);
    if (propsAsObjects && isProp(c)) continue; // props take object slots (step 6)
    if (c.tier === 'extra' && isProp(c)) {
      overflow.push({ key, role: 'prop', id: c.id, name, why: 'off', text: missText(name, 'off') });
      continue;
    }
    const sheet = usableSheet(c.sheet);
    const pending = !sheet && !!ready?.has(key);
    const photo = sheet || pending ? undefined : pickRefs(c.refs, 1, 'page', ctxFor(c))[0];
    if (!sheet && !pending && !photo) {
      const why = missOf(key, c.sheet);
      overflow.push({ key, role: 'character', id: c.id, name, why, text: missText(name, why) });
      continue;
    }
    if (slots <= 0) {
      const slot = budget.total <= 0 ? 'total' : 'character';
      overflow.push({ key, role: 'character', id: c.id, name, why: 'cap', slot, text: capText(name, slot, 'characters', charSlots) });
      continue;
    }
    groups.push({
      c,
      refs: [
        sheet || pending
          ? { key, role: 'character', slot: 'character', source: 'sheet', ...(sheet ? { path: sheet } : { pending: true as const }), id: c.id, name }
          : { key, role: 'character', slot: 'character', source: 'photo', path: photo!.path, id: c.id, name }
      ],
      ...(photo ? { photo: photo.path } : {})
    });
    slots -= 1;
    budget.total -= 1;
  }

  // Pass 2 and 3: spare character slots add a likeness photo next to a sheet, or a second photo.
  const likenessWanted = (c: Character, spare: number): boolean => {
    if (c.likeness === 'sheet_only') return false;
    if (c.likeness === 'sheet_and_photo') return true;
    return isPhotoLikeness(c) && (c.tier === 'lead' || spare >= 2);
  };
  const extraPhotos = () => {
    for (const g of groups) {
      if (slots <= 0 || budget.total <= 0) break;
      if (g.refs[0].source !== 'sheet' || !likenessWanted(g.c, slots)) continue;
      const photo = pickRefs(g.c.refs, 1, 'page', ctxFor(g.c))[0];
      if (!photo) continue;
      g.refs.push({ key: anchorKeys.likeness(g.c.id), role: 'likeness', slot: 'character', source: 'photo', path: photo.path, id: g.c.id, name: upper(g.c.name, g.c.id) });
      slots -= 1;
      budget.total -= 1;
    }
    for (const g of groups) {
      if (slots <= 0 || budget.total <= 0) break;
      if (g.refs[0].source !== 'photo') continue;
      const second = pickRefs(g.c.refs, REF_LIMITS.pagePhotosPerCharacter, 'page', ctxFor(g.c)).find((r: RefAsset) => r.path !== g.photo);
      if (!second) continue;
      g.refs.push({ key: anchorKeys.photo2(g.c.id), role: 'photo2', slot: 'character', source: 'photo', path: second.path, id: g.c.id, name: upper(g.c.name, g.c.id) });
      slots -= 1;
      budget.total -= 1;
    }
  };
  if (!anchors) extraPhotos(); // ship1: right after pass 1, exactly as today

  // 3. Style: the board, else (styleKey) the style key page, else the best user style reference.
  const style: PlannedAnchor[] = [];
  const board = servable(doc.style.board) ? doc.style.board.path : undefined;
  const keyPage = anchors && kinds.styleKey && !board ? styleKeyPageFor(doc, page, opts.assumeDrawn) : undefined;
  const keyAnchor = (slot: AnchorSlot): PlannedAnchor => ({
    key: anchorKeys.styleKey(keyPage!.page.id),
    role: 'style_key',
    slot,
    source: 'page',
    ...(keyPage!.pending ? { pending: true as const } : { path: keyPage!.page.render.asset!.path }),
    id: keyPage!.page.id,
    name: `PAGE ${keyPage!.page.n}`
  });
  const styleRef = (ref: RefAsset, n: number, slot: AnchorSlot): PlannedAnchor => ({ key: `${anchorKeys.style}:${n}`, role: 'style', slot, source: 'style_ref', path: ref.path, name: `STYLE REFERENCE ${n}` });
  if (caps.style > 0) {
    const max = Math.min(caps.style, ANCHOR_CAPS.styleClassMax, budget.total);
    if (board && style.length < max) style.push({ key: anchorKeys.style, role: 'style', slot: 'style', source: 'board', path: board, name: 'STYLE BOARD' });
    else if (keyPage && style.length < max) style.push(keyAnchor('style'));
    for (const ref of pickRefs(doc.style.refs, ANCHOR_CAPS.styleUserRefs, 'style', { effectiveRating: rating })) {
      if (style.length >= max) break;
      style.push(styleRef(ref, style.filter((s) => s.source === 'style_ref').length + 1, 'style'));
    }
    budget.total -= style.length;
  } else if (budget.objects > 0 && budget.total > 0) {
    if (board) style.push({ key: anchorKeys.style, role: 'style', slot: 'object', source: 'board', path: board, name: 'STYLE BOARD' });
    else if (keyPage) style.push(keyAnchor('object'));
    else {
      const best = pickRefs(doc.style.refs, 1, 'style', { effectiveRating: rating })[0];
      if (best) style.push(styleRef(best, 1, 'object'));
    }
    budget.objects -= style.length;
    budget.total -= style.length;
  }

  // The previous page (same scene with ledger scenes; else the nearest earlier drawn page).
  const previous: PlannedAnchor[] = [];
  const prev =
    opts.previousPage !== undefined
      ? opts.previousPage
        ? { page: opts.previousPage, pending: false }
        : undefined
      : (() => {
          const a = continuityAnchorFor(doc, page, { assumeDrawn: opts.assumeDrawn });
          return a.page ? { page: a.page, pending: !!a.pending } : undefined;
        })();
  const prevUsable =
    !!prev &&
    prev.page.id !== page.id &&
    (prev.pending || ((prev.page.render.status === 'ready' || prev.page.render.status === 'stale') && servable(prev.page.render.asset)));
  const attachPrevious = () => {
    if (!prev || !prevUsable) return;
    const key = anchorKeys.previous(prev.page.id);
    const name = `PAGE ${prev.page.n}`;
    if (budget.objects > 0 && budget.total > 0) {
      previous.push({ key, role: 'previous', slot: 'object', source: 'page', ...(prev.pending ? { pending: true as const } : { path: prev.page.render.asset!.path }), id: prev.page.id, name });
      budget.objects -= 1;
      budget.total -= 1;
    } else {
      const slot = budget.total <= 0 ? 'total' : 'object';
      overflow.push({ key, role: 'previous', id: prev.page.id, name, why: 'cap', slot, text: `No reference slot is left for page ${prev.page.n}'s drawing, so continuity with it is described in words.` });
    }
  };

  // Places: today all of them (object slots allowing); with the places kind ≤ ANCHOR_CAPS.placesPerPage.
  const places: PlannedAnchor[] = [];
  const attachPlaces = () => {
    for (const id of rankPagePlaces(page)) {
      const place: Place | undefined = doc.places.find((p) => p.id === id);
      if (!place) continue;
      const key = anchorKeys.place(id);
      const name = upper(place.name, id);
      const sheet = usableSheet(place.sheet);
      const pending = !sheet && !!ready?.has(key);
      const photo = sheet || pending ? undefined : pickRefs(place.refs, 1, 'place_sheet', { effectiveRating: rating })[0];
      if (!sheet && !pending && !photo) {
        const why = missOf(key, place.sheet);
        overflow.push({ key, role: 'place', id, name, why, text: missText(name, why) });
        continue;
      }
      const kindFull = anchors && kinds.places && places.length >= ANCHOR_CAPS.placesPerPage;
      if (kindFull || budget.objects <= 0 || budget.total <= 0) {
        const slot = kindFull ? 'kind' : budget.total <= 0 ? 'total' : 'object';
        overflow.push({ key, role: 'place', id, name, why: 'cap', slot, text: capText(name, slot, 'places', charSlots) });
        continue;
      }
      places.push({ key, role: 'place', slot: 'object', source: sheet || pending ? 'sheet' : 'photo', ...(sheet ? { path: sheet } : pending ? { pending: true as const } : { path: photo!.path }), id, name });
      budget.objects -= 1;
      budget.total -= 1;
    }
  };

  // Props (anchors + props kind): object-kind cast in page rank order, ≤ ANCHOR_CAPS.propsPerPage, object slots.
  const props: PlannedAnchor[] = [];
  const attachProps = () => {
    if (!propsAsObjects) return;
    for (const c of ranked.filter(isProp)) {
      const key = anchorKeys.cast(c);
      const name = upper(c.name, c.id);
      const sheet = usableSheet(c.sheet);
      const pending = !sheet && !!ready?.has(key);
      const photo = sheet || pending ? undefined : pickRefs(c.refs, 1, 'page', ctxFor(c))[0];
      if (!sheet && !pending && !photo) {
        const why = missOf(key, c.sheet);
        overflow.push({ key, role: 'prop', id: c.id, name, why, text: missText(name, why) });
        continue;
      }
      const kindFull = props.length >= ANCHOR_CAPS.propsPerPage;
      if (kindFull || budget.objects <= 0 || budget.total <= 0) {
        const slot = kindFull ? 'kind' : budget.total <= 0 ? 'total' : 'object';
        overflow.push({ key, role: 'prop', id: c.id, name, why: 'cap', slot, text: capText(name, slot, 'props', charSlots) });
        continue;
      }
      props.push({ key, role: 'prop', slot: 'object', source: sheet || pending ? 'sheet' : 'photo', ...(sheet ? { path: sheet } : pending ? { pending: true as const } : { path: photo!.path }), id: c.id, name });
      budget.objects -= 1;
      budget.total -= 1;
    }
  };

  if (anchors) {
    attachPrevious();
    attachPlaces();
    attachProps();
    extraPhotos();
  } else {
    attachPlaces();
    attachPrevious();
  }

  const attached = [...guide, ...groups.flatMap((g) => g.refs), ...places, ...props, ...style, ...previous];
  const textOnly = [...new Set(overflow.filter((o) => o.role === 'character' || o.role === 'prop' || o.role === 'place').map((o) => o.id))];
  return {
    mode,
    modelId: model.id,
    caps,
    attached,
    overflow,
    textOnly,
    reserved: guide.length > 0,
    keys: attached.map((a) => a.key).slice(0, CONSISTENCY_LIMITS.anchorKeys)
  };
};

// ── Staleness parts ──────────────────────────────────────────────────────────

export type StalePart = 'cast' | 'action' | 'place' | 'shot' | 'mood' | 'direction' | 'panel_added' | 'panel_removed' | 'continuity' | 'place_look' | 'prop';

export interface StaleReason {
  part: StalePart;
  panelId?: string;
  /** Panel number on the page now. */
  panel?: number;
  placeId?: string;
  prop?: string;
  /** "Panel 2: who's in it". */
  text: string;
}

/** The staleness words for a change in VersionParts.cont: this page's own continuity record or its scene. */
export const CONTINUITY_STALE_TEXT = "This page's continuity (outfits, props, notes or scene)";

const PANEL_PARTS: { k: keyof PanelParts; part: StalePart; words: string }[] = [
  { k: 'c', part: 'cast', words: "who's in it" },
  { k: 'a', part: 'action', words: 'what happens' },
  { k: 'p', part: 'place', words: 'the place' },
  { k: 's', part: 'shot', words: 'the shot' },
  { k: 'm', part: 'mood', words: 'the mood' },
  { k: 'd', part: 'direction', words: 'the direction' }
];

/**
 * What changed since a page version was drawn, part by part, from the version's VersionMeta.parts (K2b stamps
 * partsOf(doc, page) on each new page version) against partsOf of the live doc. A version without parts has no reasons
 * (I8: renders without parts never become stale from consistency features). `version` defaults to the page's current
 * render.
 */
export const staleReasons = (doc: ComicDoc, page: Page, version: Pick<VersionMeta, 'parts'> = page.render): StaleReason[] => {
  const before = version.parts;
  if (!before) return [];
  const now = partsOf(doc, page);
  const out: StaleReason[] = [];
  const was = before.panels ?? {};
  const is = now.panels ?? {};
  for (const panel of page.panels) {
    const a = was[panel.id];
    const b = is[panel.id];
    if (!b) continue;
    if (!a) {
      out.push({ part: 'panel_added', panelId: panel.id, panel: panel.n, text: `Panel ${panel.n} is new` });
      continue;
    }
    for (const { k, part, words } of PANEL_PARTS) {
      if (a[k] !== b[k]) out.push({ part, panelId: panel.id, panel: panel.n, text: `Panel ${panel.n}: ${words}` });
    }
  }
  for (const id of Object.keys(was)) {
    if (!is[id] && !page.panels.some((p) => p.id === id)) out.push({ part: 'panel_removed', panelId: id, text: 'A panel was removed' });
  }
  // `cont` fingerprints this page's own continuity record and its scene (parts.ts partsOf), not state carried from
  // earlier pages: an edit to page 1's outfit never marks page 3 here.
  if (before.cont !== now.cont) out.push({ part: 'continuity', text: CONTINUITY_STALE_TEXT });
  for (const [id, hash] of Object.entries(now.places ?? {})) {
    const old = before.places?.[id];
    if (old !== undefined && old !== hash) {
      const name = upper(doc.places.find((p) => p.id === id)?.name, id);
      out.push({ part: 'place_look', placeId: id, text: `How ${name} looks` });
    }
  }
  const propNames = [...new Set([...Object.keys(before.props ?? {}), ...Object.keys(now.props ?? {})])].sort();
  for (const name of propNames) {
    if (before.props?.[name] !== now.props?.[name]) out.push({ part: 'prop', prop: name, text: `The state of “${name}”` });
  }
  return out;
};

/** The page version was drawn from parts that have changed since (false when the version carries no parts: I8). */
export const partsStale = (doc: ComicDoc, page: Page, version: Pick<VersionMeta, 'parts'> = page.render): boolean => staleReasons(doc, page, version).length > 0;
