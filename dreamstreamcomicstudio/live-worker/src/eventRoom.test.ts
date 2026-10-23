// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_SAVE_EVERY,
  CURVE_SAMPLE_MS,
  EventRoom,
  LIVE_WATCHDOG_MS,
  RECORDING_RETENTION_MS,
  REPLAY_WINDOW_MS,
  SEG_SAVE_EVERY,
  SWEEP_GRACE_MS,
  type ChatMsg,
  type EventMeta,
} from './eventRoom';
import { Sim, type SimWS } from './eventTestKit';
import { STUN, includesTurn, resetIceCache } from './ice';
import { resetHostPasses } from './index';
import { STRIKE_LIMIT } from './moderation';
import { clearMemberCache } from './supabaseAuth';

class FakeWS {
  sent: Record<string, unknown>[] = [];
  private att: unknown;
  constructor(att: unknown) {
    this.att = structuredClone(att);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  serializeAttachment(a: unknown) {
    this.att = structuredClone(a);
  }
  deserializeAttachment() {
    return this.att;
  }
  close() {}
  msgs(t: string) {
    return this.sent.filter((m) => m.t === t);
  }
}

/** Just enough DurableObjectState for EventRoom: KV storage (single + batch put) and sockets. */
function setup(env: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>();
  const sockets: FakeWS[] = [];
  const state = {
    storage: {
      get: async (k: string) => structuredClone(store.get(k)),
      put: async (k: string | Record<string, unknown>, v?: unknown) => {
        if (typeof k === 'string') store.set(k, structuredClone(v));
        else for (const [kk, vv] of Object.entries(k)) store.set(kk, structuredClone(vv));
      },
      delete: async (k: string) => store.delete(k),
      setAlarm: async () => undefined,
      getAlarm: async () => null,
    },
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: FakeWS) => void sockets.push(ws),
  };
  const room = new EventRoom(state as never, { ALLOWED_ORIGINS: '*', ...env } as never);
  const join = (role: string, sid = role) => {
    const ws = new FakeWS({ sid, name: role, role });
    sockets.push(ws);
    return ws;
  };
  const say = (ws: FakeWS, msg: Record<string, unknown>) => room.webSocketMessage(ws as never, JSON.stringify(msg));
  const init = (body: Record<string, unknown>) =>
    room.fetch(new Request('https://room.internal/init', { method: 'POST', body: JSON.stringify({ id: 'ev1', title: 'T', ...body }) }));
  return { room, store, sockets, join, say, init, meta: () => store.get('meta') as EventMeta };
}

describe('EventRoom · meeting kind', () => {
  it('stores a meeting as a meeting and logs that nothing is broadcast', async () => {
    const r = setup();
    const res = await r.init({ kind: 'meeting' });
    expect(res.status).toBe(200);
    expect(r.meta().kind).toBe('meeting');
    expect(r.meta().status).toBe('idle');
    const log = r.store.get('log') as { msg: string }[];
    expect(log.at(-1)?.msg).toMatch(/Meeting started/);
  });

  it('defaults anything else to a broadcast (old clients send no kind)', async () => {
    const a = setup();
    await a.init({});
    expect(a.meta().kind).toBe('broadcast');
    const b = setup();
    await b.init({ kind: 'party-mode' });
    expect(b.meta().kind).toBe('broadcast');
  });

  it('ends an idle meeting with a meeting-shaped log line', async () => {
    const r = setup();
    await r.init({ kind: 'meeting' });
    const host = r.join('host');
    await r.say(host, { t: 'state', status: 'ended' });
    expect(r.meta().status).toBe('ended');
    const log = r.store.get('log') as { msg: string }[];
    expect(log.at(-1)?.msg).toMatch(/Meeting ended/);
  });
});

