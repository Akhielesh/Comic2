// @vitest-environment node
// A direct call's own room: tickets in, the nursery line protocol out (so the
// app's call screen is the same), the handshake only between people in the
// call, history to everyone's line at the end — and nothing left behind.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallRoom, CLEANUP_MS, MAX_PENDING, MAX_SOCKETS, PENDING_SID } from './callRoom';
import { DOHarness, FakeWS, Pair } from './directTestKit';
import { LINE_GRACE_MS, RING_MS, type Call, type CallRecord } from './familyCalls';
import { STUN } from './ice';

const ID = '0123456789abcdef';
const ALICE = { uid: '00000000-0000-4000-8000-00000000a11c', name: 'Alice' };
const SAM = { uid: '00000000-0000-4000-8000-000000000005', name: 'Sam' };
const JO = { uid: '00000000-0000-4000-8000-000000000009', name: 'Jo' };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(replies: Record<string, { status: string; name?: string }> = {}) {
  vi.stubGlobal('WebSocketRequestResponsePair', Pair);
  const h = new DOHarness();
  const posts: { uid: string; path: string; body: Record<string, unknown> }[] = [];
  const USER_LINE = {
    idFromName: (n: string) => n,
    get: (n: string) => ({
      fetch: async (req: Request) => {
        const uid = n.replace(/^u:/, '');
        const path = new URL(req.url).pathname;
        const body = (await req.json()) as Record<string, unknown>;
        posts.push({ uid, path, body });
        const r = path === '/x/ring' ? replies[uid] ?? { status: 'ringing', name: uid === SAM.uid ? 'Sam' : 'Jo' } : { ok: true };
        return new Response(JSON.stringify(r), { status: 200 });
      },
    }),
  };
  const room = new CallRoom(h.state as never, { USER_LINE } as never);
  const init = async (to: unknown[] = [{ uid: SAM.uid, family: false, where: null }]) => {
    const res = await room.fetch(new Request('https://call.internal/x/init', { method: 'POST', body: JSON.stringify({ id: ID, from: ALICE, video: true, to }) }));
    return (await res.json()) as { status: string; ticket?: string; error?: string };
  };
  const ticketFor = (uid: string) => posts.find((p) => p.path === '/x/ring' && p.uid === uid)?.body.ticket as string;
  const enter = async (ticket: string, dev: string) => {
    const ws = h.accept(`s-${dev}`);
    await room.webSocketMessage(ws as never, JSON.stringify({ t: 'auth', ticket, dev }));
    return ws;
  };
  const say = (ws: FakeWS, msg: unknown) => room.webSocketMessage(ws as never, JSON.stringify(msg));
  const close = async (ws: FakeWS) => {
    h.drop(ws);
    await room.webSocketClose(ws as never);
  };
  const lastCall = (ws: FakeWS) => ws.last('call')?.call as Call | undefined;
  /** Alice places the call, both reach the room, Sam picks up. */
  const answered = async () => {
    const r = await init();
    const alice = await enter(r.ticket!, 'alice');
    await say(alice, { t: 'call_join', id: ID, video: true, mic: true });
    const sam = await enter(ticketFor(SAM.uid), 'sam');
    await say(sam, { t: 'call_join', id: ID, video: true, mic: true });
    return { alice, sam };
  };
  return { h, room, posts, init, ticketFor, enter, say, close, lastCall, answered };
}

