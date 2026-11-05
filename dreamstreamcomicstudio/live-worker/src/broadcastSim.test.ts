// @vitest-environment node
/**
 * Broadcast rail cost sim (feature doc §7 C10). A 1-hour stream with 100 viewers — and the doc's 20-viewer
 * baseline — driven through the real Worker (`index.ts`) and the real EventRoom, with a harness that counts
 * what Cloudflare bills:
 *   - Durable Object requests: every Worker → room fetch (a WebSocket upgrade too), every alarm, and incoming
 *     WebSocket messages at 20:1 (outgoing messages are free);
 *   - SQLite rows written: every key put or deleted, every setAlarm / deleteAlarm.
 *
 * The harness is `eventTestKit.ts`. The BEFORE figures were measured by this same sim at 87082ad (before
 * C10) and are pinned below.
 *
 * It also proves nothing people rely on broke: every viewer gets every segment, in order; a studio reload
 * resumes at the right seq; a forged upload never reaches R2 or a viewer; moderation sticks (deleted
 * messages stay deleted, profanity is never stored); the host's summary adds up; and an ended event holds no
 * R2 and no alarm by day 9, yet stays usable (its links work, it can go live again).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sim, type SimWS, T0 } from './eventTestKit';
import { resetHostPasses } from './index';
import { EMOJI_LIBRARY } from './moderation';
import { clearMemberCache } from './supabaseAuth';

const resetPasses = resetHostPasses;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SEG_MS = 6000;

/** Measured by this sim at 87082ad (before C10): the per-segment `/auth`, a meta row per segment, 3 rows per chat line, a row per reaction. */
export const BEFORE = {
  v100: { doRequests: 1635, rows: 4207 },
  v20: { doRequests: 1403, rows: 1654 },
} as const;

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────────────────────────────────────────── the stream

interface Scenario {
  viewers: number;
  /** An active chat: 6 lines and 12 reactions per viewer-hour. */
  chatPerViewerHour: number;
  emojiPerViewerHour: number;
}

type Step = { at: number; n: number; run: () => Promise<void> };

/**
 * One hour live:
 *   - the studio loads (meta + socket), goes live 10 s in, uploads a 6 s segment every 6 s and reports health
 *     every 30 s; it reloads at 45:00 (socket gone → paused → meta → socket → live) and resumes at meta.latestSeq + 1;
 *   - `viewers` join over the first 10 minutes (meta + socket each); 10 of them reconnect at 30:00;
 *   - chat and reactions at the scenario's rates, 1 line in 50 profane (hidden, a strike);
 *   - the host pins a line, deletes 3, promotes a moderator who deletes 1; a forged upload is tried at 20:00;
 *   - a late viewer joins at 55:00; the host ends at 60:10 and opens the summary.
 */
