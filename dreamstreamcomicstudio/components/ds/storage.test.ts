/**
 * storage.ts (redesign plan §4): one key registry, and storage that throws (a private window, a sandboxed iframe,
 * a full quota, blocked site data — or the `localStorage` getter itself) falls back to the caller's default and
 * never takes the screen down. Garbage stored by an older build is ignored.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStored, removeStored, scopedKey, storageArea, storageKeys, storedBoolean, storedNumberIn, storedOneOf, useStoredState, writeStored } from './storage';

const throwing = (): Storage =>
  ({
    getItem: vi.fn(() => {
      throw new DOMException('denied', 'SecurityError');
    }),
    setItem: vi.fn(() => {
      throw new DOMException('full', 'QuotaExceededError');
    }),
    removeItem: vi.fn(() => {
      throw new DOMException('denied', 'SecurityError');
    }),
    clear: vi.fn(),
    key: vi.fn(),
    length: 0
  }) as unknown as Storage;

const realLocal = Object.getOwnPropertyDescriptor(window, 'localStorage');

afterEach(() => {
  if (realLocal) Object.defineProperty(window, 'localStorage', realLocal);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('storage', () => {
  it('a storage whose reads and writes throw falls back to the default and reports the write as not kept', () => {
    const store = throwing();
    expect(readStored('libraryView', 'grid', { storage: store })).toBe('grid');
    expect(writeStored('libraryView', 'list', { storage: store })).toBe(false);
    expect(() => removeStored('libraryView', { storage: store })).not.toThrow();
    expect(store.getItem).toHaveBeenCalledWith('lib.view');
  });

  it('a localStorage getter that throws (blocked site data) reads as no storage: defaults, no throw', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      }
    });
    expect(storageArea('local')).toBeNull();
    expect(readStored('directorCollapsed', false)).toBe(false);
    expect(writeStored('directorCollapsed', true)).toBe(false);
  });

  it('useStoredState starts from the default when storage throws and keeps the change on screen for this visit', () => {
    const store = throwing();
    const { result } = renderHook(() => useStoredState('librarySort', 'edited', { storage: store, parse: storedOneOf(['edited', 'title'] as const) }));
    expect(result.current[0]).toBe('edited');
    act(() => result.current[1]('title'));
    expect(result.current[0]).toBe('title');
  });

  it('round-trips JSON through the real storage, under the registry key', () => {
    expect(writeStored('libraryView', 'list')).toBe(true);
    expect(window.localStorage.getItem(storageKeys.libraryView)).toBe('"list"');
    expect(readStored('libraryView', 'grid')).toBe('list');
    removeStored('libraryView');
    expect(readStored('libraryView', 'grid')).toBe('grid');
  });

  it('ignores garbage: unparsable JSON and values the guard refuses give the default', () => {
    window.localStorage.setItem('lib.view', '{not json');
    expect(readStored('libraryView', 'grid', { parse: storedOneOf(['grid', 'list'] as const) })).toBe('grid');
    window.localStorage.setItem('lib.view', '"mosaic"');
    expect(readStored('libraryView', 'grid', { parse: storedOneOf(['grid', 'list'] as const) })).toBe('grid');
    window.localStorage.setItem('cs.ws.directorWidth', '9999');
    expect(readStored('directorWidth', 400, { parse: storedNumberIn(320, 520) })).toBe(400);
    window.localStorage.setItem('cs.ws.director', '"yes"');
    expect(readStored('directorCollapsed', false, { parse: storedBoolean })).toBe(false);
  });

  it('session storage keeps per-tab values (scroll positions) apart from device settings', () => {
    const key = scopedKey('scroll', 'library:grid');
    expect(key).toBe('ds.scroll.library:grid');
    writeStored(key, 420, { area: 'session' });
    expect(window.sessionStorage.getItem(key)).toBe('420');
    expect(window.localStorage.getItem(key)).toBeNull();
    expect(scopedKey('split', 'a b/c')).toBe('ds.split.a_b_c');
    expect(scopedKey('scroll', '')).toBe('ds.scroll._');
  });

  it('the registry holds the keys the redesign names (cs.ws.*, lib.view, the reading list)', () => {
    expect(storageKeys).toMatchObject({ directorCollapsed: 'cs.ws.director', place: 'cs.ws.place', libraryView: 'lib.view', readingList: 'discover.readingList' });
    expect(new Set(Object.values(storageKeys)).size).toBe(Object.values(storageKeys).length);
  });
});
