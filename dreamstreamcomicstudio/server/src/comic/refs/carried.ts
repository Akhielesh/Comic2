// Carried images (refs.md §6.3, §6.6). Owner: P1-REFS.
//
// When the director asks "Is this Maya?" and the user taps "Maya", the NEXT turn has no
// attachments — the photos are still in the previous message. Carried images are the
// attachments of the most recent earlier user message (within the last 3) whose paths are
// on no owner yet, so "yes, that's Maya" / "Images 1–5 are MAYA" can still file them.
// Assignment is derived by path lookup: no new state, nothing to keep in sync.

import { newId, type Card, type ComicDoc, type OptionChoice, type RefAsset } from '../../../../shared/comic/doc.js';
import { REF_LIMITS, findRefOwners } from '../../../../shared/comic/refs.js';
import { canServeToOwner } from '../../../../shared/comic/safety.js';
import { numberRanges, upperName } from './addRefs.js';

/** How many earlier user messages we look back through for unassigned images. */
export const CARRY_WINDOW = 3;

/** On no owner (a cast member, a place or the style). The inbox is not an owner here. */
const isUnassigned = (doc: ComicDoc, path: string): boolean => !findRefOwners(doc, path).some((o) => o.kind !== 'inbox');

/** Images from `images` that are still on no owner (and still servable to the owner). */
export function unassignedImages(doc: ComicDoc, images: RefAsset[]): RefAsset[] {
  const seen = new Set<string>();
  return (images || []).filter((r) => {
    if (!r?.path || seen.has(r.path)) return false;
    seen.add(r.path);
    return canServeToOwner(r) && isUnassigned(doc, r.path);
  });
}

/**
 * Unassigned images from the previous user turns (numbering continues after `current`).
 * The newest user message is skipped when it IS the current turn (its attachments are
 * `current`, or it has none); then the first earlier message, within CARRY_WINDOW, that still
 * has unassigned images supplies them (≤ REF_LIMITS.perMessageImages).
 */
export function carriedImages(doc: ComicDoc, current: RefAsset[]): RefAsset[] {
  const currentPaths = new Set((current || []).map((r) => r?.path).filter(Boolean));
  const users = (doc?.conversation || []).filter((m) => m && m.role === 'user');
  let looked = 0;
  for (let i = users.length - 1; i >= 0 && looked <= CARRY_WINDOW; i -= 1) {
    const msg = users[i];
    const atts = (msg.attachments || []).filter((a): a is RefAsset => !!a?.path);
    const isCurrent = i === users.length - 1 && (!atts.length || atts.every((a) => currentPaths.has(a.path)));
    if (isCurrent) continue;
    looked += 1;
    if (looked > CARRY_WINDOW) break;
    const carried = unassignedImages(doc, atts).filter((a) => !currentPaths.has(a.path));
    if (carried.length) return carried.slice(0, REF_LIMITS.perMessageImages);
  }
  return [];
}

/** "Images 1–5" / "Image 3" for the 1-based positions [from, from+count). */
export const imageSpan = (from: number, count: number): string =>
  count <= 1 ? `Image ${from}` : `Images ${numberRanges(Array.from({ length: count }, (_, i) => from + i))}`;

/**
 * The software fallback when a turn ends with images still unassigned and the director did
 * not ask (refs.md §6.6): ONE tappable question whose replies resolve next turn through the
 * carried images. `images` are the turn's images in number order (current, then carried).
 * Returns null when every image found an owner.
 */
export function whoIsInTheseCard(doc: ComicDoc, images: RefAsset[]): Card | null {
  const list = (images || []).filter((r) => !!r?.path);
  const open = new Set(unassignedImages(doc, list).map((r) => r.path));
  const numbers = list.map((r, i) => (open.has(r.path) ? i + 1 : 0)).filter((n) => n > 0);
  if (!numbers.length) return null;
  const span = numbers.length === 1 ? `Image ${numbers[0]}` : `Images ${numberRanges(numbers)}`;
  const isAre = numbers.length === 1 ? 'is' : 'are';
  const rank = (tier: string) => (tier === 'lead' ? 0 : tier === 'support' ? 1 : 2);
  const cast = doc.cast
    .filter((c) => c.tier !== 'extra')
    .sort((a, b) => rank(a.tier) - rank(b.tier))
    .slice(0, 4);
  const choices: OptionChoice[] = cast.map((c) => ({
    id: `who_${c.id}`,
    label: upperName(c.name),
    reply: `${span} ${isAre} ${upperName(c.name)}`,
    visual: { kind: 'cast', characterId: c.id }
  }));
  choices.push(
    { id: 'who_new', label: 'Someone new', reply: `${span} ${isAre} a new character` },
    { id: 'who_style', label: 'A style to follow', reply: `Use ${span.toLowerCase()} as a style reference` },
    { id: 'who_place', label: 'A place', reply: `${span} ${isAre} a place in the story` }
  );
  return {
    type: 'options',
    id: newId('card'),
    question: numbers.length === 1 ? 'Who or what is in this photo?' : "Who's in these photos?",
    choices,
    allowCustom: true
  };
}
