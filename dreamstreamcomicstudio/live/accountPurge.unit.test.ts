// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { claimDevice, OWNER_KEY, purgeLiveAccountData, takeOverDevice } from './accountPurge';
import { holdsGuestPass } from './accessGate';
import { loadGuest } from './monitor/guest';
import { unsavedRecordingsOf, type UnsavedRecording } from './recorder';

const read = (rel: string) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');

const seed = () => {
  localStorage.setItem('ds-live-prefs', JSON.stringify({ hostName: 'Akhielesh', qualityId: '1080p' }));
  localStorage.setItem('ds-live-my-events', '[{"id":"e1","hostKey":"k"}]');
  localStorage.setItem('ds-monitor-push-n1', '1');
  localStorage.setItem('ds-track-queue-n1', '[]');
  localStorage.setItem('ds-call-ring', '1');
  // A guest pass from a nursery's share link: a working pass to watch that nursery as this person.
  localStorage.setItem('ds-monitor-guest-n2', '{"token":"g"}');
  // Device things that aren't personal stay.
  localStorage.setItem('ds-live-theme', 'dark');
  localStorage.setItem('ds-live-tour-welcome-done', '1');
};

describe('Stream Studio sign-out wipe', () => {
  beforeEach(() => localStorage.clear());

  it('removes the name, events, nursery data (guest passes included) and call settings — keeps device preferences', () => {
    seed();
    purgeLiveAccountData();
    expect(localStorage.getItem('ds-live-prefs')).toBeNull();
    expect(localStorage.getItem('ds-live-my-events')).toBeNull();
    expect(localStorage.getItem('ds-monitor-push-n1')).toBeNull();
    expect(localStorage.getItem('ds-track-queue-n1')).toBeNull();
    expect(localStorage.getItem('ds-call-ring')).toBeNull();
    expect(localStorage.getItem('ds-monitor-guest-n2')).toBeNull();
    expect(localStorage.getItem('ds-live-theme')).toBe('dark');
    expect(localStorage.getItem('ds-live-tour-welcome-done')).toBe('1');
  });

  it('a guest pass from a share link goes with the account (the Cookies notice says so): the next person here can\'t watch that nursery as them; a guest who never signed in keeps theirs', () => {
    const NID = '11111111-2222-4333-8444-555555555555';
    const pass = JSON.stringify({ token: 'room-issued', name: 'Grandma', role: 'viewer', until: Date.now() + 3_600_000, nursery: { name: 'Nursery', baby: 'Mia' } });
    const watch = { view: 'monitor-watch', nid: NID } as unknown as Parameters<typeof holdsGuestPass>[0];
    // Signed in as A on a shared device, A joined a nursery A isn't a member of with its link.
    localStorage.setItem(OWNER_KEY, 'u-a');
    localStorage.setItem(`ds-monitor-guest-${NID}`, pass);
    expect(holdsGuestPass(watch)).toBe(true);
    purgeLiveAccountData(); // A signs out
    expect(loadGuest(NID)).toBeNull();
    expect(holdsGuestPass(watch)).toBe(false);
    // The same on an account switch and on the next load after a sign-out elsewhere.
    localStorage.setItem(OWNER_KEY, 'u-a');
    localStorage.setItem(`ds-monitor-guest-${NID}`, pass);
    takeOverDevice('u-b');
    expect(loadGuest(NID)).toBeNull();
    localStorage.setItem(`ds-monitor-guest-${NID}`, pass);
    expect(claimDevice(null)).toBe(true);
    expect(loadGuest(NID)).toBeNull();
    // Nobody signed in here: a share-link guest's own pass stays, load after load.
    localStorage.setItem(`ds-monitor-guest-${NID}`, pass);
    expect(claimDevice(null)).toBe(false);
    expect(loadGuest(NID)?.name).toBe('Grandma');
  });

  it('a pass kept while no one was signed in goes once someone signs in there and out again, or the device switches accounts (the Cookies notice lists these)', () => {
    const NID = '11111111-2222-4333-8444-555555555555';
    const pass = JSON.stringify({ token: 'room-issued', name: 'Grandma', role: 'viewer', until: Date.now() + 3_600_000, nursery: { name: 'Nursery', baby: 'Mia' } });
    localStorage.setItem(`ds-monitor-guest-${NID}`, pass);
    expect(claimDevice(null)).toBe(false);
    expect(claimDevice('u-son')).toBe(false); // the son signs in to Stream Studio here: no purge, the device is his
    expect(loadGuest(NID)?.name).toBe('Grandma');
    purgeLiveAccountData(); // ...and signs out (here or in the main app)
    expect(loadGuest(NID)).toBeNull();
    // A sign-out elsewhere: the next load with no session purges.
    localStorage.setItem(`ds-monitor-guest-${NID}`, pass);
    claimDevice('u-son');
    expect(claimDevice(null)).toBe(true);
    expect(loadGuest(NID)).toBeNull();
    // A main-app account switch purges data no account owns too.
    localStorage.clear();
    localStorage.setItem(`ds-monitor-guest-${NID}`, pass);
    expect(takeOverDevice('u-mum')).toBe(true);
    expect(loadGuest(NID)).toBeNull();
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
    // ...but the next person to sign in here is never offered A's, nor is a signed-out visitor; one
    // no account made is offered to anyone (live/recorder.unit.test.ts has the rest).
    expect(unsavedRecordingsOf('u-b').map((r) => r.name)).toEqual(['ds-rec-b', 'ds-rec-anon']);
    expect(unsavedRecordingsOf(null).map((r) => r.name)).toEqual(['ds-rec-anon']);
    expect(unsavedRecordingsOf('u-a').map((r) => r.name)).toEqual(['ds-rec-a', 'ds-rec-anon']);
  });

  it('a new recording is tagged with the account it was made for, and the dashboard re-reads on sign-in and sign-out', () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'recorder.ts'), 'utf8');
    expect(src).toMatch(/upsertUnsaved\(\{[\s\S]*?owner: this\.owner,\s*\}\);/);
    expect(read('live/views/DashboardView.tsx')).toContain('}, [saving, account.userId, account.status]);');
  });

  it('removes the names of people you called and the room capabilities it remembered; keeps the monitor\'s encryption keys and unconfirmed call-list changes (the Cookies notice says so)', () => {
    localStorage.setItem('ds-call-names', '{"u-x":"Sam"}');
    localStorage.setItem('ds-calls-ok', '["u-x"]');
    localStorage.setItem('ds-monitor-caps-n1', '["e2e1"]');
    localStorage.setItem('ds-e2e-cams-n1', '{"cam":"dev"}');
    localStorage.setItem('ds-call-pending:u-a', '[{"t":"block","uid":"u-x","name":"Sam","on":true}]');
    purgeLiveAccountData();
    for (const k of ['ds-call-names', 'ds-calls-ok', 'ds-monitor-caps-n1']) expect(localStorage.getItem(k), k).toBeNull();
    for (const k of ['ds-e2e-cams-n1', 'ds-call-pending:u-a']) expect(localStorage.getItem(k), k).not.toBeNull();
  });
});
