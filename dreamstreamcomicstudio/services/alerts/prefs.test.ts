// The Alerts preferences (notify SPEC §6 NF-1 "Prefs"): one localStorage key per browser, every access guarded, a
// same-tab event and the storage event both notify, and an in-memory store for the QA scene and tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALERT_PREFS_KEY, createMemoryPrefsStore, loadAlertPrefs, saveAlertPrefs, subscribeAlertPrefs, localPrefsStore, __resetAlertPrefsForTests } from './prefs';
import { DEFAULT_ALERT_PREFS } from './types';

beforeEach(() => {
  window.localStorage.clear();
  __resetAlertPrefsForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('alert prefs', () => {
  it('defaults: sound on, Normal, everything', () => {
    expect(ALERT_PREFS_KEY).toBe('ds.alerts.v1');
    expect(loadAlertPrefs()).toEqual({ sound: true, volume: 'normal', level: 'all' });
    expect(DEFAULT_ALERT_PREFS).toEqual({ sound: true, volume: 'normal', level: 'all' });
  });

  it('saves a patch and reads it back; unknown or broken values fall back field by field', () => {
    saveAlertPrefs({ volume: 'soft' });
    expect(JSON.parse(window.localStorage.getItem(ALERT_PREFS_KEY)!)).toEqual({ sound: true, volume: 'soft', level: 'all' });
    expect(loadAlertPrefs()).toEqual({ sound: true, volume: 'soft', level: 'all' });
    window.localStorage.setItem(ALERT_PREFS_KEY, JSON.stringify({ sound: 'yes', volume: 'loud', level: 'needs' }));
    expect(loadAlertPrefs()).toEqual({ sound: true, volume: 'normal', level: 'needs' });
    window.localStorage.setItem(ALERT_PREFS_KEY, '{not json');
    expect(loadAlertPrefs()).toEqual(DEFAULT_ALERT_PREFS);
  });

  it('a blocked storage never throws: the choice holds for this tab', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => saveAlertPrefs({ sound: false })).not.toThrow();
    expect(loadAlertPrefs().sound).toBe(false);
  });

  it('tells listeners on a change in this tab and on a change in another tab (storage event)', () => {
    const fn = vi.fn();
    const off = subscribeAlertPrefs(fn);
    saveAlertPrefs({ level: 'needs' });
    expect(fn).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent('storage', { key: ALERT_PREFS_KEY }));
    expect(fn).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new StorageEvent('storage', { key: 'something.else' }));
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    saveAlertPrefs({ level: 'all' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('the local store and a memory store share one shape; the memory store never touches localStorage', () => {
    expect(localPrefsStore.get()).toEqual(DEFAULT_ALERT_PREFS);
    const mem = createMemoryPrefsStore({ sound: false });
    const fn = vi.fn();
    mem.subscribe(fn);
    expect(mem.get()).toEqual({ sound: false, volume: 'normal', level: 'all' });
    mem.set({ volume: 'soft' });
    expect(mem.get().volume).toBe('soft');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(ALERT_PREFS_KEY)).toBeNull();
  });
});
