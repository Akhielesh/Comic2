// The room socket's liveness: a ping that hears nothing back means the
// connection is dead (a network change can leave a socket OPEN for minutes),
// so it reconnects; while ringing or in a call it pings every 10 s and comes
// back within 2 s.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const acct = vi.hoisted(() => ({ token: 'tok' as string | null, sb: null as null | { rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: null }> } }));
vi.mock('../account', () => ({ accessToken: async () => acct.token, supa: async () => acct.sb }));

import {
  announceMembersChanged, AUTH_RETRY_MS, CLOSE_TEXT, ensureStepUp, FAST_PING_MS, noteNurseryCaps, nurseryCaps, openCallRoomSocket, openMonitorSocket,
  openUserLineSocket, PING_MS, PONG_WAIT_MS, RATE_LIMIT_WAIT_MS, REAUTH_AHEAD_MS, registerStepUp, removeMember, setMember,
} from './client';

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
  acct.sb = null;
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

/* ------------------------------------------- ADR 0006 Phase 0 sessions (WS-6) */

describe('re-auth on the open socket (rooms that list `reauth`)', () => {
  const sentOf = (ws: FakeWS) => ws.sent.filter((x): x is string => typeof x === 'string' && x !== '{"t":"ping"}').map((x) => JSON.parse(x) as Record<string, unknown>);
  async function viewer(caps: string[], exp?: number) {
    const status: string[] = [];
    const sock = openMonitorSocket(NID, 'viewer', () => undefined, () => undefined, (s, d) => status.push(d ? `${s}:${d}` : s));
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWS.all.at(-1)!;
    ws.open();
    ws.msg({ t: 'hello', you: {}, caps, ...(exp ? { exp } : {}) });
    return { sock, ws, status };
  }

  it('each fresh token (ds:token) goes to the open socket once; a room without `reauth` never gets one', async () => {
    const { sock, ws } = await viewer(['reauth', 'view']);
    expect(nurseryCaps(NID)).toEqual(['reauth', 'view']);
    window.dispatchEvent(new CustomEvent('ds:token', { detail: 'tok' })); // the one it signed in with
    window.dispatchEvent(new CustomEvent('ds:token', { detail: 'tok2' }));
    window.dispatchEvent(new CustomEvent('ds:token', { detail: 'tok2' }));
    expect(sentOf(ws).filter((m) => m.t === 'reauth')).toEqual([{ t: 'reauth', token: 'tok2' }]);
    sock.close();

    const old = await viewer([]);
    window.dispatchEvent(new CustomEvent('ds:token', { detail: 'tok3' }));
    expect(sentOf(old.ws).some((m) => m.t === 'reauth')).toBe(false);
    old.sock.close();
  });

  it('ahead of the token’s expiry it hands over the refreshed one by itself; `reauth_ok` moves the next one', async () => {
    /** Time passes with the room answering every ping (the watchdog keeps the socket). */
    const live = async (ws: FakeWS, ms: number) => {
      for (let left = ms; left > 0; left -= 5000) {
        await vi.advanceTimersByTimeAsync(Math.min(5000, left));
        ws.msg({ t: 'pong' });
      }
    };
    const exp = Date.now() + 10 * 60_000;
    const { sock, ws } = await viewer(['reauth'], exp);
    acct.token = 'fresh1';
    await live(ws, exp - Date.now() - REAUTH_AHEAD_MS - 1000);
    expect(sentOf(ws).some((m) => m.t === 'reauth')).toBe(false);
    await live(ws, 1000);
    expect(FakeWS.all).toHaveLength(1);
    expect(sentOf(ws).filter((m) => m.t === 'reauth')).toEqual([{ t: 'reauth', token: 'fresh1' }]);
    const exp2 = Date.now() + 20 * 60_000;
    ws.msg({ t: 'reauth_ok', exp: exp2 });
    acct.token = 'fresh2';
    await live(ws, exp2 - Date.now() - REAUTH_AHEAD_MS);
    expect(sentOf(ws).filter((m) => m.t === 'reauth').map((m) => m.token)).toEqual(['fresh1', 'fresh2']);
    sock.close();
  });

  it('a call’s room (a ticket, not a token) never re-auths', async () => {
    const sock = openCallRoomSocket('0123456789abcdef', 'tkt', () => undefined, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWS.all.at(-1)!;
    ws.open();
    ws.msg({ t: 'hello', caps: ['reauth'] });
    window.dispatchEvent(new CustomEvent('ds:token', { detail: 'tok2' }));
    expect(sentOf(ws).some((m) => m.t === 'reauth')).toBe(false);
    sock.close();
  });
});

describe('what a room’s close means (wire.ts closeKind)', () => {
  async function closeWith(code: number, reason: string, mode: 'viewer' | 'line' = 'viewer') {
    const status: string[] = [];
    const sock = openMonitorSocket(NID, mode, () => undefined, () => undefined, (s, d) => status.push(d ? `${s}:${d}` : s));
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWS.all.at(-1)!;
    ws.open();
    ws.onclose?.({ code, reason });
    return { sock, status };
  }
  afterEach(() => registerStepUp(null));

  it('removed, signed out, a role refusal: final, each in its own words (4004 forbidden is not "removed")', async () => {
    expect((await closeWith(4004, 'removed')).status.at(-1)).toBe('closed:You were removed from this nursery.');
    expect((await closeWith(4004, 'revoked')).status.at(-1)).toBe(`closed:${CLOSE_TEXT.revoked}`);
    expect((await closeWith(4004, 'forbidden')).status.at(-1)).toBe(`closed:${CLOSE_TEXT.forbidden}`);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWS.all).toHaveLength(3);
  });

  it('too many attempts (4008): backs off at least 20 s, then tries again', async () => {
    const { sock, status } = await closeWith(4008, 'rate_limited');
    expect(status.at(-1)).toMatch(/^reconnecting/);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_WAIT_MS - 1);
    expect(FakeWS.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWS.all).toHaveLength(2);
    sock.close();
  });

  it('second sign-in step needed (4003): asks once, reconnects at once when given — never stops monitoring', async () => {
    const asked: string[] = [];
    registerStepUp(async (why) => {
      asked.push(why);
      return true;
    });
    const { sock, status } = await closeWith(4003, 'mfa_required');
    expect(status.at(-1)).toBe(`reconnecting:${CLOSE_TEXT.mfa_required}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toHaveLength(1);
    expect(FakeWS.all).toHaveLength(2);
    FakeWS.all[1].open();
    FakeWS.all[1].msg({ t: 'hello', you: {} });
    expect(status.at(-1)).toBe('connected');
    sock.close();
  });

  it('second step declined (or nothing can ask): no more prompts, slow retries — and at once when a fresh token arrives', async () => {
    let asks = 0;
    registerStepUp(async () => {
      asks += 1;
      return false;
    });
    const { sock, status } = await closeWith(4003, 'mfa_required');
    await vi.advanceTimersByTimeAsync(0);
    expect(asks).toBe(1);
    expect(FakeWS.all).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(AUTH_RETRY_MS);
      const ws = FakeWS.all.at(-1)!;
      ws.open();
      ws.onclose?.({ code: 4003, reason: 'mfa_required' });
    }
    expect(asks).toBe(1);
    expect(FakeWS.all).toHaveLength(4);
    expect(status).not.toContain('closed');
    // The code was given in Settings: the new token comes through, and it reconnects now.
    window.dispatchEvent(new CustomEvent('ds:token', { detail: 'tok-aal2' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWS.all).toHaveLength(5);
    sock.close();
  });

  it('a call line never prompts by itself: it tries again slowly', async () => {
    let asks = 0;
    registerStepUp(async () => {
      asks += 1;
      return true;
    });
    const sock = openUserLineSocket('u1', () => undefined, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    FakeWS.all[0].open();
    FakeWS.all[0].onclose?.({ code: 4003, reason: 'mfa_required' });
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_MS);
    expect(asks).toBe(0);
    expect(FakeWS.all).toHaveLength(2);
    sock.close();
  });
});

describe('membership changes (rooms that list `reauth` take them through the Worker)', () => {
  const MNID = '99999999-2222-4333-8444-555555555555';
  let calls: { url: string; init: RequestInit }[];
  let answers: { status: number; body: unknown }[];
  let rpcs: { fn: string; args: unknown }[];
  beforeEach(() => {
    calls = [];
    answers = [];
    rpcs = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const a = answers.shift() ?? { status: 200, body: { ok: true } };
      return new Response(JSON.stringify(a.body), { status: a.status });
    });
    acct.sb = { rpc: async (fn, args) => (rpcs.push({ fn, args }), { data: { ok: true }, error: null }) };
  });
  afterEach(() => {
    registerStepUp(null);
    noteNurseryCaps(MNID, []);
  });

  it('an older room: the RPCs, then the admin socket tells the room', async () => {
    expect(await removeMember(MNID, 'u-jo')).toEqual({ ok: true });
    expect(rpcs).toEqual([{ fn: 'monitor_remove_member', args: { p_nursery: MNID, p_user: 'u-jo' } }]);
    expect(calls).toEqual([]);
    void announceMembersChanged(MNID);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWS.all).toHaveLength(1);
  });

  it('a room that lists `reauth`: POST /members with the member’s token — nothing else to announce', async () => {
    noteNurseryCaps(MNID, ['reauth']);
    answers.push({ status: 200, body: { ok: true, changed: ['u-jo'] } });
    expect(await removeMember(MNID, 'u-jo')).toEqual({ ok: true, changed: ['u-jo'] });
    expect(await setMember(MNID, 'u-sam', 'caregiver', 'Nanny', 'role')).toMatchObject({ ok: true });
    expect(rpcs).toEqual([]);
    expect(calls.map((c) => c.url)).toEqual([`${calls[0].url.split('/api/')[0]}/api/monitor/${MNID}/members`, `${calls[0].url.split('/api/')[0]}/api/monitor/${MNID}/members`]);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ op: 'remove', user: 'u-jo' });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ op: 'role', user: 'u-sam', role: 'caregiver', label: 'Nanny' });
    await announceMembersChanged(MNID);
    expect(FakeWS.all).toHaveLength(0);
  });

  it('what a room can do is remembered on this device: the nursery list knows before any socket opens', async () => {
    noteNurseryCaps(MNID, ['reauth', 'e2e1', 'bogus']);
    expect(JSON.parse(localStorage.getItem(`ds-monitor-caps-${MNID}`)!)).toEqual(['reauth', 'e2e1', 'bogus']);
    vi.resetModules();
    const fresh = await import('./client');
    expect(fresh.nurseryCaps(MNID)).toEqual(['reauth', 'e2e1']);
  });

  it('the Worker asks for the second step: asked once, then sent again; declined → mfa_required', async () => {
    noteNurseryCaps(MNID, ['reauth']);
    let asks = 0;
    registerStepUp(async () => (asks += 1) === 1);
    answers.push({ status: 403, body: { ok: false, error: 'mfa_required' } }, { status: 200, body: { ok: true } });
    expect(await removeMember(MNID, 'u-jo')).toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
    answers.push({ status: 403, body: { ok: false, error: 'mfa_required' } });
    expect(await removeMember(MNID, 'u-jo')).toEqual({ ok: false, error: 'mfa_required' });
    expect(asks).toBe(2);
  });

  it('before an admin action: asks (false = cancelled); with nothing to ask, goes ahead — the server enforces it', async () => {
    expect(await ensureStepUp('Sharing a link')).toBe(true);
    registerStepUp(async () => false);
    expect(await ensureStepUp('Sharing a link')).toBe(false);
  });
});
