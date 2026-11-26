// Which crumbs the studio breadcrumb shows (SH-C2): My comics › the comic › the board's area › the part you are on.
// Pure, so how it folds is tested without layout. The last crumb is where you are.

export type CrumbKey = 'comics' | 'title' | 'area' | 'item';

/**
 * The header's room (headerVariantFor): 'wide' from 1024 px shows every crumb; 'medium' (tablets, narrow splits) leaves
 * My comics to the panel's drawer; 'narrow' (phones) also keeps only the deepest crumb after the comic's name.
 */
export type CrumbRoom = 'wide' | 'medium' | 'narrow';

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
  const hasItem = !!area && !!item;
  if (area && !(room === 'narrow' && hasItem)) keys.push('area');
  if (hasItem) keys.push('item');
  return keys.map((key, i) => ({ key, current: i === keys.length - 1 }));
}
