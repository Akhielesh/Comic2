// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sync', () => ({ schedulePrefsPush: vi.fn() }));

import {
  DEFAULT_PREFS,
  PREFS_VERSION,
  adoptCloudPrefs,
  cloudCopyNoticePending,
  loadPrefs,
  markCloudCopyNoticeSeen,
  migratePrefs,
  prefsSavedAt,
  savePrefs,
  type StudioPrefs,
} from './prefs';

const KEY = 'ds-live-prefs';
const SAVED_AT = 'ds-live-prefs-saved-at';

/** What a build before PREFS_VERSION 2 saved: the whole object, no version, default `cloudRecordings: true`. */
const v1 = (over: Partial<StudioPrefs> = {}) => {
  const { prefsVersion: _drop, ...rest } = { ...DEFAULT_PREFS, cloudRecordings: true, ...over };
  return rest;
};
const stored = () => JSON.parse(localStorage.getItem(KEY) || 'null') as Partial<StudioPrefs> | null;

beforeEach(() => localStorage.clear());

describe('7-day cloud copy is off by default (ADR 0007 C1)', () => {
  it('new devices start with it off', () => {
    expect(DEFAULT_PREFS.cloudRecordings).toBe(false);
    expect(loadPrefs().cloudRecordings).toBe(false);
    expect(loadPrefs().prefsVersion).toBe(PREFS_VERSION);
    expect(cloudCopyNoticePending()).toBe(false);
  });

  it('an explicit “on” saved by this build is kept, across reloads', () => {
    savePrefs({ ...loadPrefs(), cloudRecordings: true });
    expect(stored()?.prefsVersion).toBe(PREFS_VERSION);
    expect(loadPrefs().cloudRecordings).toBe(true);
    expect(loadPrefs().cloudRecordings).toBe(true);
    expect(cloudCopyNoticePending()).toBe(false);
  });
});

describe('migrating version-1 prefs', () => {
  it('turns the old default off, keeps every other setting, and flags the one-time notice', () => {
    localStorage.setItem(KEY, JSON.stringify(v1({ hostName: 'DJ Ada', saveTarget: 'drive', qualityId: '1080p', recLimitMin: 45 })));
    localStorage.setItem(SAVED_AT, '1700000000000');
    const p = loadPrefs();
    expect(p).toMatchObject({ cloudRecordings: false, hostName: 'DJ Ada', saveTarget: 'drive', qualityId: '1080p', recLimitMin: 45, prefsVersion: PREFS_VERSION });
    // Written back once, without pretending it was a new choice (cloud sync compares this stamp).
    expect(stored()).toMatchObject({ cloudRecordings: false, prefsVersion: PREFS_VERSION, hostName: 'DJ Ada' });
    expect(prefsSavedAt()).toBe(1_700_000_000_000);
    expect(cloudCopyNoticePending()).toBe(true);
  });

  it('a version-1 “off” was a real choice (the default was on): kept, no notice', () => {
    localStorage.setItem(KEY, JSON.stringify(v1({ cloudRecordings: false })));
    expect(loadPrefs().cloudRecordings).toBe(false);
    expect(cloudCopyNoticePending()).toBe(false);
  });

  it('prefs from before the setting existed simply get the new default', () => {
    const { cloudRecordings: _gone, ...old } = v1();
    localStorage.setItem(KEY, JSON.stringify(old));
    expect(loadPrefs().cloudRecordings).toBe(false);
    expect(cloudCopyNoticePending()).toBe(false);
  });

  it('runs once: turning it back on after the migration sticks', () => {
    localStorage.setItem(KEY, JSON.stringify(v1()));
    expect(loadPrefs().cloudRecordings).toBe(false);
    savePrefs({ ...loadPrefs(), cloudRecordings: true });
    expect(loadPrefs().cloudRecordings).toBe(true);
  });

  it('is pure and idempotent', () => {
    const once = migratePrefs(v1({ fps: 60 }));
    expect(once).toMatchObject({ migrated: true, cloudCopyTurnedOff: true });
    const twice = migratePrefs(once.prefs);
    expect(twice).toEqual({ prefs: once.prefs, migrated: false, cloudCopyTurnedOff: false });
    expect(migratePrefs(null).prefs).toEqual(DEFAULT_PREFS);
  });

  it('unreadable storage falls back to the defaults (copy off)', () => {
    localStorage.setItem(KEY, '{not json');
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });
});

describe('account (cloud) copies of prefs migrate the same way', () => {
  it('an older build’s synced prefs land with the copy off', () => {
    const p = adoptCloudPrefs(v1({ hostName: 'Grace' }), 1_800_000_000_000);
    expect(p).toMatchObject({ cloudRecordings: false, hostName: 'Grace', prefsVersion: PREFS_VERSION });
    expect(loadPrefs().cloudRecordings).toBe(false);
    expect(prefsSavedAt()).toBe(1_800_000_000_000);
    expect(cloudCopyNoticePending()).toBe(true);
  });

  it('a current build’s synced “on” is an explicit choice and is kept', () => {
    const p = adoptCloudPrefs({ ...DEFAULT_PREFS, cloudRecordings: true }, 1_800_000_000_000);
    expect(p.cloudRecordings).toBe(true);
    expect(loadPrefs().cloudRecordings).toBe(true);
    expect(cloudCopyNoticePending()).toBe(false);
  });

  it('the notice is said once per device, even if another old copy syncs in later', () => {
    localStorage.setItem(KEY, JSON.stringify(v1()));
    loadPrefs();
    expect(cloudCopyNoticePending()).toBe(true);
    markCloudCopyNoticeSeen();
    adoptCloudPrefs(v1(), 1_900_000_000_000);
    expect(cloudCopyNoticePending()).toBe(false);
  });
});
