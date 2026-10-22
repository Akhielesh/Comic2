// A guest pass on this device: the nursery's room is the authority on when it
// ends. A parent can extend the link ("+7 days"), so the end this device saved
// at the join is only a hint — the pass is kept past it, the room's hello (and
// a `guest_pass` message when a parent extends the link) keeps the saved copy
// in step, and only the room's refusal (4004) clears it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../account', () => ({ accessToken: async () => null, supa: async () => null }));

import { GUEST_TTL_MS } from '../../live-worker/src/monitorGuests';
import { openMonitorSocket } from './client';
import { GUEST_PASS_MAX_MS, loadGuest, saveGuest, type GuestPass } from './guest';

class FakeWS {
  static OPEN = 1;
  static all: FakeWS[] = [];
  readyState = 0;
  bufferedAmount = 0;
  binaryType = '';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    /* the test drives onclose */
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  msg(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

const NID = '11111111-2222-4333-8444-555555555555';
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const pass = (until: number): GuestPass => ({ token: 'guest-token', name: 'Grandma Jo', role: 'viewer', until, nursery: { name: 'Nursery', baby: 'Aria' } });
const hello = (until?: number) => ({
  t: 'hello',
  you: { sid: 's', uid: 'g:1', name: 'Grandma Jo', role: 'viewer', label: null, mode: 'viewer', dev: 'd', guest: true, ...(until != null ? { until } : {}) },
  nursery: { id: NID, name: 'Nursery', baby: 'Aria' },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWS);
  FakeWS.all = [];
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('a guest pass on this device', () => {
  it('no pass outlives 90 days from its join — the same limit the room keeps', () => {
    expect(GUEST_PASS_MAX_MS).toBe(GUEST_TTL_MS);
  });

  it('is kept past the end it was saved with (the link may have been extended since); one that can’t still work is dropped', () => {
    saveGuest(NID, pass(Date.now() - HOUR));
    expect(loadGuest(NID)?.token).toBe('guest-token');
    saveGuest(NID, pass(Date.now() - GUEST_PASS_MAX_MS - HOUR));
    expect(loadGuest(NID)).toBeNull();
  });

  it('after "+7 days", reconnecting past the original end still signs in with the pass — and the room’s word moves the saved end', async () => {
    const joinedUntil = Date.now() + DAY;
    saveGuest(NID, pass(joinedUntil));
    const sock = openMonitorSocket(NID, 'viewer', () => undefined, () => undefined, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    let ws = FakeWS.all.at(-1)!;
    ws.open();
    expect(JSON.parse(ws.sent[0])).toMatchObject({ t: 'auth', guest: 'guest-token', mode: 'viewer' });
    ws.msg(hello(joinedUntil));

    // A parent taps "+7 days": the room tells this device right away.
    ws.msg({ t: 'guest_pass', until: joinedUntil + 7 * DAY });
    expect(loadGuest(NID)?.until).toBe(joinedUntil + 7 * DAY);

    // The original end passes; a network blip later the pass still goes in the first frame.
    vi.setSystemTime(Date.now() + 2 * DAY);
    ws.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(20_000);
    ws = FakeWS.all.at(-1)!;
    expect(FakeWS.all.length).toBeGreaterThan(1);
    ws.open();
    expect(JSON.parse(ws.sent[0])).toMatchObject({ t: 'auth', guest: 'guest-token' });
    sock.close();
  });

  it('a device that missed the extension (it was away) takes the end from the next hello', async () => {
    const joinedUntil = Date.now() - HOUR; // it thinks the pass ended an hour ago
    saveGuest(NID, pass(joinedUntil));
    const sock = openMonitorSocket(NID, 'viewer', () => undefined, () => undefined, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWS.all.at(-1)!;
    ws.open();
    expect(JSON.parse(ws.sent[0])).toMatchObject({ guest: 'guest-token' });
    ws.msg(hello(joinedUntil + 7 * DAY));
    expect(loadGuest(NID)?.until).toBe(joinedUntil + 7 * DAY);
    sock.close();
  });

  it('the room’s refusal is what ends it on this device', async () => {
    saveGuest(NID, pass(Date.now() - HOUR));
    const status: string[] = [];
    openMonitorSocket(NID, 'viewer', () => undefined, () => undefined, (s, d) => status.push(d ? `${s}:${d}` : s));
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWS.all.at(-1)!;
    ws.open();
    ws.msg({ t: 'error', code: 'removed', msg: 'This guest pass has ended — ask a parent for the link and passcode again.' });
    ws.onclose?.({ code: 4004, reason: 'removed' });
    expect(status.at(-1)).toBe('closed:This guest pass has ended — ask a parent for the link and passcode again.');
    expect(loadGuest(NID)).toBeNull();
  });
});