async function runStream(sc: Scenario) {
  resetPasses();
  clearMemberCache();
  const sim = new Sim();
  const rand = rng(sc.viewers * 7919);

  // Create (a signed-in member), then the studio loads its meta and opens the room socket.
  const created = await sim.worker('/api/events', { method: 'POST', headers: { authorization: 'Bearer member-token-0123456789' }, body: JSON.stringify({ title: 'Launch night', kind: 'broadcast', maxViewers: 200 }) });
  const { id, hostKey } = (await created.json()) as { id: string; hostKey: string };
  await sim.worker(`/api/events/${id}`);
  let host = await sim.open(id, `k=${encodeURIComponent(hostKey)}&name=Host`);

  const steps: Step[] = [];
  let order = 0;
  const at = (t: number, run: () => Promise<void>) => steps.push({ at: T0 + t, n: order++, run });

  const liveAt = 10_000;
  at(liveAt, () => sim.say(id, host, { t: 'state', status: 'live' }));

  // ── segments, uploaded through the Worker (seq continues from meta after the reload)
  const uploaded: { seq: number; at: number }[] = [];
  let nextSeq = 1;
  let reloading = false;
  const segmentBody = (seq: number) => new Uint8Array(1500).fill(seq % 251);
  const upload = async () => {
    if (reloading) return;
    const seq = nextSeq++;
    const res = await sim.worker(`/api/events/${id}/segments?seq=${seq}&ms=${SEG_MS}`, { method: 'POST', headers: { 'content-type': 'video/mp4', 'x-host-key': hostKey }, body: segmentBody(seq) });
    expect(res.status, `segment ${seq}`).toBe(200);
    uploaded.push({ seq, at: sim.now });
  };
  for (let t = liveAt + 2000; t < liveAt + HOUR; t += SEG_MS) at(t, upload);

  // ── health telemetry from the studio
  for (let t = liveAt + 30_000; t < liveAt + HOUR; t += 30_000) at(t, async () => {
    if (!reloading) await sim.say(id, host, { t: 'health', up: 2_400_000, enc: 2_000_000, fail: 0 });
  });

  // ── the studio reloads at 45:00
  let resumedAt = 0;
  at(45 * MIN, async () => {
    reloading = true;
    await sim.leave(id, host);
  });
  at(45 * MIN + 4000, async () => {
    const meta = (await (await sim.worker(`/api/events/${id}`)).json()) as { latestSeq: number; status: string };
    expect(meta.status).toBe('paused');
    // The studio resumes at latestSeq + 1 (StudioView): it must be the last seq it uploaded, or it would overwrite one.
    expect(meta.latestSeq).toBe(uploaded.at(-1)!.seq);
    nextSeq = meta.latestSeq + 1;
    host = await sim.open(id, `k=${encodeURIComponent(hostKey)}&name=Host`);
    await sim.say(id, host, { t: 'state', status: 'live' });
    resumedAt = sim.now;
    reloading = false;
  });

  // ── viewers
  const viewers: { name: string; ws: SimWS | null; joinedAt: number; sockets: SimWS[] }[] = [];
  const join = async (name: string, withMeta = true) => {
    if (withMeta) await sim.worker(`/api/events/${id}`);
    return sim.open(id, `name=${encodeURIComponent(name)}`);
  };
  for (let i = 0; i < sc.viewers; i++) {
    at(15_000 + Math.floor((i * 600_000) / sc.viewers), async () => {
      const v = { name: `Viewer ${i}`, ws: null as SimWS | null, joinedAt: sim.now, sockets: [] as SimWS[] };
      v.ws = await join(v.name);
      v.sockets.push(v.ws);
      viewers.push(v);
    });
  }
  // 10 viewers' networks blip at 30:00: the socket reconnects (no meta fetch).
  at(30 * MIN, async () => {
    for (const v of viewers.slice(0, 10)) await sim.leave(id, v.ws!);
  });
  at(30 * MIN + 5000, async () => {
    for (const v of viewers.slice(0, 10)) {
      v.ws = await join(v.name, false);
      v.sockets.push(v.ws);
    }
  });
  const connected = () => viewers.filter((v) => v.ws && v.ws.closed == null);

  // ── chat (unique lines; 1 in 50 profane) and reactions
  let accepted = 0;
  let hidden = 0;
  const chatTotal = Math.round(sc.chatPerViewerHour * sc.viewers);
  for (let k = 0; k < chatTotal; k++) {
    at(30_000 + Math.floor((k * (HOUR - 60_000)) / chatTotal), async () => {
      const pool = connected();
      if (!pool.length) return;
      const v = pool[Math.floor(rand() * pool.length)];
      const profane = k % 50 === 49;
      const before = v.ws!.msgs('chat').length;
      await sim.say(id, v.ws!, { t: 'chat', text: profane ? `you bastard ${k}` : `line ${k} from ${v.name}` });
      // Accepted lines are broadcast to everyone, the sender included.
      if (v.ws!.msgs('chat').length > before) accepted++;
      else if (profane) hidden++;
    });
  }
  const emojiTotal = Math.round(sc.emojiPerViewerHour * sc.viewers);
  let reactions = 0;
  for (let k = 0; k < emojiTotal; k++) {
    at(20_000 + Math.floor((k * (HOUR - 30_000)) / emojiTotal), async () => {
      const pool = connected();
      if (!pool.length) return;
      const v = pool[Math.floor(rand() * pool.length)];
      await sim.say(id, v.ws!, { t: 'emoji', e: EMOJI_LIBRARY[k % EMOJI_LIBRARY.length] });
      reactions++;
    });
  }

  // ── moderation
  const deleted: string[] = [];
  const lastChatId = () => String((host.msgs('chat').at(-1)?.m as { id: string } | undefined)?.id ?? '');
  at(20 * MIN, () => sim.say(id, host, { t: 'pin', text: 'Q&A at the half hour' }));
  for (const t of [15, 35, 50]) {
    at(t * MIN + 500, async () => {
      const mid = lastChatId();
      deleted.push(mid);
      await sim.say(id, host, { t: 'delete', id: mid });
    });
  }
  let mod: SimWS | null = null;
  at(25 * MIN, async () => {
    const v = viewers[3];
    mod = v.ws;
    await sim.say(id, host, { t: 'promote', sid: (v.ws!.deserializeAttachment() as { sid: string }).sid });
  });
  at(40 * MIN + 500, async () => {
    const mid = lastChatId();
    deleted.push(mid);
    await sim.say(id, mod!, { t: 'delete', id: mid });
  });

  // ── a forged upload (a public event id, a made-up key)
  let forged = { status: 0, r2Before: 0, r2After: 0, notified: false };
  at(20 * MIN + 1000, async () => {
    const r2Before = sim.r2Puts;
    const seen = connected()[0].ws!.msgs('segment').length;
    const res = await sim.worker(`/api/events/${id}/segments?seq=999999&ms=${SEG_MS}`, { method: 'POST', headers: { 'content-type': 'video/mp4', 'x-host-key': 'not-the-key' }, body: new Uint8Array(1500) });
    forged = { status: res.status, r2Before, r2After: sim.r2Puts, notified: connected()[0].ws!.msgs('segment').length !== seen };
  });

  // ── a late viewer at 55:00
  let late: { hello: Record<string, unknown>; lastSeq: number; acceptedSoFar: number } | null = null;
  at(55 * MIN, async () => {
    const ws = await join('Late viewer');
    late = { hello: ws.msgs('hello')[0], lastSeq: uploaded.at(-1)!.seq, acceptedSoFar: accepted };
  });

  // ── the end, and the host's summary
  let summary: Record<string, unknown> | null = null;
  at(liveAt + HOUR + 10_000, async () => {
    await sim.say(id, host, { t: 'state', status: 'ended' });
    summary = (await (await sim.worker(`/api/events/${id}/stats?k=${encodeURIComponent(hostKey)}`)).json()) as Record<string, unknown>;
  });

  steps.sort((a, b) => a.at - b.at || a.n - b.n);
  for (const s of steps) {
    await sim.advanceTo(s.at);
    await s.run();
  }
  return { sim, id, hostKey, host, uploaded, viewers, accepted, hidden, reactions, deleted, forged, late: late!, summary: summary!, resumedAt };
}

