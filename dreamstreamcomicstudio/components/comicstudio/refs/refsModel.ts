// Pure helpers for the refs UI (owner names, move targets, honest usage badges, the sheet hint).
// Owner: P1-REFS. The badges come from the SAME ranking the prompt compiler uses (refRanking.ts),
// so "Used for the sheet" / "Used on pages" never lie about which photos reach the model.

import type { Character, ComicDoc, RefAsset, RefLabel, RefOwner } from '../../../shared/comic/doc';
import { resolveImageJob } from '../../../shared/comic/models';
import { quoteLockOf, unitPrice } from '../../../shared/comic/plan';
import { REF_LABELS_FOR, REF_LABEL_TEXT, REF_LIMITS, capFor, refOwnerKey, refsOf } from '../../../shared/comic/refs';
import { isPhotoLikeness, pickRefs, sheetRefs, sheetRefsChanged } from '../../../shared/comic/refRanking';
import { canServeToOwner } from '../../../shared/comic/safety';

const upper = (s?: string) => (s || '').trim().toUpperCase() || 'UNNAMED';

/** "MAYA", "SPICE MARKET", "the style", "the composer". */
export function ownerLabel(doc: ComicDoc | null | undefined, owner: RefOwner): string {
  switch (owner.kind) {
    case 'character': {
      const c = doc?.cast.find((x) => x.id === owner.id);
      return c ? upper(c.name) : 'This character';
    }
    case 'place': {
      const p = doc?.places.find((x) => x.id === owner.id);
      return p ? upper(p.name) : 'This place';
    }
    case 'style':
      return 'The style';
    default:
      return 'The composer';
  }
}

/** Drawer / card heading. */
export function ownerTitle(doc: ComicDoc | null | undefined, owner: RefOwner): string {
  switch (owner.kind) {
    case 'character': {
      const c = doc?.cast.find((x) => x.id === owner.id);
      return c ? `${c.name.trim() || 'Unnamed'} — photos` : 'Photos';
    }
    case 'place': {
      const p = doc?.places.find((x) => x.id === owner.id);
      return p ? `${p.name.trim() || 'Unnamed'} — photos` : 'Photos';
    }
    case 'style':
      return 'Your style references';
    default:
      return 'Photos waiting to be sent';
  }
}

export const ownerExists = (doc: ComicDoc | null | undefined, owner: RefOwner): boolean => !!doc && !!refsOf(doc, owner);

/** Labels this owner can carry. */
export const labelsFor = (owner: RefOwner): RefLabel[] => (owner.kind === 'inbox' ? REF_LABELS_FOR.character : REF_LABELS_FOR[owner.kind]);
export const labelText = (l?: RefLabel): string => (l ? REF_LABEL_TEXT[l] : 'Add a label');

/** Where a photo can be moved to (every other owner with room, cast leads first). */
export function moveTargets(doc: ComicDoc | null | undefined, from: RefOwner): { owner: RefOwner; label: string; full: boolean }[] {
  if (!doc) return [];
  const key = refOwnerKey(from);
  const rank = (c: Character) => (c.tier === 'lead' ? 0 : c.tier === 'support' ? 1 : 2);
  const out: { owner: RefOwner; label: string; full: boolean }[] = [];
  for (const c of [...doc.cast].sort((a, b) => rank(a) - rank(b))) {
    const owner: RefOwner = { kind: 'character', id: c.id };
    if (refOwnerKey(owner) !== key) out.push({ owner, label: c.name.trim() || 'Unnamed', full: c.refs.length >= capFor(owner) });
  }
  for (const p of doc.places) {
    const owner: RefOwner = { kind: 'place', id: p.id };
    if (refOwnerKey(owner) !== key) out.push({ owner, label: `${p.name.trim() || 'Unnamed'} (place)`, full: p.refs.length >= capFor(owner) });
  }
  if (key !== 'style') out.push({ owner: { kind: 'style' }, label: 'Style reference', full: doc.style.refs.length >= REF_LIMITS.style });
  return out;
}

// The model each job really draws on: the comic's locked model, else tier + override (as the server resolves it).
const sheetSlots = (doc: ComicDoc): number => {
  const spec = resolveImageJob('sheet', doc.settings.quality, doc.settings.imageModelOverride, quoteLockOf(doc)).spec;
  return spec.refs.characters > 0 ? spec.refs.characters : spec.refs.objects;
};
const pageSpec = (doc: ComicDoc) => resolveImageJob('page', doc.settings.quality, doc.settings.imageModelOverride, quoteLockOf(doc)).spec;
const pageSlots = (doc: ComicDoc): number => pageSpec(doc).refs.characters;

/**
 * How many of the user's style photos a page actually sends (mirrors prompts.ts styleReferences):
 * models with style slots take the style board plus up to 2 ranked photos (≤ 3 style refs in all);
 * the others take ONE style anchor — the board when there is one, else the best photo.
 */
