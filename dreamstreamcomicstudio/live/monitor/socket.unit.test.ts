// The room socket's liveness: a ping that hears nothing back means the
// connection is dead (a network change can leave a socket OPEN for minutes),
// so it reconnects; while ringing or in a call it pings every 10 s and comes
// back within 2 s.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const acct = vi.hoisted(() => ({ token: 'tok' as string | null }));
vi.mock('../account', () => ({ accessToken: async () => acct.token, supa: async () => null }));

import { AUTH_RETRY_MS, FAST_PING_MS, openCallRoomSocket, openMonitorSocket, openUserLineSocket, PING_MS, PONG_WAIT_MS } from './client';

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeWS[] = [];
  readyState = 0;
  bufferedAmount = 0;
  binaryType = '';
  sent: unknown[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send(d: unknown) {
    this.sent.push(d);
  }
  close(code: number) {
    this.closedWith = code;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  msg(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  pings() {
    return this.sent.filter((s) => s === '{"t":"ping"}').length;
  }
}

const NID = '11111111-2222-4333-8444-555555555555';

async function open(fast = false) {
  const status: string[] = [];
  const sock = openMonitorSocket(NID, 'line', () => undefined, () => undefined, (s) => status.push(s), { fast });
  await vi.advanceTimersByTimeAsync(0);
  const ws = FakeWS.all.at(-1)!;
  ws.open();
  ws.msg({ t: 'hello' });
  return { sock, ws, status };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWS);
  FakeWS.all = [];
  acct.token = 'tok';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('room socket liveness', () => {
  it('authenticates in the first frame, then pings every 25 s', async () => {
    const { sock, ws } = await open();
    expect(JSON.parse(ws.sent[0] as string)).toMatchObject({ t: 'auth', token: 'tok', mode: 'line' });
    await vi.advanceTimersByTimeAsync(PING_MS);
    expect(ws.pings()).toBe(1);
    sock.close();
  });

  it('a ping that hears nothing back drops the dead socket and reconnects', async () => {
    const { sock, ws, status } = await open();
    await vi.advanceTimersByTimeAsync(PING_MS);
    await vi.advanceTimersByTimeAsync(PONG_WAIT_MS);
    expect(ws.closedWith).toBe(4000);
    expect(status.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1500);
    expect(FakeWS.all).toHaveLength(2);
    sock.close();
  });

  it('any message counts as an answer', async () => {
    const { sock, ws } = await open();
    expect(sock.lastHeard).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(PING_MS);
    ws.msg({ t: 'pong' });
    await vi.advanceTimersByTimeAsync(PONG_WAIT_MS);
    expect(ws.closedWith).toBeNull();
    expect(FakeWS.all).toHaveLength(1);
    sock.close();
  });

  it('ringing / in a call: pings at once, then every 10 s, and comes back within 2 s', async () => {
    const { sock, ws } = await open();
    sock.setFast(true);
    expect(ws.pings()).toBe(1);
    ws.msg({ t: 'pong' });
    await vi.advanceTimersByTimeAsync(FAST_PING_MS);
    expect(ws.pings()).toBe(2);
    // No answer: dropped after 10 s, back within 2 s however many tries it took before.
    await vi.advanceTimersByTimeAsync(PONG_WAIT_MS);
    expect(ws.closedWith).toBe(4000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWS.all).toHaveLength(2);
    sock.close();
  });

  it('probe(): a quick check after a network change', async () => {
    const { sock, ws } = await open();
    sock.probe(4000);
    expect(ws.pings()).toBe(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(ws.closedWith).toBe(4000);
    sock.close();
  });

  it('reconnect() starts a fresh connection right away', async () => {
    const { sock, ws } = await open();
    sock.reconnect();
    expect(ws.closedWith).toBe(4000);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWS.all).toHaveLength(2);
    sock.close();
  });

  it('closing for good stops pinging and never reconnects', async () => {
    const { sock, ws } = await open();
    sock.close();
    ws.onclose?.({ code: 1000 });
    await vi.advanceTimersByTimeAsync(PING_MS * 3);
    expect(ws.pings()).toBe(0);
    expect(FakeWS.all).toHaveLength(1);
  });

  it('binary frames are refused while too much is queued', async () => {
    const { sock, ws } = await open();
    expect(sock.sendBinary(new ArrayBuffer(4))).toBe(true);
    ws.bufferedAmount = 600 * 1024;
    expect(sock.bufferedAmount()).toBe(600 * 1024);
    expect(sock.sendBinary(new ArrayBuffer(4))).toBe(false);
    expect(sock.sendBinary(new ArrayBuffer(4), 1024 * 1024)).toBe(true);
    sock.close();
  });
});

describe('direct-call sockets (same liveness, their own first frame)', () => {
  const UID = '00000000-0000-4000-8000-0000000000a1';

  it('your line: the member’s own token in the first frame, never in the URL', async () => {
    const status: string[] = [];
    const sock = openUserLineSocket(UID, () => undefined, (s) => status.push(s));
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWS.all.at(-1)!;
    expect(ws.url).toMatch(new RegExp(`/api/calls/u/${UID}/ws$`));
    expect(ws.url).not.toContain('tok');
    ws.open();
    expect(JSON.parse(ws.sent[0] as string)).toMatchObject({ t: 'auth', token: 'tok', dev: expect.any(String) });
    ws.msg({ t: 'hello' });
    expect(status.at(-1)).toBe('connected');
    // The same watchdog: a ping that hears nothing drops the socket and reconnects.
    await vi.advanceTimersByTimeAsync(PING_MS + PONG_WAIT_MS);
    expect(ws.closedWith).toBe(4000);
    sock.close();
  });

  it('your line never quietly gives up: “too many devices” is waited out', async () => {
    const status: string[] = [];
    const sock = openUserLineSocket(UID, () => undefined, (s) => status.push(s));
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWS.all.at(-1)!;
    ws.open();
    ws.msg({ t: 'error', code: 'full', msg: 'Stream Studio is open on too many devices.' });
    // Regression: 4003 was final — one "full" (which anyone could cause) cut the device off until a reload.
    ws.onclose?.({ code: 4003, reason: 'full' });
    expect(status.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWS.all).toHaveLength(2);
    sock.close();
  });

  it('your line: no token right now (a phone waking up offline) — it tries again, and at once when back online', async () => {
    acct.token = null;
    const status: string[] = [];
    const sock = openUserLineSocket(UID, () => undefined, (s) => status.push(s));
    await vi.advanceTimersByTimeAsync(0);
    // Regression: "Sign in to make calls." closed the line for good.
    expect(status.at(-1)).toBe('reconnecting');
    expect(FakeWS.all).toHaveLength(0);
    acct.token = 'tok';
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWS.all).toHaveLength(1);
    FakeWS.all[0].open();
    FakeWS.all[0].msg({ t: 'hello' });
    expect(status.at(-1)).toBe('connected');
    sock.close();
  });

  it('your line: sign-in that keeps failing slows down instead of stopping; a real “forbidden” stops it', async () => {
    const status: string[] = [];
    const sock = openUserLineSocket(UID, () => undefined, (s) => status.push(s));
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(i === 0 ? 0 : AUTH_RETRY_MS);
      const ws = FakeWS.all.at(-1)!;
      ws.open();
      ws.onclose?.({ code: 4001, reason: 'auth' });
    }
    expect(FakeWS.all).toHaveLength(4);
    expect(status.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_MS);
    const ws = FakeWS.all.at(-1)!;
    expect(FakeWS.all).toHaveLength(5);
    ws.open();
    ws.onclose?.({ code: 4003, reason: 'forbidden' });
    expect(status.at(-1)).toBe('closed');
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_MS * 2);
    expect(FakeWS.all).toHaveLength(5);
    sock.close();
  });

  it('a nursery’s room keeps its rules: “full” and “forbidden” are final there', async () => {
    const status: string[] = [];
    openMonitorSocket(NID, 'viewer', () => undefined, () => undefined, (s) => status.push(s));
    await vi.advanceTimersByTimeAsync(0);
    FakeWS.all[0].open();
    FakeWS.all[0].onclose?.({ code: 4003, reason: 'full' });
    expect(status.at(-1)).toBe('closed');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWS.all).toHaveLength(1);
  });

  it('a call’s room: the ticket in the first frame; “that call has ended” is final', async () => {
    const status: string[] = [];
    openCallRoomSocket('0123456789abcdef', 'tkt', () => undefined, (s, d) => status.push(d ? `${s}:${d}` : s));
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWS.all.at(-1)!;
    expect(ws.url).toMatch(/\/api\/calls\/c\/0123456789abcdef\/ws$/);
    ws.open();
    expect(JSON.parse(ws.sent[0] as string)).toMatchObject({ t: 'auth', ticket: 'tkt' });
    ws.msg({ t: 'error', code: 'ended', msg: 'That call has ended.' });
    ws.onclose?.({ code: 4006 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(status.at(-1)).toBe('closed:That call has ended.');
    expect(FakeWS.all).toHaveLength(1);
  });
});
