// Trip shortlist — the user's saved picks (restaurants, hotels, sights, …) collected
// from place lists and map popups into ONE place, grouped by category. localStorage-
// backed with a change event, same pattern as customDashboards.

export interface ShortlistItem {
  /** Stable identity: name + rounded coords (places don't have global ids). */
  id: string;
  name: string;
  /** Normalized PlaceKind (placeKinds.ts), e.g. 'food' | 'hotel' | 'park'. */
  kind: string;
  lat?: number;
  lng?: number;
  address?: string;
  /** Where it was saved from, e.g. "restaurants near DUMBO". */
  source?: string;
  savedAt: string;
}

const STORAGE = 'ds.shortlist.v1';
export const SHORTLIST_CHANGED = 'dreamstream:shortlist-changed';

export const shortlistId = (name: string, lat?: number, lng?: number): string =>
  `${name.toLowerCase().trim()}@${typeof lat === 'number' ? lat.toFixed(4) : '?'},${typeof lng === 'number' ? lng.toFixed(4) : '?'}`;

const read = (): ShortlistItem[] => {
  if (typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE) ?? '[]');
    return Array.isArray(parsed) ? (parsed.filter((x) => x && typeof x === 'object' && (x as ShortlistItem).id) as ShortlistItem[]) : [];
  } catch {
    return [];
  }
};

const write = (list: ShortlistItem[]) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE, JSON.stringify(list.slice(0, 400)));
    window.dispatchEvent(new CustomEvent(SHORTLIST_CHANGED));
  } catch {
    /* private mode — shortlist just doesn't persist */
  }
};

export const listShortlist = (): ShortlistItem[] => read();

export const isShortlisted = (id: string): boolean => read().some((s) => s.id === id);

/** Toggle an item; returns true when it is now saved. */
export const toggleShortlist = (item: Omit<ShortlistItem, 'savedAt'>): boolean => {
  const list = read();
  const existing = list.findIndex((s) => s.id === item.id);
  if (existing >= 0) {
    list.splice(existing, 1);
    write(list);
    return false;
  }
  write([{ ...item, savedAt: new Date().toISOString() }, ...list]);
  return true;
};

export const removeShortlisted = (id: string) => write(read().filter((s) => s.id !== id));

export const onShortlistChanged = (handler: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  const h = () => handler();
  window.addEventListener(SHORTLIST_CHANGED, h);
  return () => window.removeEventListener(SHORTLIST_CHANGED, h);
};
