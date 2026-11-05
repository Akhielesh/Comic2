// Reference ranking (contract §11.5, refs.md §2.5) — which user refs go to the image model.
//
// Pure, deterministic and $0. The prompt compiler (server/src/comic/prompts.ts) and the refs UI badges
// ("used for the sheet" / "used on pages") call the SAME functions, so the UI never lies about which
// photos actually reach the model.
//
// Order in the owner's array = priority; index 0 is the main ref (+40). Blocked or quarantined refs are
// excluded before scoring. The greedy pick then penalizes a second photo with the same label (−25) or a
// near-duplicate dHash (≤ 6 bits, −40) so four near-identical selfies never crowd out the side view.

import { castKindOf, type Character, type RefAsset, type RefLabel, type ShotType } from './doc.js';
import { REF_LIMITS } from './refs.js';
import { PLATFORM_CEILING, safetyStatusOf, type ContentRating } from './safety.js';

export type RefPurpose = 'sheet' | 'page' | 'cover' | 'place_sheet' | 'style';
export interface RefContext { shots?: ShotType[]; effectiveRating?: ContentRating }

const POP = (n: number) => {
  let c = 0;
  for (let v = n; v; v &= v - 1) c += 1;
  return c;
};

/** popcount(xor) of two 64-bit dHashes (16 hex); 64 when either is unknown. */
export const dhashDistance = (a?: string, b?: string): number => {
  if (!a || !b || !/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return 64;
  let d = 0;
  for (let i = 0; i < 16; i += 4) d += POP((parseInt(a.slice(i, i + 4), 16) ^ parseInt(b.slice(i, i + 4), 16)) & 0xffff);
  return d;
};

/** Never sent to a model: blocked by the content check, or moved to quarantine. */
const usable = (r: RefAsset | undefined): r is RefAsset => !!r?.path && !(r.safety?.assessed === 'X' || r.safety?.quarantined);

// ── Scoring table (refs.md §2.5) ─────────────────────────────────────────────

const MAIN_BONUS = 40;
const UNLABELED = 5;
const SAME_LABEL_PENALTY = 25;
const NEAR_DUP_PENALTY = 40;
const NEAR_DUP_BITS = 6;

type Affinity = Partial<Record<RefLabel, number>>;

const SHEET_AFFINITY: Affinity = {
  front: 30, three_quarter: 28, full_body: 26, face: 22, side: 18, outfit: 14, back: 10, expression: 8, pose: 6, detail: 4
};
const CLOSE_AFFINITY: Affinity = { face: 30, expression: 20, front: 15 };
const WIDE_AFFINITY: Affinity = { full_body: 30, outfit: 20, front: 15 };
const MIXED_AFFINITY: Affinity = { front: 25, three_quarter: 25, full_body: 20, face: 18 };
const PLACE_AFFINITY: Affinity = { wide: 30, exterior: 25, interior: 25, lighting: 10, detail: 8 };
const STYLE_AFFINITY: Affinity = { linework: 20, color: 20, mood: 15, texture: 15, lighting: 15, composition: 10 };

const CLOSE_SHOTS = new Set<ShotType>(['close_up', 'extreme_close_up']);
const WIDE_SHOTS = new Set<ShotType>(['wide', 'full', 'establishing']);

const isCharacterPurpose = (p: RefPurpose) => p === 'sheet' || p === 'page' || p === 'cover';

/** Label table for a page/cover: what the character's panels on this page mostly frame. */
const shotAffinity = (shots?: ShotType[]): Affinity => {
  const list = (shots || []).filter(Boolean);
  if (!list.length) return MIXED_AFFINITY;
  const share = (set: Set<ShotType>) => list.filter((s) => set.has(s)).length / list.length;
  if (share(CLOSE_SHOTS) >= 0.5) return CLOSE_AFFINITY;
  if (share(WIDE_SHOTS) >= 0.5) return WIDE_AFFINITY;
  return MIXED_AFFINITY;
};

const affinityFor = (purpose: RefPurpose, ctx?: RefContext): Affinity => {
  switch (purpose) {
    case 'sheet':
      return SHEET_AFFINITY;
    case 'page':
    case 'cover':
      return shotAffinity(ctx?.shots);
    case 'place_sheet':
      return PLACE_AFFINITY;
    default:
      return STYLE_AFFINITY;
  }
};

/** Unlabeled (or 'other') = 5; a label that means nothing for this purpose (a "wide" photo on a sheet) = 0. */
const labelScore = (label: RefLabel | undefined, table: Affinity): number =>
  !label || label === 'other' ? UNLABELED : table[label] ?? 0;

/**
 * refs.md §2.5: priority (100 − 6·index, +40 for index 0 = main), label affinity per purpose, quality
 * penalties (character purposes), subject mismatch −40, over_rating −50. A blocked/quarantined ref is
 * never a candidate: −Infinity.
 */
export const scoreRef = (ref: RefAsset, index: number, purpose: RefPurpose, ctx?: RefContext): number => {
  if (!usable(ref)) return Number.NEGATIVE_INFINITY;
  const i = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
  let score = 100 - 6 * i + (i === 0 ? MAIN_BONUS : 0);
  score += labelScore(ref.label, affinityFor(purpose, ctx));
  if (isCharacterPurpose(purpose)) {
    const q = ref.quality;
    if (q?.blurry) score -= 35;
    if (q?.lowRes) score -= 20;
    if (q?.dark) score -= 15;
    if (q?.multiSubject) score -= 20;
    if (ref.subject === 'place') score -= 40;
  } else if (purpose === 'place_sheet') {
    if (ref.subject === 'person' || ref.subject === 'animal') score -= 40;
  }
  if (safetyStatusOf(ref.safety, ctx?.effectiveRating ?? PLATFORM_CEILING) === 'over_rating') score -= 50;
  return score;
};

/**
 * Greedy pick of ≤ k refs: highest score first (ties by index); after each pick the remaining candidates
 * lose 25 for the same label and 40 for a near-duplicate dHash (≤ 6 bits) of any pick. Returned in pick
 * order (the order they are attached and labeled).
 */
export const pickRefs = (refs: RefAsset[], k: number, purpose: RefPurpose, ctx?: RefContext): RefAsset[] => {
  const want = Number.isFinite(k) ? Math.max(0, Math.floor(k)) : 0;
  if (!want || !Array.isArray(refs)) return [];
  const pool = refs
    .map((ref, index) => ({ ref, index, score: usable(ref) ? scoreRef(ref, index, purpose, ctx) : Number.NEGATIVE_INFINITY }))
    .filter((c) => c.score > Number.NEGATIVE_INFINITY);
  const picked: RefAsset[] = [];
  while (picked.length < want && pool.length) {
    let best = 0;
    for (let i = 1; i < pool.length; i += 1) {
      if (pool[i].score > pool[best].score || (pool[i].score === pool[best].score && pool[i].index < pool[best].index)) best = i;
    }
    const [choice] = pool.splice(best, 1);
    picked.push(choice.ref);
    for (const c of pool) {
      if (choice.ref.label && choice.ref.label !== 'other' && c.ref.label === choice.ref.label) c.score -= SAME_LABEL_PENALTY;
      if (dhashDistance(c.ref.dhash, choice.ref.dhash) <= NEAR_DUP_BITS) c.score -= NEAR_DUP_PENALTY;
    }
  }
  return picked;
};

/** What compileCharacterSheet sends (≤ REF_LIMITS.sheetAuthorRefs). */
export const sheetRefs = (c: Character, maxCharacterRefs: number): RefAsset[] =>
  pickRefs(c.refs, Math.min(REF_LIMITS.sheetAuthorRefs, Math.max(0, Number.isFinite(maxCharacterRefs) ? maxCharacterRefs : 0)), 'sheet');

/**
 * "Drawn from older photos": the photos a redraw would use differ from the ones the ready sheet was drawn
 * from (soft hint, never stale). Compared as a SET: reordering the same photos is not "older photos".
 */
export const sheetRefsChanged = (c: Character, maxCharacterRefs: number): boolean => {
  const used = c.sheet.refPaths;
  if (!used || c.sheet.status !== 'ready') return false;
  const now = sheetRefs(c, maxCharacterRefs).map((r) => r.path);
  const usedSet = new Set(used);
  return now.length !== usedSet.size || now.some((p) => !usedSet.has(p));
};

/** Main ref is a user photo of a person/animal (an unknown subject falls back to the cast kind). */
export const isPhotoLikeness = (c: Character): boolean => {
  const main = c.refs.find(usable);
  if (!main || main.source !== 'upload') return false;
  const subject = main.subject ?? castKindOf(c);
  return subject === 'person' || subject === 'animal';
};
