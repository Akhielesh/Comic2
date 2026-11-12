// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { claimDevice, OWNER_KEY, purgeLiveAccountData } from './accountPurge';
import { unsavedRecordingsOf, type UnsavedRecording } from './recorder';

const read = (rel: string) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');

const seed = () => {
  localStorage.setItem('ds-live-prefs', JSON.stringify({ hostName: 'Akhielesh', qualityId: '1080p' }));
  localStorage.setItem('ds-live-my-events', '[{"id":"e1","hostKey":"k"}]');
  localStorage.setItem('ds-monitor-push-n1', '1');
  localStorage.setItem('ds-track-queue-n1', '[]');
  localStorage.setItem('ds-call-ring', '1');
  // Device things that aren't personal stay.
  localStorage.setItem('ds-live-theme', 'dark');
  localStorage.setItem('ds-monitor-guest-n2', '{"token":"g"}');
  localStorage.setItem('ds-live-tour-welcome-done', '1');
};

describe('Stream Studio sign-out wipe', () => {
  beforeEach(() => localStorage.clear());

  it('removes the name, events, nursery data and call settings — keeps device preferences', () => {
    seed();
    purgeLiveAccountData();
    expect(localStorage.getItem('ds-live-prefs')).toBeNull();
    expect(localStorage.getItem('ds-live-my-events')).toBeNull();
    expect(localStorage.getItem('ds-monitor-push-n1')).toBeNull();
    expect(localStorage.getItem('ds-track-queue-n1')).toBeNull();
    expect(localStorage.getItem('ds-call-ring')).toBeNull();
    expect(localStorage.getItem('ds-live-theme')).toBe('dark');
    expect(localStorage.getItem('ds-monitor-guest-n2')).not.toBeNull();
    expect(localStorage.getItem('ds-live-tour-welcome-done')).toBe('1');
  });

  it('removes this device’s usage too: a nursery’s relay data (parents only), last nights, the month’s ledger, hosted meetings, notices', () => {
    const usage = [
      'ds-usage-relay-n1', // the nursery's month of relay data, read by a parent
      'ds-usage-nights-n1', // "Last night: 10 h · all direct · free"
      'ds-usage-device-2026-10', // "Baby monitor on this device 212 h", "Saved to Google Drive 6.2 GB"
      'ds-usage-meetings',
      'ds-usage-notice-nursery:n1:2026-10:warn',
      'ds-usage-checked-n1',
    ];
    for (const k of usage) localStorage.setItem(k, '{"month":"2026-10","bytes":2100000000,"limitGb":10}');
    purgeLiveAccountData();
    for (const k of usage) expect(localStorage.getItem(k), k).toBeNull();
  });

  it('signed out elsewhere (no session): the previous account’s data goes on the next load', () => {
    seed();
    localStorage.setItem(OWNER_KEY, 'u-akhielesh');
    expect(claimDevice(null)).toBe(true);
    expect(localStorage.getItem('ds-live-prefs')).toBeNull();
    expect(localStorage.getItem(OWNER_KEY)).toBeNull();
  });

  it('someone else signs in on this device: wipe, then it’s theirs', () => {
    seed();
    localStorage.setItem(OWNER_KEY, 'u-a');
    expect(claimDevice('u-b')).toBe(true);
    expect(localStorage.getItem('ds-live-my-events')).toBeNull();
    expect(localStorage.getItem(OWNER_KEY)).toBe('u-b');
  });

  it('the same person (or the first sign-in) keeps everything', () => {
    seed();
    expect(claimDevice('u-a')).toBe(false);
    expect(localStorage.getItem(OWNER_KEY)).toBe('u-a');
    expect(claimDevice('u-a')).toBe(false);
    expect(localStorage.getItem('ds-live-prefs')).not.toBeNull();
    // Nobody ever signed in here and nobody is now: nothing to wipe.
    localStorage.removeItem(OWNER_KEY);
    expect(claimDevice(null)).toBe(false);
  });

  it('removes the name used to join someone else\'s event', () => {
    localStorage.setItem('ds-live-viewer-name', 'Akhielesh');
    purgeLiveAccountData();
    expect(localStorage.getItem('ds-live-viewer-name')).toBeNull();
  });
});

describe('unsaved recordings after a sign-out (the Cookies notice and Privacy Policy describe this)', () => {
  beforeEach(() => localStorage.clear());
  const rec = (name: string, owner?: string | null): UnsavedRecording => ({
    name, file: `${name}.webm`, mime: 'video/webm', eventId: 'e1', title: 'Team call', at: 1, durMs: 1000, bytes: 10,
    ...(owner === undefined ? {} : { owner }),
  });

  it('stay on the device, but only the account that recorded them is offered them', () => {
    localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify([rec('ds-rec-a', 'u-a'), rec('ds-rec-b', 'u-b'), rec('ds-rec-anon', null)]));
    localStorage.setItem(OWNER_KEY, 'u-a');
    purgeLiveAccountData(); // u-a signs out
    // The host's unsaved work isn't deleted...
    expect(JSON.parse(localStorage.getItem('ds-live-unsaved-recordings') || '[]')).toHaveLength(3);
    // ...but the next person to sign in here is never offered it, nor is a signed-out visitor.
    expect(unsavedRecordingsOf('u-b').map((r) => r.name)).toEqual(['ds-rec-b']);
    expect(unsavedRecordingsOf(null).map((r) => r.name)).toEqual(['ds-rec-anon']);
    expect(unsavedRecordingsOf('u-a').map((r) => r.name)).toEqual(['ds-rec-a']);
  });

  it('an entry from before recordings carried an owner goes to whoever lists it first, and stays theirs', () => {
    localStorage.setItem('ds-live-unsaved-recordings', JSON.stringify([rec('ds-rec-old')]));
    expect(unsavedRecordingsOf('u-a').map((r) => r.name)).toEqual(['ds-rec-old']);
    expect(unsavedRecordingsOf('u-b')).toEqual([]);
    expect(unsavedRecordingsOf('u-a').map((r) => r.owner)).toEqual(['u-a']);
  });

  it('a new recording is tagged with the account signed in when it starts', () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'recorder.ts'), 'utf8');
    expect(src).toContain('private readonly owner: string | null = deviceOwner(),');
    expect(src).toMatch(/upsertUnsaved\(\{[\s\S]*?owner: this\.owner,\s*\}\);/);
    expect(read('live/views/DashboardView.tsx')).toContain('}, [saving, account.userId, account.status]);');
  });
});