export const styleRefsUsed = (doc: ComicDoc): number => {
  const spec = pageSpec(doc);
  const board = !!doc.style.board?.path && canServeToOwner(doc.style.board);
  if (spec.refs.style > 0) return Math.max(0, Math.min(2, Math.min(spec.refs.style, 3, spec.refs.total) - (board ? 1 : 0)));
  return board || spec.refs.objects <= 0 || spec.refs.total <= 0 ? 0 : 1;
};

export interface RefUsage {
  sheet?: boolean;
  pages?: boolean;
  style?: boolean;
}

/**
 * Which photos the compiler would send today (refs.md §5): the sheet's ≤ 4 diverse photos; on pages
 * the best photo while there is no sheet (2 when there are several), or the likeness photo next to a
 * ready sheet for photo-based leads; a place's first-ranked photo while it has no sheet; the style
 * photos the page model really receives (styleRefsUsed — none when the board is the only anchor).
 */
export function refUsage(doc: ComicDoc | null | undefined, owner: RefOwner): Map<string, RefUsage> {
  const out = new Map<string, RefUsage>();
  if (!doc) return out;
  const mark = (refs: RefAsset[], key: keyof RefUsage) => refs.forEach((r) => out.set(r.path, { ...(out.get(r.path) || {}), [key]: true }));
  if (owner.kind === 'character') {
    const c = doc.cast.find((x) => x.id === owner.id);
    if (!c || !c.refs.length) return out;
    if (c.tier !== 'extra') mark(sheetRefs(c, sheetSlots(doc)), 'sheet');
    if (pageSlots(doc) > 0) {
      const sheetReady = c.sheet.status === 'ready' && !!c.sheet.asset && canServeToOwner(c.sheet.asset);
      if (!sheetReady || c.tier === 'extra') mark(pickRefs(c.refs, c.refs.length >= 2 ? REF_LIMITS.pagePhotosPerCharacter : 1, 'page'), 'pages');
      else if (c.likeness === 'sheet_and_photo' || ((c.likeness ?? 'auto') === 'auto' && c.tier === 'lead' && isPhotoLikeness(c))) mark(pickRefs(c.refs, 1, 'page'), 'pages');
    }
  } else if (owner.kind === 'place') {
    const p = doc.places.find((x) => x.id === owner.id);
    const sheetReady = p?.sheet.status === 'ready' && !!p.sheet.asset && canServeToOwner(p.sheet.asset);
    if (p?.refs.length && !sheetReady) mark(pickRefs(p.refs, 1, 'place_sheet'), 'pages');
  } else if (owner.kind === 'style') {
    const n = styleRefsUsed(doc);
    if (n > 0) mark(pickRefs(doc.style.refs, n, 'style'), 'style');
  }
  return out;
}

export interface SheetHint {
  /** The ready sheet was drawn from photos that differ from today's pick. */
  changed: boolean;
  /** No sheet yet but photos exist (lead/support). */
  missing: boolean;
  /** The registry quote for one sheet (markup included unless BYOK); 0 when it couldn't be priced. */
  usd: number;
  /**
   * The quote printed for THIS user by the caller's formatter ("≈ $0.07" for admins / own key,
   * "≈2% of your usage" for governed users). Empty when no formatter was passed: this pure helper
   * never prints dollars on its own (governed users never see them).
   */
  price: string;
}

/**
 * "New photos since this sheet — redraw ≈ $0.07" / "Make the model sheet from these photos ≈ $0.07".
 * `price` formats the quote for the viewer — pass conversation/cost useCostFormat(studio).approx.
 */
export function sheetHint(
  doc: ComicDoc | null | undefined,
  owner: RefOwner,
  byok = false,
  price?: (usd: number) => string
): SheetHint | null {
  if (!doc || owner.kind !== 'character') return null;
  const c = doc.cast.find((x) => x.id === owner.id);
  if (!c || c.tier === 'extra' || !c.refs.length) return null;
  let usd = 0;
  try {
    usd = unitPrice(doc, 'sheet', { byok }).usd;
  } catch {
    usd = 0;
  }
  const ready = c.sheet.status === 'ready' && !!c.sheet.asset;
  const busy = c.sheet.status === 'queued' || c.sheet.status === 'rendering';
  return { changed: ready && sheetRefsChanged(c, sheetSlots(doc)), missing: !ready && !busy, usd, price: usd > 0 && price ? price(usd) : '' };
}

export const LIKENESS_OPTIONS: { value: NonNullable<Character['likeness']>; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Sheet, plus the main photo for photo-based leads when there is room' },
  { value: 'sheet_and_photo', label: 'Sheet + main photo', hint: 'Every page also sees the main photo for likeness' },
  { value: 'sheet_only', label: 'Sheet only', hint: 'Pages see only the drawn model sheet' }
];
