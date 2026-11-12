/**
 * Device storage for the content kit (redesign plan §4 "Hooks and models"): one key registry and one
 * try/catch around every read and write, so a remembered view, a Director pane width or a scroll position
 * can never take a screen down. Storage throws in a private window, behind a sandboxed iframe, when the quota
 * is full or when the user blocked site data; reading `window.localStorage` itself can throw there. Every
 * failure reads as "nothing stored": the caller's default applies and the choice lasts for this visit.
 *
 * Values are JSON. A stored value is only used when the caller's `parse` accepts it, so a value written by an
 * older build, or typed into DevTools, falls back to the default instead of reaching the screen.
 *
 * The registry names every key the kit and its screens keep (storageKeys). Keys that carry an id (a scroll
 * position per list) are built with `scopedKey`, never spelled at the call site. Nothing here fetches.
 */
import { useCallback, useState } from 'react';

/**
 * Every device key the redesign keeps, in one place (redesign plan §4: `cs.ws.*`, `lib.view`, the reading list).
 * camelCase on purpose: a SCREAMING_CASE string record is read as a class list by ds.hygiene.test.
 */
export const storageKeys = {
  /** Studio: whether the Director pane is collapsed to its edge tab (≥ 1024). */
  directorCollapsed: 'cs.ws.director',
  /** Studio: the Director pane's width in px (320–520 at ≥ 1440). */
  directorWidth: 'cs.ws.directorWidth',
  /** Studio: the remembered place (Home · Director · Story · Pages · Publish). */
  place: 'cs.ws.place',
  /** Library: grid or list. */
  libraryView: 'lib.view',
  /** Library: comfortable or compact cards. */
  libraryDensity: 'lib.density',
  /** Library: the sort. */
  librarySort: 'lib.sort',
  /** Discover: comics saved on this device (Save). */
  discoverSaved: 'discover.saved',
  /** Discover: where a reader stopped in someone else's comic (Keep reading). */
  readingList: 'discover.readingList',
  /** Split panes (SplitPane) persist their sizes under this prefix. */
  splitPane: 'ds.split'
} as const;

export type StorageKey = keyof typeof storageKeys;

/** The scopes a per-id key may live under (`ds.scroll.<id>`, `ds.split.<id>`). */
export type StorageScope = 'scroll' | 'split';

const SCOPE_PREFIX: Record<StorageScope, string> = { scroll: 'ds.scroll', split: storageKeys.splitPane };

/** A key carrying an id, e.g. the scroll position of one list. The id is trimmed to 80 safe characters. */
export function scopedKey(scope: StorageScope, id: string): string {
  const safe = String(id).replace(/[^\w.:-]+/g, '_').slice(0, 80);
  return `${SCOPE_PREFIX[scope]}.${safe || '_'}`;
}

/** `local` survives a reload and a new tab; `session` lasts for this tab only (scroll positions). */
export type StorageArea = 'local' | 'session';

/** The browser storage for an area, or null where it is missing or blocked (the getter itself can throw). */
export function storageArea(area: StorageArea = 'local'): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return area === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

const resolveKey = (key: StorageKey | string): string => (key in storageKeys ? storageKeys[key as StorageKey] : key);

export interface StorageOptions<T> {
  /** Accepts a parsed value and returns it typed, or undefined to use the default. */
  parse?: (raw: unknown) => T | undefined;
  area?: StorageArea;
  /** Replaces the browser storage (tests, an in-memory store). */
  storage?: Storage | null;
}

/** The stored value for `key`, or `fallback` when nothing usable is stored or storage throws. */
export function readStored<T>(key: StorageKey | string, fallback: T, options: StorageOptions<T> = {}): T {
  const store = options.storage !== undefined ? options.storage : storageArea(options.area);
  if (!store) return fallback;
  try {
    const raw = store.getItem(resolveKey(key));
    if (raw === null) return fallback;
    const value: unknown = JSON.parse(raw);
    if (options.parse) {
      const parsed = options.parse(value);
      return parsed === undefined ? fallback : parsed;
    }
    return value === null || value === undefined ? fallback : (value as T);
  } catch {
    return fallback;
  }
}

/** Stores `value` as JSON. Returns false when storage refused it (the value then lasts for this visit only). */
export function writeStored(key: StorageKey | string, value: unknown, options: Pick<StorageOptions<unknown>, 'area' | 'storage'> = {}): boolean {
  const store = options.storage !== undefined ? options.storage : storageArea(options.area);
  if (!store) return false;
  try {
    store.setItem(resolveKey(key), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeStored(key: StorageKey | string, options: Pick<StorageOptions<unknown>, 'area' | 'storage'> = {}): void {
  const store = options.storage !== undefined ? options.storage : storageArea(options.area);
  if (!store) return;
  try {
    store.removeItem(resolveKey(key));
  } catch {
    /* nothing to remove where storage is blocked */
  }
}

/** Common `parse` guards. */
export const storedOneOf =
  <T extends string>(values: readonly T[]) =>
  (raw: unknown): T | undefined =>
    typeof raw === 'string' && (values as readonly string[]).includes(raw) ? (raw as T) : undefined;

export const storedBoolean = (raw: unknown): boolean | undefined => (typeof raw === 'boolean' ? raw : undefined);

export const storedNumberIn =
  (min: number, max: number) =>
  (raw: unknown): number | undefined =>
    typeof raw === 'number' && Number.isFinite(raw) && raw >= min && raw <= max ? raw : undefined;

/**
 * React state remembered on the device: starts from the stored value (or the default) and writes every change.
 * A write that storage refuses keeps the new value on screen for this visit.
 */
export function useStoredState<T>(key: StorageKey | string, fallback: T, options: StorageOptions<T> = {}): [T, (next: T | ((prev: T) => T)) => void] {
  const { parse, area, storage } = options;
  const [value, setValue] = useState<T>(() => readStored(key, fallback, { parse, area, storage }));
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        writeStored(key, resolved, { area, storage });
        return resolved;
      });
    },
    [key, area, storage]
  );
  return [value, set];
}