describe('EventRoom · ICE servers over the room socket', () => {
  beforeEach(() => resetIceCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    resetIceCache();
  });

  it('answers host and guests with STUN only when no TURN secrets are set', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = setup();
    await r.init({});
    const host = r.join('host');
    const guest = r.join('guest');
    await r.say(host, { t: 'ice' });
    await r.say(guest, { t: 'ice' });
    expect(host.msgs('ice')[0].servers).toEqual(STUN);
    expect(guest.msgs('ice')[0].servers).toEqual(STUN);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('adds Cloudflare TURN when the owner configured it', async () => {
    const turn = { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ iceServers: turn }), { status: 200 })));
    const r = setup({ TURN_KEY_ID: 'k', TURN_KEY_API_TOKEN: 't' });
    await r.init({});
    const host = r.join('host');
    await r.say(host, { t: 'ice' });
    const servers = host.msgs('ice')[0].servers as { urls: string | string[] }[];
    expect(includesTurn(servers)).toBe(true);
    expect(servers.slice(0, STUN.length)).toEqual(STUN);
  });

  it('never hands ICE credentials to viewers or the lobby', async () => {
    const r = setup();
    await r.init({});
    const viewer = r.join('viewer');
    const pending = r.join('pending');
    await r.say(viewer, { t: 'ice' });
    await r.say(pending, { t: 'ice' });
    expect(viewer.msgs('ice')).toHaveLength(0);
    expect(pending.msgs('ice')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────── C10: a frugal room that forgets nothing people rely on

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A broadcast through the real Worker (eventTestKit): the studio's socket, uploads, viewers. */
async function onAir(sim: Sim, body: Record<string, unknown> = {}) {
  const created = await sim.worker('/api/events', { method: 'POST', headers: { authorization: 'Bearer member-token-0123456789' }, body: JSON.stringify({ title: 'Show', maxViewers: 200, ...body }) });
  const { id, hostKey } = (await created.json()) as { id: string; hostKey: string };
  const h = sim.room(id);
  let host = await sim.open(id, `k=${hostKey}&name=Host`);
  if (body.kind !== 'meeting') await sim.say(id, host, { t: 'state', status: 'live' });
  let seq = 0;
  return {
    id,
    hostKey,
    h,
    get host() {
      return host;
    },
    async reconnectHost() {
      host = await sim.open(id, `k=${hostKey}&name=Host`);
      return host;
    },
    /** `n` segments, 6 s apart, numbered by the studio's own counter. */
    async upload(n = 1) {
      for (let i = 0; i < n; i++) {
        await sim.advanceTo(sim.now + 6000);
        const res = await sim.worker(`/api/events/${id}/segments?seq=${++seq}&ms=6000`, { method: 'POST', headers: { 'content-type': 'video/mp4', 'x-host-key': hostKey }, body: new Uint8Array(100) });
        expect(res.status, `segment ${seq}`).toBe(200);
      }
      return seq;
    },
    view: (name: string) => sim.open(id, `name=${encodeURIComponent(name)}`),
    say: (ws: SimWS, msg: Record<string, unknown>) => sim.say(id, ws, msg),
    meta: async () => (await (await sim.worker(`/api/events/${id}`)).json()) as EventMeta & { viewers: number },
    stored: <T,>(k: string) => h.store.get(k) as T,
    summary: async () =>
      (await (await sim.worker(`/api/events/${id}/stats?k=${encodeURIComponent(hostKey)}`)).json()) as {
        stats: { curve: { at: number; n: number }[]; emojiTotal: number; chatTotal: number; use?: { viewerMinutes?: number } };
      },
  };
}

const lastLine = (ws: SimWS) => (ws.msgs('chat').at(-1)!.m as ChatMsg).id;
const helloChat = (ws: SimWS) => (ws.msgs('hello')[0].chat as ChatMsg[]).map((m) => m.text);

function cleanup() {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetHostPasses();
  clearMemberCache();
}

describe('EventRoom · segments write the meta every SEG_SAVE_EVERY segments (C10)', () => {
  afterEach(cleanup);

  it('a segment between saves writes no row, yet every reader sees where the stream is', async () => {
    const sim = new Sim();
    const e = await onAir(sim);
    await e.upload(1); // the first segment writes at once (codec, firstSeq)
    const rows = e.h.rowsOf('meta');
    await e.upload(4);
    expect(e.h.rowsOf('meta')).toBe(rows);
    expect(e.stored<EventMeta>('meta').latestSeq).toBe(1);
    expect((await e.meta()).latestSeq).toBe(5); // a studio reload, the invite page
    const v = await e.view('Ana');
    expect((v.msgs('hello')[0].meta as EventMeta).latestSeq).toBe(5); // a joining viewer starts at the live edge
    await e.upload(SEG_SAVE_EVERY - 4);
    expect(e.h.rowsOf('meta')).toBe(rows + 1);
    expect(e.stored<EventMeta>('meta')).toMatchObject({ latestSeq: 1 + SEG_SAVE_EVERY, use: expect.objectContaining({ segCount: 1 + SEG_SAVE_EVERY }) });
  });

  it('hibernation between segments loses nothing: the host’s socket carries the progress', async () => {
    const sim = new Sim();
    const e = await onAir(sim);
    await e.upload(7);
    expect(e.stored<EventMeta>('meta').latestSeq).toBe(1);
    e.h.hibernate(); // memory gone; storage and the sockets' attachments stay
    const m = await e.meta();
    expect(m.latestSeq).toBe(7);
    expect(m).not.toHaveProperty('use'); // still private
    const rows = e.h.rowsOf('meta');
    await e.upload(1); // after a wake the next segment writes it
    expect(e.h.rowsOf('meta')).toBe(rows + 1);
    expect(e.stored<EventMeta>('meta')).toMatchObject({ latestSeq: 8, use: expect.objectContaining({ segCount: 8 }) });
  });

  it('a studio reload after a hibernation resumes at the right seq (no segment is overwritten)', async () => {
    const sim = new Sim();
    const e = await onAir(sim);
    await e.upload(7);
    e.h.hibernate();
    await sim.leave(e.id, e.host); // the reload: the studio's socket goes first
    expect(e.stored<EventMeta>('meta')).toMatchObject({ status: 'paused', latestSeq: 7 });
    expect((await e.meta()).latestSeq).toBe(7); // StudioView resumes at latestSeq + 1
  });

  it('the progress moves with the studio’s sockets: a new tab takes it, and it survives the old tab closing and another hibernation', async () => {
    const sim = new Sim();
    const e = await onAir(sim);
    await e.upload(7);
    const first = e.host;
    e.h.hibernate();
    await e.reconnectHost(); // a second studio tab (or a reconnect before the old socket is noticed gone)
    await sim.leave(e.id, first);
    e.h.hibernate();
    expect(e.stored<EventMeta>('meta').latestSeq).toBe(1);
    expect((await e.meta()).latestSeq).toBe(7);
  });

  it('an eviction that dropped every socket (a deploy) lags at most SEG_SAVE_EVERY − 1 segments, and the next segment puts it right', async () => {
    const sim = new Sim();
    const e = await onAir(sim);
    const last = await e.upload(SEG_SAVE_EVERY);
    e.h.evict();
    expect(last - (await e.meta()).latestSeq).toBeLessThanOrEqual(SEG_SAVE_EVERY - 1);
    // The studio didn't reload — its socket reconnects and its own counter goes on.
    await e.reconnectHost();
    await e.upload(1);
    expect((await e.meta()).latestSeq).toBe(last + 1);
  });

  it('with no host socket to carry it, every segment is written at once (as before)', async () => {
    const sim = new Sim();
    const e = await onAir(sim);
    await sim.leave(e.id, e.host); // the studio's socket dropped; its uploads go on
    const rows = e.h.rowsOf('meta');
    await e.upload(3);
    expect(e.h.rowsOf('meta')).toBe(rows + 3);
    expect(e.stored<EventMeta>('meta').latestSeq).toBe(3);
  });

  it('two uploads in flight at once (the studio sends two) never move latestSeq backwards or lose a segment', async () => {
    const sim = new Sim();
    const e = await onAir(sim);
    await e.upload(3);
    // Straight into the room, interleaved at every await (harsher than production, where storage awaits are gated).
    const ingest = (seq: number) =>
      e.h.room.fetch(new Request('https://room.internal/ingest', { method: 'POST', headers: { 'x-host-key': e.hostKey }, body: JSON.stringify({ seq, ms: 6000, at: sim.now, mime: 'video/mp4', bytes: 10 }) }));
    const [a, b] = await Promise.all([ingest(5), ingest(4)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    await e.upload(0);
    expect((await e.meta()).latestSeq).toBe(5);
    await sim.leave(e.id, e.host); // writes the progress
    expect(e.stored<EventMeta>('meta')).toMatchObject({ latestSeq: 5, use: expect.objectContaining({ segCount: 5 }) });
  });
});

describe('EventRoom · while live, chat, reactions and stats ride one checkpoint (C10)', () => {
  afterEach(cleanup);

  it('no row per chat line; a joiner’s hello has the unsaved lines; the next checkpoint writes them in one row', async () => {
    const sim = new Sim();
    const e = await onAir(sim);
    await e.upload(1);
    const [v, w] = [await e.view('Ana'), await e.view('Bo')];
    const rows = () => ({ chat: e.h.rowsOf('chat'), chatters: e.h.rowsOf('chatters'), stats: e.h.rowsOf('stats') });
    const before = rows();
    for (let i = 0; i < 5; i++) {
      sim.now += 1000;
      await e.say(i % 2 ? v : w, { t: 'chat', text: `hello ${i}` });
    }
    expect(rows()).toEqual(before);
    const lines = ['hello 0', 'hello 1', 'hello 2', 'hello 3', 'hello 4'];
    expect(helloChat(await e.view('Cy'))).toEqual(lines);
    await e.upload(SEG_SAVE_EVERY); // the next checkpoint
    expect(e.h.rowsOf('chat')).toBe(before.chat + 1);
    expect(e.stored<ChatMsg[]>('chat').map((m) => m.text)).toEqual(lines);
    expect(e.stored<Record<string, number>>('chatters')).toEqual({ Ana: 2, Bo: 3 });
  });

  it('a deleted line is written at once — even one never saved — and stays gone', async () => {
    const sim = new Sim();
    const e = await onAir(sim);
    const v = await e.view('Ana');
    await e.say(v, { t: 'chat', text: 'oops' });
    const id = lastLine(v);
    const rows = e.h.rowsOf('chat');
    await e.say(e.host, { t: 'delete', id });
    expect(e.h.rowsOf('chat')).toBe(rows + 1);
    expect(e.stored<ChatMsg[]>('chat').map((m) => m.id)).not.toContain(id);
    expect(v.msgs('delete')).toEqual([{ t: 'delete', id }]);
    e.h.evict();
    expect(helloChat(await e.view('Late'))).not.toContain('oops');
  });

  it('profanity is never stored; strikes and the timeout are written at once', async () => {
    const sim = new Sim();
    const e = await onAir(sim);
    const v = await e.view('Ana');
    const strikeRows = e.h.rowsOf('strikes');
    for (let i = 0; i < STRIKE_LIMIT; i++) {
      sim.now += 1000;
      await e.say(v, { t: 'chat', text: `you bastard ${i}` });
    }
    expect(e.h.rowsOf('strikes')).toBe(strikeRows + STRIKE_LIMIT);
    expect(e.stored<Record<string, { until: number }>>('strikes').Ana.until).toBeGreaterThan(sim.now);
    expect(String(v.msgs('notice').at(-1)!.text)).toMatch(/timed out/);
    sim.now += 1000;
    await e.say(v, { t: 'chat', text: 'sorry' });
    expect(v.msgs('chat')).toEqual([]); // timed out: nothing broadcast
    await e.upload(SEG_SAVE_EVERY + 1);
    expect(e.stored<ChatMsg[]>('chat')).toEqual([]);
  });

  it('CHAT_SAVE_EVERY unsaved lines force a write (bounding what an eviction could take)', async () => {
    const sim = new Sim();
    const e = await onAir(sim);
    const v = await e.view('Ana');
    const rows = e.h.rowsOf('chat');
    for (let i = 1; i < CHAT_SAVE_EVERY; i++) {
      sim.now += 500;
      await e.say(v, { t: 'chat', text: `line ${i}` });
    }
    expect(e.h.rowsOf('chat')).toBe(rows);
    sim.now += 500;
    await e.say(v, { t: 'chat', text: `line ${CHAT_SAVE_EVERY}` });
    expect(e.h.rowsOf('chat')).toBe(rows + 1);
    expect(e.stored<ChatMsg[]>('chat')).toHaveLength(CHAT_SAVE_EVERY);
  });

  it('an eviction can take only the unsaved lines (under a minute, under CHAT_SAVE_EVERY) — never a moderation action', async () => {
    const sim = new Sim();
    const e = await onAir(sim);
    const v = await e.view('Ana');
    for (const t of ['one', 'two', 'three']) {
      sim.now += 1000;
      await e.say(v, { t: 'chat', text: t });
    }
    await e.say(e.host, { t: 'delete', id: (v.msgs('chat')[0].m as ChatMsg).id }); // written at once, with the lines before it
    for (const t of ['four', 'five']) {
      sim.now += 1000;
      await e.say(v, { t: 'chat', text: t });
    }
    e.h.evict();
    expect(helloChat(await e.view('Late'))).toEqual(['two', 'three']);
  });

  it('reactions while live cost no row; the summary counts every one', async () => {
    const sim = new Sim();
    const e = await onAir(sim);
    const v = await e.view('Ana');
    const rows = e.h.rows;
    for (let i = 0; i < 50; i++) {
      sim.now += 100;
      await e.say(v, { t: 'emoji', e: '🔥' });
    }
    expect(e.h.rows).toBe(rows);
    expect((await e.summary()).stats.emojiTotal).toBe(50);
  });

  it('not live (a meeting, which may hibernate any time): every change is written at once, as before', async () => {
    const sim = new Sim();
    const e = await onAir(sim, { kind: 'meeting' });
    const v = await e.view('Ana');
    const rows = () => ({ chat: e.h.rowsOf('chat'), chatters: e.h.rowsOf('chatters'), stats: e.h.rowsOf('stats') });
    const before = rows();
    await e.say(v, { t: 'chat', text: 'hi' });
    expect(rows()).toEqual({ chat: before.chat + 1, chatters: before.chatters + 1, stats: before.stats + 1 });
    await e.say(v, { t: 'emoji', e: '🔥' });
    expect(e.h.rowsOf('stats')).toBe(before.stats + 2);
    e.h.evict();
    expect(helloChat(await e.view('Late'))).toEqual(['hi']);
  });
});

describe('EventRoom · the segments sample the curve; the alarm is a watchdog (C10)', () => {
  afterEach(cleanup);

  it('a point every 30 s from the segments, and no alarm at all while they flow', async () => {
    const sim = new Sim();
    const e = await onAir(sim);
    expect(e.h.alarmAt).toBe(sim.now + LIVE_WATCHDOG_MS);
    await e.view('Ana');
    await e.upload(20); // 2 minutes
    const curve = (await e.summary()).stats.curve;
    expect(curve).toHaveLength(1 + 4); // going live, then every 30 s
    for (let i = 1; i < curve.length; i++) expect(curve[i].at - curve[i - 1].at).toBeGreaterThanOrEqual(CURVE_SAMPLE_MS);
    expect(curve.at(-1)!.n).toBe(1);
    expect(sim.alarms).toBe(0);
  });

  it('viewer-minutes count the time on air, never a pause', async () => {
    const sim = new Sim();
    const e = await onAir(sim);
    await e.view('Ana');
    await e.view('Bo');
    await e.upload(10); // 1 min
    await e.say(e.host, { t: 'state', status: 'paused' });
    await sim.advanceTo(sim.now + 10 * MIN);
    await e.say(e.host, { t: 'state', status: 'live' });
    await e.upload(10); // 1 min
    await e.say(e.host, { t: 'state', status: 'ended' });
    expect((await e.summary()).stats.use?.viewerMinutes).toBeCloseTo(4, 5); // 2 viewers × 2 min on air
  });

  it('a stalled stream still gets a point from each watchdog tick, and ends itself after 2 h without segments', async () => {
    const sim = new Sim();
    const e = await onAir(sim);
    const v = await e.view('Ana');
    await e.upload(1);
    await sim.advanceTo(sim.now + 2 * HOUR + LIVE_WATCHDOG_MS + MIN);
    expect((await e.summary()).stats.curve.length).toBeGreaterThanOrEqual(12);
    expect(e.stored<EventMeta>('meta').status).toBe('ended');
    expect(v.msgs('state').at(-1)).toMatchObject({ status: 'ended' });
  });
});

describe('EventRoom · the 7-day sweep empties the room (C10)', () => {
  afterEach(cleanup);

  async function ended(sim: Sim) {
    const e = await onAir(sim);
    await e.upload(3);
    const v = await e.view('Ana');
    await e.say(e.host, { t: 'state', status: 'ended' });
    return { ...e, host: e.host, v, endedAt: sim.now };
  }

  it('after the recordings go, every row and the alarm go too; open sockets are closed and nothing writes back', async () => {
    const sim = new Sim();
    const e = await ended(sim);
    sim.r2.set(`events/${e.id}/rec/1-100/a.webm`, { body: new Uint8Array(1), type: 'video/webm' });
    sim.r2.set('events/someoneelse/seg/1', { body: new Uint8Array(1), type: 'video/mp4' });
    await sim.advanceTo(e.endedAt + REPLAY_WINDOW_MS + MIN);
    expect(e.h.store.size).toBeGreaterThan(0); // the recap stays for the 7 days
    expect((await sim.worker(`/api/events/${e.id}`)).status).toBe(200);
    await sim.advanceTo(e.endedAt + RECORDING_RETENTION_MS + MIN);
    expect(e.h.store.size).toBe(0);
    expect(e.h.alarmAt).toBeNull();
    expect([...sim.r2.keys()]).toEqual(['events/someoneelse/seg/1']);
    expect(e.v.closed).toBe(1000);
    // Anything a socket still says, or its close, writes nothing back.
    await e.h.room.webSocketMessage(e.v as never, JSON.stringify({ t: 'chat', text: 'still here?' }));
    await e.h.room.webSocketMessage(e.host as never, JSON.stringify({ t: 'health', up: 1, enc: 1, fail: 0 }));
    await e.h.room.webSocketMessage(e.host as never, JSON.stringify({ t: 'guestkey' }));
    await e.h.room.webSocketClose(e.v as never);
    expect(e.h.store.size).toBe(0);
    expect((await sim.worker(`/api/events/${e.id}`)).status).toBe(404);
    expect((await sim.worker(`/api/events/${e.id}/stats?k=${e.hostKey}`)).status).toBe(404);
  });

  it('a usage flush held back by the hourly bound postpones the sweep, so nothing is lost or counted twice', async () => {
    const sim = new Sim();
    const e = await ended(sim);
    await sim.advanceTo(e.endedAt + RECORDING_RETENTION_MS - 10 * MIN);
    // A 7-day copy registered 10 minutes before the sweep: its usage is written now…
    const reg = await e.h.room.fetch(
      new Request('https://room.internal/rec/register', {
        method: 'POST',
        headers: { 'x-host-key': e.hostKey },
        body: JSON.stringify({ key: `events/${e.id}/rec/1-50/a.webm`, file: 'a.webm', bytes: 50, stored: 50, mime: 'video/webm', durMs: 1 }),
      }),
    );
    expect(reg.status).toBe(200);
    const copies = () => sim.points.filter((p) => (p as { indexes?: string[] }).indexes?.[0] === 'cloud_copy').length;
    expect(copies()).toBe(1);
    // …so the sweep can't flush again within the hour: it waits rather than lose anything.
    await sim.advanceTo(e.endedAt + RECORDING_RETENTION_MS + MIN);
    expect(e.h.store.size).toBeGreaterThan(0);
    await sim.advanceTo(e.endedAt + RECORDING_RETENTION_MS + 2 * HOUR);
    expect(e.h.store.size).toBe(0);
    expect(copies()).toBe(1);
  });

  it('with R2 down the sweep keeps the rows and retries hourly; past SWEEP_GRACE_MS the rows go anyway', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sim = new Sim();
    const e = await ended(sim);
    sim.r2Down = true;
    await sim.advanceTo(e.endedAt + REPLAY_WINDOW_MS + MIN); // the segment purge retries too
    await sim.advanceTo(e.endedAt + RECORDING_RETENTION_MS + MIN);
    expect(e.h.store.size).toBeGreaterThan(0);
    expect(e.h.alarmAt).toBeLessThanOrEqual(sim.now + HOUR);
    await sim.advanceTo(e.endedAt + RECORDING_RETENTION_MS + SWEEP_GRACE_MS + 2 * HOUR); // day 9
    expect(e.h.store.size).toBe(0);
    expect(e.h.alarmAt).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('R2 back before day 9: the retried sweep empties both', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sim = new Sim();
    const e = await ended(sim);
    await sim.advanceTo(e.endedAt + REPLAY_WINDOW_MS + MIN);
    sim.r2.set(`events/${e.id}/rec/1-100/a.webm`, { body: new Uint8Array(1), type: 'video/webm' });
    sim.r2Down = true;
    await sim.advanceTo(e.endedAt + RECORDING_RETENTION_MS + 3 * HOUR);
    expect(e.h.store.size).toBeGreaterThan(0);
    sim.r2Down = false;
    await sim.advanceTo(e.endedAt + RECORDING_RETENTION_MS + 5 * HOUR);
    expect(e.h.store.size).toBe(0);
    expect([...sim.r2.keys()].filter((k) => k.startsWith(`events/${e.id}/`))).toEqual([]);
  });
});

describe('EventRoom · guest links (unchanged by C10)', () => {
  afterEach(cleanup);

  it('rotating the guest link refuses the old one; the new one seats an on-air guest', async () => {
    const sim = new Sim();
    const e = await onAir(sim, { kind: 'meeting', access: 'approval' });
    await e.say(e.host, { t: 'guestkey' });
    const k1 = String(e.host.msgs('guestkey').at(-1)!.key);
    const g1 = await sim.open(e.id, `g=${k1}&name=Guest`);
    expect(g1.msgs('hello')[0].you).toMatchObject({ role: 'guest' });
    await e.say(e.host, { t: 'guestkey', rotate: true });
    const k2 = String(e.host.msgs('guestkey').at(-1)!.key);
    expect(k2).not.toBe(k1);
    const old = await sim.open(e.id, `g=${k1}&name=Old link`);
    expect(old.msgs('hello')).toEqual([]);
    expect(old.msgs('pending')).toHaveLength(1); // only the lobby: never on air
    const g2 = await sim.open(e.id, `g=${k2}&name=New link`);
    expect(g2.msgs('hello')[0].you).toMatchObject({ role: 'guest' });
  });
});
