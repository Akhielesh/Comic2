// Which crumbs the studio breadcrumb shows (SH-C2): My comics › the comic › the board's area › the part you are on.
// Pure, so how it folds is tested without layout. The last crumb is where you are.

export type CrumbKey = 'comics' | 'title' | 'area' | 'item';

/**
 * The header's room: 'wide' from 1024 px shows every crumb; 'medium' (tablets, narrow splits, a phone held sideways)
 * leaves My comics to the panel's drawer; 'narrow' (a phone held upright, below BREADCRUMB_TRAIL_MIN_WIDTH) has room for
 * the comic's name only. There, beside the panel toggle, Share, the wallet, Ask and ⋯, the name has 40 to 110 px: a crumb
 * beside it would cut both to slivers, so the trail folds away into the drawer, whose parts tree marks where you are.
 */
export type CrumbRoom = 'wide' | 'medium' | 'narrow';

/** A phone narrower than this has room for the comic's name only (the trail folds into the drawer). */
export const BREADCRUMB_TRAIL_MIN_WIDTH = 600;

export interface Crumb {
  key: CrumbKey;
  /** Where you are (the last crumb). */
  current: boolean;
}

export interface CrumbInput {
  /** There is a way back to My comics in the breadcrumb (the header has no Back of its own). */
  myComics: boolean;
  room: CrumbRoom;
  /** The board's area, while the board is on screen. */
  area?: string | null;
  /** The part you are on in that area. */
  item?: string | null;
}

export function breadcrumbCrumbs({ myComics, room, area, item }: CrumbInput): Crumb[] {
  const keys: CrumbKey[] = [];
  if (myComics && room === 'wide') keys.push('comics');
  keys.push('title');
  if (room !== 'narrow' && area) {
    keys.push('area');
    // A part needs its area: with the board out of sight there is neither.
    if (item) keys.push('item');
  }
  return keys.map((key, i) => ({ key, current: i === keys.length - 1 }));
}