describe('CallRoom', () => {
  it('books the call with the caller pending and rings everyone asked through their line', async () => {
    const { init, posts, h } = setup();
    const r = await init();
    expect(r).toEqual({ status: 'ringing', ticket: expect.stringMatching(/^[\w-]{32}$/) });
    const ring = posts.find((p) => p.path === '/x/ring')!;
    expect(ring).toMatchObject({ uid: SAM.uid, body: { id: ID, from: ALICE, video: true, family: false, ticket: expect.any(String) } });
    const [call] = h.store.get('calls') as Call[];
    expect(call.parts).toEqual([expect.objectContaining({ uid: ALICE.uid, sid: PENDING_SID, gone: expect.any(Number) })]);
    expect(call.invited).toEqual([SAM.uid]);
    // Only hashes of tickets are kept.
    expect(JSON.stringify(h.store.get('tickets'))).not.toContain(r.ticket);
    expect(JSON.stringify(h.store.get('tickets'))).not.toContain(ring.body.ticket as string);
  });

  it('is made once: a second init is refused', async () => {
    const { init } = setup();
    await init();
    expect(await init()).toEqual({ error: 'exists' });
  });

  it('refuses a socket without a valid ticket', async () => {
    const { init, enter } = setup();
    await init();
    const ws = await enter('not-a-ticket', 'x');
    expect(ws.closed).toBe(4003);
    expect(ws.last('error')).toMatchObject({ code: 'forbidden' });
  });

  it('says hello in the nursery line’s shape, plus fresh ICE servers', async () => {
    const { init, enter } = setup();
    const r = await init();
    const ws = await enter(r.ticket!, 'alice');
    const hello = ws.last('hello')!;
    expect(hello).toMatchObject({
      you: { sid: 's-alice', uid: ALICE.uid, name: 'Alice', label: null, mode: 'line' },
      nursery: { id: 'direct', name: 'Stream Studio', baby: null },
      ice: STUN,
      vapid: null,
      callLog: [],
    });
    expect((hello.calls as Call[])[0]).toMatchObject({ id: ID, from: { uid: ALICE.uid, name: 'Alice' }, invited: [SAM.uid] });
  });

  it('answering: the caller’s join swaps in their connection, the callee’s other devices stop ringing, signals flow only between the two', async () => {
    const { answered, lastCall, posts, say, enter } = setup();
    const { alice, sam } = await answered();
    const call = lastCall(alice)!;
    expect(call.answeredAt).toEqual(expect.any(Number));
    expect(call.parts.map((p) => [p.sid, p.gone])).toEqual([['s-alice', undefined], ['s-sam', undefined]]);
    expect(sam.last('call_joined')).toEqual({ t: 'call_joined', id: ID, ice: STUN });
    expect(posts.filter((p) => p.path === '/x/update')).toEqual([{ uid: SAM.uid, path: '/x/update', body: { id: ID, stop: true } }]);

    await say(sam, { t: 'call_rtc', id: ID, to: 's-alice', d: { sdp: { type: 'offer', sdp: 'x' }, cid: 'k1' } });
    expect(alice.msgs('call_rtc')).toEqual([{ t: 'call_rtc', id: ID, from: 's-sam', d: { sdp: { type: 'offer', sdp: 'x' }, cid: 'k1' } }]);
    // A ticket holder not in the call (Sam's laptop, still ringing) can't signal, nor be signalled.
    const laptop = await enter(posts.find((p) => p.path === '/x/ring')!.body.ticket as string, 'laptop');
    await say(laptop, { t: 'call_rtc', id: ID, to: 's-alice', d: { cand: {} } });
    await say(alice, { t: 'call_rtc', id: ID, to: 's-laptop', d: { cand: {} } });
    expect(alice.msgs('call_rtc')).toHaveLength(1);
    expect(laptop.msgs('call_rtc')).toHaveLength(0);

    await say(sam, { t: 'call_media', id: ID, mic: false, cam: true });
    expect(lastCall(alice)!.parts.find((p) => p.uid === SAM.uid)).toMatchObject({ mic: false, cam: true });
  });

  it('declined: everyone’s line gets the history line — and nobody a missed call', async () => {
    const { init, room, posts } = setup();
    await init();
    await room.fetch(new Request('https://call.internal/x/decline', { method: 'POST', body: JSON.stringify({ id: ID, uid: SAM.uid }) }));
    const logs = posts.filter((p) => p.path === '/x/log');
    expect(logs.map((p) => [p.uid, p.body.missed])).toEqual([[ALICE.uid, false], [SAM.uid, false]]);
    expect((logs[0].body.rec as CallRecord).why).toBe('declined');
  });

  it('nobody picks up: no answer, and a missed call for the person rung', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-10-22T10:00:00Z').getTime();
    vi.setSystemTime(t0);
    const { init, enter, say, room, posts, h, lastCall } = setup();
    const r = await init();
    const alice = await enter(r.ticket!, 'alice');
    await say(alice, { t: 'call_join', id: ID, video: true });
    expect(h.alarmAt).toBeLessThanOrEqual(t0 + RING_MS + 500);
    vi.setSystemTime(t0 + RING_MS + 1);
    await room.alarm();
    expect(lastCall(alice)!.ended?.why).toBe('no_answer');
    const logs = posts.filter((p) => p.path === '/x/log');
    expect(logs.map((p) => [p.uid, p.body.missed])).toEqual([[ALICE.uid, false], [SAM.uid, true]]);
    expect((logs[1].body.rec as CallRecord).answered).toBe(false);
  });

  it('a caller who never reaches the room: cancelled after the grace', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-10-22T10:00:00Z').getTime();
    vi.setSystemTime(t0);
    const { init, room, posts } = setup();
    await init();
    vi.setSystemTime(t0 + LINE_GRACE_MS + 1);
    await room.alarm();
    expect((posts.find((p) => p.path === '/x/log')!.body.rec as CallRecord).why).toBe('cancelled');
  });

  it('nobody can be rung: over at once — the caller hears why, the unreachable get a missed call, the family-only nothing', async () => {
    const { init, posts, h } = setup({ [SAM.uid]: { status: 'unavailable' }, [JO.uid]: { status: 'restricted' } });
    const r = await init([{ uid: SAM.uid, family: false, where: null }, { uid: JO.uid, family: false, where: null }]);
    expect(r.status).toBe('unavailable');
    const logs = posts.filter((p) => p.path === '/x/log');
    expect(logs.map((p) => [p.uid, p.body.missed])).toEqual([[ALICE.uid, false], [SAM.uid, true], [JO.uid, true]]);
    expect(h.store.get('endedAt')).toEqual(expect.any(Number));
    const only = setup({ [SAM.uid]: { status: 'restricted' } });
    expect((await only.init()).status).toBe('restricted');
  });

  it('adding someone mints them a ticket and rings their line', async () => {
    const { answered, room, posts, enter, lastCall } = setup();
    const { alice } = await answered();
    const res = await room.fetch(new Request('https://call.internal/x/invite', { method: 'POST', body: JSON.stringify({ id: ID, by: ALICE.uid, to: [{ uid: JO.uid, family: true, where: 'Aria’s family' }] }) }));
    expect(await res.json()).toEqual({ status: 'ringing', added: [JO.uid] });
    const ring = posts.filter((p) => p.path === '/x/ring').at(-1)!;
    expect(ring).toMatchObject({ uid: JO.uid, body: { id: ID, family: true, where: 'Aria’s family' } });
    expect(lastCall(alice)!.invited).toEqual([SAM.uid, JO.uid]);
    const jo = await enter(ring.body.ticket as string, 'jo');
    expect(jo.last('hello')).toMatchObject({ you: { uid: JO.uid, name: 'Jo' } });
    // Only someone in the call can add people.
    const no = await room.fetch(new Request('https://call.internal/x/invite', { method: 'POST', body: JSON.stringify({ id: ID, by: JO.uid, to: [{ uid: SAM.uid }] }) }));
    expect(no.status).toBe(403);
  });

  it('someone other than the caller adding a person: rung as the call and as the person adding them, with who’s in it', async () => {
    const { answered, room, posts } = setup();
    await answered();
    // Sam (not the caller) adds Jo. His line's family word is about Sam, and goes along as such.
    const res = await room.fetch(new Request('https://call.internal/x/invite', { method: 'POST', body: JSON.stringify({ id: ID, by: SAM.uid, to: [{ uid: JO.uid, family: true, where: 'Aria’s family' }], famAt: 123 }) }));
    expect(await res.json()).toEqual({ status: 'ringing', added: [JO.uid] });
    const ring = posts.filter((p) => p.path === '/x/ring').at(-1)!;
    // Regression: the ring went out as if Alice alone were ringing, so Jo's line judged only Alice.
    expect(ring.body).toMatchObject({ from: ALICE, by: { uid: SAM.uid, name: 'Sam' }, family: true, famAt: 123 });
    expect(ring.body.with ?? []).toEqual([]);
    // The caller adding someone: no `by` (it's their own call), and Sam is listed as already in it.
    await room.fetch(new Request('https://call.internal/x/invite', { method: 'POST', body: JSON.stringify({ id: ID, by: ALICE.uid, to: [{ uid: '00000000-0000-4000-8000-00000000000a', family: false, where: null }] }) }));
    const second = posts.filter((p) => p.path === '/x/ring').at(-1)!;
    expect(second.body.by).toBeUndefined();
    expect(second.body.with).toEqual([SAM.uid]);
  });

  it('the caller hanging up before reaching the room cancels the call there and then', async () => {
    const { init, room, posts, h } = setup();
    await init();
    const cancel = (by: string) => room.fetch(new Request('https://call.internal/x/cancel', { method: 'POST', body: JSON.stringify({ id: ID, by }) })).then((r) => r.json());
    // Only the caller's own line can.
    expect(await cancel(SAM.uid)).toEqual({ ok: false });
    expect(h.store.get('endedAt')).toBeUndefined();
    // Regression: it rang on until the caller's 20-second grace ran out.
    expect(await cancel(ALICE.uid)).toEqual({ ok: true });
    const log = posts.find((p) => p.path === '/x/log')!;
    expect((log.body.rec as CallRecord).why).toBe('cancelled');
    expect(h.store.get('endedAt')).toEqual(expect.any(Number));
  });

  it('a caller already in the room isn’t dropped by a late cancel (hanging up there is a call_leave)', async () => {
    const { init, room, enter, say, h } = setup();
    const r = await init();
    const alice = await enter(r.ticket!, 'alice');
    await say(alice, { t: 'call_join', id: ID, video: true, mic: true });
    const res = await room.fetch(new Request('https://call.internal/x/cancel', { method: 'POST', body: JSON.stringify({ id: ID, by: ALICE.uid }) }));
    expect(await res.json()).toEqual({ ok: false });
    expect(h.store.get('endedAt')).toBeUndefined();
  });

  it('idle sockets without a ticket can’t fill the room: only ticket holders count towards its limit', async () => {
    const { init, room, h, enter, ticketFor } = setup();
    await init();
    // Regression: unauthenticated sockets counted, so 16 idle ones kept everyone in the call out.
    const idle = Array.from({ length: MAX_SOCKETS + 4 }, () => {
      const ws = new FakeWS(h);
      room.admit(ws as never);
      return ws;
    });
    expect(h.sockets.length).toBeLessThanOrEqual(MAX_PENDING);
    expect(idle.filter((ws) => ws.closed != null)).toHaveLength(idle.length - MAX_PENDING);
    const sam = await enter(ticketFor(SAM.uid), 'sam');
    expect(sam.closed).toBeNull();
    expect(sam.last('hello')).toBeTruthy();
  });

  it('wipes itself two minutes after the call ends, closing whatever is left', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-10-22T10:00:00Z').getTime();
    vi.setSystemTime(t0);
    const { answered, say, room, h, enter, ticketFor } = setup();
    const { alice, sam } = await answered();
    await say(alice, { t: 'call_leave', id: ID });
    expect(h.store.get('endedAt')).toBe(t0);
    // A late device can't come in to a finished call.
    const late = await enter(ticketFor(SAM.uid), 'late');
    expect(late.closed).toBe(4006);
    vi.setSystemTime(t0 + CLEANUP_MS + 1);
    await room.alarm();
    expect(h.store.size).toBe(0);
    expect(h.alarmAt).toBeNull();
    expect(sam.closed).toBe(4006);
  });
});
