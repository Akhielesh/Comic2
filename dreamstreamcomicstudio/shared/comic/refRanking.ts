// Reference ranking (contract §11.5) — which user refs go to the image model.
// WAVE-0 STUB: pickRefs = first k usable refs (blocked/quarantined excluded). P1-RENDER replaces
// scoreRef/pickRefs with the refs.md §2.5 scoring table and diversity penalty.

import { castKindOf, type Character, type RefAsset, type ShotType } from './doc.js';
import { REF_LIMITS } from './refs.js';
import type { ContentRating } from './safety.js';

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

const usable = (r: RefAsset) => !(r.safety?.assessed === 'X' || r.safety?.quarantined);

/** Stub score: priority only (100 − 6·index, +40 main). */
export const scoreRef = (_ref: RefAsset, index: number, _purpose: RefPurpose, _ctx?: RefContext): number => 100 - 6 * index + (index === 0 ? 40 : 0);

/** Stub: the first k usable refs, in priority order. */
export const pickRefs = (refs: RefAsset[], k: number, _purpose: RefPurpose, _ctx?: RefContext): RefAsset[] =>
  refs.filter(usable).slice(0, Math.max(0, Math.floor(k)));

/** What compileCharacterSheet sends (≤ REF_LIMITS.sheetAuthorRefs). */
export const sheetRefs = (c: Character, maxCharacterRefs: number): RefAsset[] =>
  pickRefs(c.refs, Math.min(REF_LIMITS.sheetAuthorRefs, Math.max(0, maxCharacterRefs)), 'sheet');

/** "Drawn from older photos": sheet.refPaths ≠ sheetRefs(...) paths (soft hint, never stale). */
export const sheetRefsChanged = (c: Character, maxCharacterRefs: number): boolean => {
  const used = c.sheet.refPaths;
  if (!used || c.sheet.status !== 'ready') return false;
  const now = sheetRefs(c, maxCharacterRefs).map((r) => r.path);
  return now.length !== used.length || now.some((p, i) => p !== used[i]);
};

/** Main ref is a user photo of a person/animal. */
export const isPhotoLikeness = (c: Character): boolean => {
  const main = c.refs.find(usable);
  if (!main || main.source !== 'upload') return false;
  const subject = main.subject ?? castKindOf(c);
  return subject === 'person' || subject === 'animal';
};