type Run = Awaited<ReturnType<typeof runStream>>;

function report(label: string, r: Run, before: { doRequests: number; rows: number }) {
  if (!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SIM_REPORT) return;
  const h = r.sim.room(r.id);
  console.info(
    `${label}: DO requests ${before.doRequests} → ${r.sim.doRequests()} · rows ${before.rows} → ${r.sim.rows()}\n` +
      `  fetches ${JSON.stringify(Object.fromEntries(r.sim.fetches))} · alarms ${r.sim.alarms} · ws in ${r.sim.wsIn} (${Math.ceil(r.sim.wsIn / 20)} billed)\n` +
      `  rows ${JSON.stringify(Object.fromEntries([...h.rowsBy].sort((a, b) => b[1] - a[1])))}\n` +
      `  worker requests ${r.sim.workerRequests} · segments ${r.uploaded.length} · chat ${r.accepted} (+${r.hidden} hidden) · reactions ${r.reactions}`,
  );
}

/** What every viewer relies on, before and after: segments in order, none missed while connected, the summary adds up. */
function expectNothingBroke(r: Run, sc: Scenario) {
  // Every viewer's sockets together saw every segment uploaded while one was open, strictly in order per socket.
  for (const v of r.viewers) {
    for (const ws of v.sockets) {
      const seqs = ws.msgs('segment').map((m) => Number(m.seq));
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1);
    }
    const first = v.sockets[0].msgs('segment')[0];
    const seen = new Set(v.sockets.flatMap((ws) => ws.msgs('segment').map((m) => Number(m.seq))));
    const expected = r.uploaded.filter((u) => u.at > v.joinedAt).map((u) => u.seq);
    const missed = expected.filter((s) => !seen.has(s));
    // Only the 10 who blipped can miss the ≤ 1 segment uploaded while their socket was down (their player fetches it by seq).
    expect(missed.length, `${v.name} missed ${missed.join(',')}`).toBeLessThanOrEqual(v.sockets.length > 1 ? 1 : 0);
    expect(first).toBeDefined();
  }
  // Seqs are contiguous across the studio reload: nothing was overwritten, nothing skipped.
  expect(r.uploaded.map((u) => u.seq)).toEqual(r.uploaded.map((_, i) => i + 1));
  // Playback: a viewer pulls the stream back through the Worker and the edge cache, byte for byte.
  return (async () => {
    for (const { seq } of r.uploaded.filter((_, i) => i % 37 === 0)) {
      const res = await r.sim.worker(`/api/events/${r.id}/segments/${seq}`);
      expect(res.status).toBe(200);
      const body = new Uint8Array(await res.arrayBuffer());
      expect(body.length).toBe(1500);
      expect(body[0]).toBe(seq % 251);
    }
    // The forged upload: refused, nothing stored, nobody told.
    expect(r.forged.status).toBe(403);
    expect(r.forged.r2After).toBe(r.forged.r2Before);
    expect(r.forged.notified).toBe(false);
    expect(r.sim.r2.has(`events/${r.id}/seg/999999`)).toBe(false);
    // A late viewer starts at the live edge and gets the recent chat — never a deleted or a hidden line.
    const meta = r.late.hello.meta as { latestSeq: number; pinned: string };
    expect(meta.latestSeq).toBe(r.late.lastSeq);
    expect(meta.pinned).toBe('Q&A at the half hour');
    const chat = r.late.hello.chat as { id: string; text: string }[];
    expect(chat.length).toBe(Math.min(50, r.late.acceptedSoFar - r.deleted.length));
    for (const id of r.deleted) expect(chat.map((m) => m.id)).not.toContain(id);
    expect(chat.some((m) => /bastard/.test(m.text))).toBe(false);
    // The host's summary adds up.
    const stats = r.summary.stats as { chatTotal: number; emojiTotal: number; peakViewers: number; uniqueViewers: number; curve: unknown[]; healthCurve: unknown[] };
    expect(stats.chatTotal).toBe(r.accepted);
    expect(stats.emojiTotal).toBe(r.reactions);
    expect(stats.peakViewers).toBe(sc.viewers + 1);
    expect(stats.uniqueViewers).toBe(sc.viewers + 1);
    expect(stats.curve.length).toBeGreaterThanOrEqual(110);
    expect(stats.healthCurve.length).toBeGreaterThanOrEqual(110);
    expect((r.summary.meta as { status: string }).status).toBe('ended');
    expect(r.hidden).toBe(Math.floor(sc.chatPerViewerHour * sc.viewers / 50));
  })();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetPasses();
  clearMemberCache();
});

// Each case simulates a whole stream-hour (thousands of segment requests and chat/emoji events) in memory: CPU-bound
// work that takes about a second alone but several on a busy machine (a full suite beside other runs), so the cases
// get their own budget instead of vitest's 5 s default.
const STREAM_HOUR_TIMEOUT_MS = 30_000;

describe('broadcast rail — a 1-hour stream, counted (C10)', () => {
  it('100 viewers: DO requests and rows per stream-hour, before vs after, and nothing people rely on broke', async () => {
    const sc = { viewers: 100, chatPerViewerHour: 6, emojiPerViewerHour: 12 };
    const r = await runStream(sc);
    report('100 viewers', r, BEFORE.v100);
    await expectNothingBroke(r, sc);
    // Rows: ≤ 1,000 per stream-hour, even with an active chat (doc target; it was 4,350).
    expect(r.sim.rows()).toBeLessThanOrEqual(1000);
    // DO requests: the per-segment /auth is gone (one pass per isolate), so the rail is one request a segment.
    expect(r.sim.fetches.get('/auth') ?? 0).toBeLessThanOrEqual(2);
    expect(r.sim.fetches.get('/ingest')).toBe(r.uploaded.length);
    // What remains above the rail is the audience: a meta read + a socket per join, chat and reactions at 20:1.
    const audience = (r.sim.fetches.get('/ws') ?? 0) + (r.sim.fetches.get('/meta') ?? 0) + Math.ceil(r.sim.wsIn / 20);
    const rail = r.sim.doRequests() - audience;
    expect(rail).toBeLessThanOrEqual(800);
    expect(r.sim.doRequests()).toBeLessThan(BEFORE.v100.doRequests * 0.6);
  }, STREAM_HOUR_TIMEOUT_MS);

  it('20 viewers (the doc’s baseline, ≈ 1,371 requests): ≤ 800 DO requests and ≤ 1,000 rows per stream-hour', async () => {
    const sc = { viewers: 20, chatPerViewerHour: 6, emojiPerViewerHour: 12 };
    const r = await runStream(sc);
    report('20 viewers', r, BEFORE.v20);
    await expectNothingBroke(r, sc);
    expect(r.sim.doRequests()).toBeLessThanOrEqual(800);
    expect(r.sim.rows()).toBeLessThanOrEqual(1000);
  }, STREAM_HOUR_TIMEOUT_MS);

  it('an ended event costs nothing to keep by day 9 (no R2, no alarm, a few KB of rows) and stays usable; its usage was written first', async () => {
    const r = await runStream({ viewers: 20, chatPerViewerHour: 6, emojiPerViewerHour: 12 });
    const h = r.sim.room(r.id);
    const endedAt = r.sim.now;
    // Replay stays watchable for 24 h.
    await r.sim.advanceTo(endedAt + DAY - MIN);
    expect((await r.sim.worker(`/api/events/${r.id}/segments/1`)).status).toBe(200);
    r.sim.edge.clear(); // a colo that never cached it
    await r.sim.advanceTo(endedAt + DAY + MIN);
    expect([...r.sim.r2.keys()].some((k) => k.startsWith(`events/${r.id}/seg/`))).toBe(false);
    expect((await r.sim.worker(`/api/events/${r.id}/segments/1`)).status).toBe(404);
    // The event is still there for its recap during the 7 days.
    expect((await r.sim.worker(`/api/events/${r.id}`)).status).toBe(200);
    const pointsBefore = r.sim.points.length;
    const alarmsBefore = r.sim.alarms;
    await r.sim.advanceTo(endedAt + 9 * DAY);
    expect(h.alarmAt).toBeNull();
    expect([...r.sim.r2.keys()].filter((k) => k.startsWith(`events/${r.id}/`))).toEqual([]);
    // The broadcast's usage reached Analytics Engine before the sweep.
    expect(r.sim.points.length).toBeGreaterThanOrEqual(pointsBefore);
    expect(r.sim.points.some((p) => (p as { indexes?: string[] }).indexes?.[0] === 'broadcast')).toBe(true);
    // What is kept: the rows that make the event usable (an ended event can go live again from the same
    // links), a few KB with no alarm — so no request a month from now, however long it is kept.
    const bytes = [...h.store.values()].reduce((n: number, v) => n + JSON.stringify(v).length, 0);
    expect(bytes).toBeLessThan(64 * 1024);
    const alarms = r.sim.alarms;
    await r.sim.advanceTo(endedAt + 40 * DAY);
    expect(r.sim.alarms).toBe(alarms);
    expect(alarms - alarmsBefore).toBeLessThanOrEqual(4); // the 7-day sweep (and a postponed flush) at most
    const invite = await r.sim.worker(`/api/events/${r.id}`);
    expect(invite.status).toBe(200);
    expect(((await invite.json()) as { status: string }).status).toBe('ended');
    const studio = await r.sim.open(r.id, `k=${encodeURIComponent(r.hostKey)}&name=Host`);
    expect(studio.msgs('hello')[0].you).toMatchObject({ role: 'host' });
  }, STREAM_HOUR_TIMEOUT_MS);
});
