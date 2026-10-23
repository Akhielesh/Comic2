/**
 * EventRoom — one Durable Object per live event (Stream Studio).
 *
 * Owns everything that is "the room": stream state (idle/live/paused/ended),
 * chat (ring buffer, logged normally but NEVER part of any recording), emoji
 * reactions, presence/viewer count + a hard host-set viewer cap (≤200), the
 * approval lobby (knock → admit/deny), moderation (promote/kick/delete/pin
 * plus automatic profanity/spam strikes with 5-minute timeouts) and
 * new-segment fan-out to viewers.
 *
 * It is also the event's durable memory and janitor: activity log, viewer
 * curve + host health telemetry, RSVPs, the server-side recording registry —
 * and scheduled cleanup: segments (the 24 h replay window) purge a day after
 * the stream ends, server recordings purge after 7 days, and then the room
 * deletes its own storage (`deleteAll`), so a dead event costs nothing.
 *
 * Uses the WebSocket hibernation API so an idle room costs nothing between
 * messages. All durable facts live in storage; per-socket facts live in
 * attachments, so the room survives eviction mid-event.
 *
 * Frugal while live (feature doc §7 C10) — rows are the meter that grows:
 *   - A segment updates the progress (latestSeq, lastIngestAt, usage) in memory and in the host
 *     socket's attachment (not a storage write, and it survives hibernation); the meta is written
 *     every SEG_SAVE_EVERY segments and at every state change.
 *   - Stats, the chat ring, top chatters and seen names are a working copy in memory, written at
 *     most once a HOT_SAVE_MS riding a write or an event that happens anyway — never per chat line
 *     or reaction. Moderation is never batched: a deleted line is written at once, strikes and
 *     timeouts too. When the room isn't live (it may hibernate any time) every change is written
 *     at once, as before.
 *   - The viewer curve is sampled by the segments themselves (every 30 s); the alarm is only a
 *     LIVE_WATCHDOG_MS watchdog (a stalled or abandoned stream, the hourly usage flush).
 */

import { iceFor, revokeIce, type IceEnv } from './ice';
import { EMOJI_LIBRARY, STRIKE_LIMIT, TIMEOUT_MS, checkSpam, hasProfanity, type SpamState } from './moderation';
import { FLUSH_EVERY_MS, UsageMeter, type Collected, type FlushResult, type UsageSink } from './usageMeter';
import { addUsage, compactUsage, emptyCounters, sanitizeUsage, STREAM_ESTIMATES, subUsage, type UsageDelta } from '../../shared/stream/usage';

export type Role = 'host' | 'mod' | 'guest' | 'viewer' | 'pending';
export type StreamStatus = 'idle' | 'live' | 'paused' | 'ended';
/** How the event started: a private meeting (guests on camera, nothing broadcast until the
 *  host goes live) or a broadcast. A meeting can still go live later — `status` says so. */
export type EventKind = 'meeting' | 'broadcast';

export interface EventMeta {
  id: string;
  title: string;
  /** Display name of the host, shown on the invite page ("Hosted by …"). */
  host: string;
  /** Optional description for the invite page. */
  desc: string;
  /** Cover theme index (0–5) for the invite page gradient. */
  cover: number;
  access: 'open' | 'approval';
  quality: string;
  mime: string;
  segMs: number;
  status: StreamStatus;
  createdAt: number;
  /** Optional scheduled start (epoch ms) — viewers see a countdown until live. */
  scheduledAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  firstSeq: number;
  latestSeq: number;
  /** Wall-clock time the last segment arrived — lets clients judge stream health. */
  lastIngestAt: number | null;
  pinned: string | null;
  /** Viewers must wait this many seconds between chat messages (0 = off). */
  slowSec: number;
  /** Whether emoji reactions are accepted from viewers. */
  reactionsOn: boolean;
  /** The host's one-tap reactions (library emoji, ≤ 6). */
  quick?: string[];
  /** Hard concurrent-viewer cap, host-set, never above HARD_VIEWER_CAP. */
  maxViewers: number;
  /** Meeting or broadcast (rooms created before meetings have none → broadcast). */
  kind?: EventKind;
  /** Private: cumulative broadcast usage (segments), riding the meta write (every SEG_SAVE_EVERY segments). Never public. */
  use?: UsageDelta;
}

export interface ChatMsg {
  id: string;
  sid: string;
  name: string;
  role: Role;
  text: string;
  at: number;
}

export interface LogEntry {
  at: number;
  kind: 'live' | 'scene' | 'join' | 'mod' | 'warn' | 'err' | 'rec' | 'sys';
  tag: string;
  msg: string;
}

export interface RecordingEntry {
  key: string;
  file: string;
  bytes: number;
  mime: string;
  durMs: number;
  at: number;
}

interface Stats {
  peakViewers: number;
  peakAt: number | null;
  chatTotal: number;
  emojiTotal: number;
  uniqueViewers: number;
  /** Viewer-count samples while live (~30 s apart). */
  curve: { at: number; n: number }[];
  /** Chat messages per minute buckets. */
  chatCurve: { at: number; n: number }[];
  /** Host-reported network health: upload bps, encoded bps, upload failures. */
  healthCurve: { at: number; up: number; enc: number; fail: number }[];
  /** Cumulative viewer-minutes and the room's own upkeep (watchdog alarms, rows it writes), riding the stats checkpoint (usageMeter.ts). */
  use?: UsageDelta;
}

/** Where the stream is: what each segment changes. Absolute values (they only grow). */
interface Progress {
  firstSeq: number;
  latestSeq: number;
  lastIngestAt: number | null;
  use?: UsageDelta;
}

interface Attach {
  sid: string;
  name: string;
  role: Role;
  /** The host's socket only: the latest progress, so a room that hibernated between segments loses none of it. */
  p?: Progress;
}

/** The room's working copy while live (feature doc §7 C10): loaded once, written in batches. */
interface HotState {
  stats: Stats;
  chat: ChatMsg[];
  chatters: Record<string, number>;
  seenNames: string[];
}
type HotKey = keyof HotState;
const HOT_DEFAULTS: { [K in HotKey]: () => HotState[K] } = {
  stats: () => emptyStats(),
  chat: () => [],
  chatters: () => ({}),
  seenNames: () => [],
};

interface Env extends IceEnv {
  EVENT_ROOM: DurableObjectNamespace;
  LIVE_BUCKET: R2Bucket;
  ALLOWED_ORIGINS: string;
  /** Workers Analytics Engine (optional): Stream Studio usage points. */
  STREAM_USAGE?: UsageSink;
}

const CHAT_CAP = 200; // ring buffer — chat is logged, never rendered into video
const CHAT_HELLO = 50; // recent messages sent on join
const CHAT_MIN_INTERVAL_MS = 400;
const LOG_CAP = 400;
const CURVE_CAP = 1500; // ~12 h of 30 s samples
export const CURVE_SAMPLE_MS = 30_000;
/** The meta (latestSeq, lastIngestAt, usage) is written every this many segments, and at every state change. */
export const SEG_SAVE_EVERY = 10;
/** While live, the working copy (stats, chat, chatters, seen names) is written at most this often. */
export const HOT_SAVE_MS = 60_000;
/** …or as soon as this many chat lines are unsaved (bounds what an eviction could take from the replay list). */
export const CHAT_SAVE_EVERY = 25;
/** While live the alarm is a watchdog only: segments sample the curve, the watchdog catches a stalled stream. */
export const LIVE_WATCHDOG_MS = 10 * 60_000;
/** A sweep that can't empty R2 retries hourly; past this the room's rows go anyway (R2's lifecycle rule takes the rest). */
export const SWEEP_GRACE_MS = 2 * 24 * 60 * 60_000;
const HEALTH_MIN_INTERVAL_MS = 20_000;
const RSVP_CAP = 500;
const REC_CAP = 20;
/** Platform ceiling — hosts can set any cap up to this, never beyond. */
export const HARD_VIEWER_CAP = 200;
const DEFAULT_VIEWER_CAP = 100;
/** Replay stays watchable this long after the stream ends, then segments purge. */
export const REPLAY_WINDOW_MS = 24 * 60 * 60_000;
/** Server-side recordings are kept this long for the host, then purge. */
export const RECORDING_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Host vanished (tab closed / crashed) → the stream auto-ends after this. */
export const HOST_GONE_GRACE_MS = 2 * 60_000;
/** On-air guest seats (WebRTC mesh to the host — small by design). */
export const MAX_GUESTS = 4;
/** WebRTC offers/answers run a few KB — only `rtc` frames may be this large. */
const RTC_FRAME_MAX = 64 * 1024;
const FRAME_MAX = 4096;
const ALLOWED_EMOJI = new Set<string>(EMOJI_LIBRARY);
const MILESTONES = [10, 25, 50, 100, 250, 500, 1000];

const emptyStats = (): Stats => ({
  peakViewers: 0,
  peakAt: null,
  chatTotal: 0,
  emojiTotal: 0,
  uniqueViewers: 0,
  curve: [],
  chatCurve: [],
  healthCurve: [],
});

/** Segments ingested so far (the progress counter: it only grows). */
const segCount = (u: UsageDelta | undefined): number => sanitizeUsage(u).segCount;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export class EventRoom {
  private lastChatAt = new Map<string, number>(); // best-effort rate limit; resets on hibernation, which is fine
  private spam = new Map<string, SpamState>(); // best-effort repeat detector; same trade-off
  private lastHealthAt = 0;
  /** Stream Studio usage: durable totals (meta/stats) → ≤ 1 `use:YYYY-MM` row an hour + 1 point. */
  private readonly usage: UsageMeter;
  /** The latest segment progress, ahead of the stored meta by `unsaved` segments (memory; rebuilt from the host's attachment). */
  private prog: (Progress & { unsaved: number }) | null = null;
  private progScanned = false;
  /** The working copy and what in it is not written yet. */
  private hot: Partial<HotState> = {};
  private dirty = new Set<HotKey>();
  private unsavedChat = 0;
  private lastCheckpoint = 0;

  constructor(private state: DurableObjectState, private env: Env) {
    this.usage = new UsageMeter({ storage: state.storage, sink: env.STREAM_USAGE, scope: 'event' });
  }

  // ---------------------------------------------------------------- storage

  /** The stored meta with the latest segment progress on top (what every reader should see). */
  private async getMeta(): Promise<EventMeta | undefined> {
    const m = await this.state.storage.get<EventMeta>('meta');
    if (!m) return m;
    const p = this.progress();
    if (p) {
      if (segCount(p.use) > segCount(m.use)) {
        m.firstSeq = m.firstSeq || p.firstSeq;
        m.latestSeq = Math.max(m.latestSeq, p.latestSeq);
        m.lastIngestAt = p.lastIngestAt;
        m.use = p.use;
      } else p.unsaved = 0; // storage already holds it
    }
    return m;
  }

  private async putMeta(m: EventMeta): Promise<void> {
    await this.state.storage.put('meta', m);
    this.progressSaved(m);
  }

  /** Memory first; after hibernation, the newest progress a host socket carries. */
  private progress(): (Progress & { unsaved: number }) | null {
    if (!this.prog && !this.progScanned) {
      this.progScanned = true;
      for (const ws of this.state.getWebSockets()) this.absorb(ws.deserializeAttachment() as Attach | null);
    }
    return this.prog;
  }

  private absorb(a: Attach | null | undefined): void {
    const p = a?.role === 'host' ? a.p : undefined;
    if (!p || !Number.isFinite(p.latestSeq)) return;
    if (!this.prog || segCount(p.use) > segCount(this.prog.use)) {
      // How far it ran ahead of storage isn't known: the next segment writes it.
      this.prog = { firstSeq: p.firstSeq, latestSeq: p.latestSeq, lastIngestAt: p.lastIngestAt, use: p.use, unsaved: SEG_SAVE_EVERY };
    }
  }

  private progressSaved(m: EventMeta): void {
    if (this.prog && segCount(m.use) >= segCount(this.prog.use)) this.prog.unsaved = 0;
  }

  /** Copy the progress into every host socket's attachment (free; survives hibernation). False when no host socket is there. */
  private mirrorProgress(): boolean {
    if (!this.prog) return false;
    const p: Progress = { firstSeq: this.prog.firstSeq, latestSeq: this.prog.latestSeq, lastIngestAt: this.prog.lastIngestAt, use: this.prog.use };
    let any = false;
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a?.role !== 'host') continue;
      a.p = p;
      try {
        ws.serializeAttachment(a);
        any = true;
      } catch { /* on its way out */ }
    }
    return any;
  }

  /** The working copy of one hot key (loaded from storage once). */
  private async hotGet<K extends HotKey>(k: K): Promise<HotState[K]> {
    if (this.hot[k] === undefined) {
      const v = (await this.state.storage.get<HotState[K]>(k)) ?? HOT_DEFAULTS[k]();
      // A concurrent load may have landed (and been changed) meanwhile: keep that copy.
      if (this.hot[k] === undefined) (this.hot as HotState)[k] = v;
    }
    return this.hot[k] as HotState[K];
  }

  private async getStats(): Promise<Stats> {
    const s = await this.hotGet('stats');
    if (!s.healthCurve) s.healthCurve = []; // rooms created before health telemetry
    return s;
  }

  /**
   * The working copy changed. Live: written with the next checkpoint (at most once a HOT_SAVE_MS,
   * or when CHAT_SAVE_EVERY lines are unsaved). Not live (the room may hibernate any time): now.
   */
  private async saveSoon(keys: HotKey[], live?: boolean, now = Date.now()): Promise<void> {
    for (const k of keys) this.dirty.add(k);
    if (!this.dirty.size) return;
    const isLive = live ?? (await this.getMeta())?.status === 'live';
    if (!isLive || now - this.lastCheckpoint >= HOT_SAVE_MS || this.unsavedChat >= CHAT_SAVE_EVERY) await this.checkpoint(now);
  }

  /**
   * One write for everything unsaved: the dirty working copy, plus the meta when given or when the
   * segment progress is ahead of it. Once the event has been on air its rows are broadcast upkeep:
   * the stats ride along and carry the write's own row count (a meeting that never went live
   * counts nothing, as before).
   */
  private async checkpoint(now = Date.now(), meta?: EventMeta): Promise<void> {
    const m = meta ?? (this.prog && this.prog.unsaved > 0 ? await this.getMeta() : undefined);
    if (!this.dirty.size && !m) return;
    const onAir = !!(m ?? (await this.state.storage.get<EventMeta>('meta')))?.startedAt;
    const keys = [...new Set<HotKey>(onAir ? [...this.dirty, 'stats'] : this.dirty)];
    if (onAir) {
      const stats = await this.getStats();
      stats.use = compactUsage(addUsage(sanitizeUsage(stats.use), { rowsWrittenEst: keys.length + (m ? 1 : 0) }));
    }
    const batch: Record<string, unknown> = {};
    for (const k of keys) batch[k] = this.hot[k];
    if (m) batch.meta = m;
    this.dirty.clear();
    const chat = this.unsavedChat;
    this.unsavedChat = 0;
    this.lastCheckpoint = now;
    try {
      await this.state.storage.put(batch);
    } catch (err) {
      for (const k of keys) this.dirty.add(k);
      this.unsavedChat += chat;
      throw err;
    }
    if (m) this.progressSaved(m);
  }

  /** A viewer-curve point; `minutes` adds the viewer-minutes since the last one (not across a pause). */
  private sample(stats: Stats, now: number, minutes: boolean): void {
    const n = this.viewerCount();
    const last = stats.curve[stats.curve.length - 1];
    if (minutes && last && now > last.at) {
      stats.use = compactUsage(addUsage(sanitizeUsage(stats.use), { viewerMinutes: (n * Math.min(now - last.at, LIVE_WATCHDOG_MS)) / 60_000 }));
    }
    stats.curve.push({ at: now, n });
    if (stats.curve.length > CURVE_CAP) stats.curve.splice(0, stats.curve.length - CURVE_CAP);
    this.dirty.add('stats');
  }

  private async sampleIfDue(now: number): Promise<void> {
    const stats = await this.getStats();
    const last = stats.curve[stats.curve.length - 1];
    if (!last || now - last.at >= CURVE_SAMPLE_MS) this.sample(stats, now, true);
  }

  private async publicMeta(full: EventMeta) {
    const { use: _private, ...m } = full;
    const rsvps = (await this.state.storage.get<string[]>('rsvps')) ?? [];
    return {
      ...m,
      maxViewers: m.maxViewers || DEFAULT_VIEWER_CAP,
      viewers: this.viewerCount(),
      rsvpCount: rsvps.length,
      rsvpNames: rsvps.slice(0, 6),
    };
  }

  /** Append to the durable activity log and stream it to host + mods live. */
  private async addLog(kind: LogEntry['kind'], tag: string, msg: string): Promise<void> {
    const entry: LogEntry = { at: Date.now(), kind, tag: tag.slice(0, 8), msg: msg.slice(0, 200) };
    const log = (await this.state.storage.get<LogEntry[]>('log')) ?? [];
    log.push(entry);
    if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
    await this.state.storage.put('log', log);
    this.broadcast({ t: 'log', entry }, (a) => a.role === 'host' || a.role === 'mod');
  }

  // ------------------------------------------------------------------ HTTP

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case '/init':
        return this.handleInit(req);
      case '/meta':
        return this.handleMeta();
      case '/ingest':
        return this.handleIngest(req);
      case '/stats':
        return this.handleStats(url);
      case '/rsvp':
        return this.handleRsvp(req);
      case '/auth':
        return this.handleAuth(req);
      case '/host-exit':
        return this.handleHostExit(req);
      case '/rec/register':
        return this.handleRecRegister(req);
      case '/rec/list':
        return this.handleRecList(req, url);
      case '/ws':
        return this.handleUpgrade(req, url);
      default:
        return json({ error: 'not found' }, 404);
    }
  }

  private async handleInit(req: Request): Promise<Response> {
    if (await this.getMeta()) return json({ error: 'event already exists' }, 409);
    const body = (await req.json()) as Partial<EventMeta>;
    const meta: EventMeta = {
      id: String(body.id ?? ''),
      title: String(body.title ?? 'Untitled stream').slice(0, 120),
      host: String(body.host ?? 'Host').slice(0, 40) || 'Host',
      desc: String(body.desc ?? '').slice(0, 500),
      cover: Math.min(5, Math.max(0, Math.floor(Number(body.cover)) || 0)),
      access: body.access === 'approval' ? 'approval' : 'open',
      quality: String(body.quality ?? '720p'),
      mime: String(body.mime ?? ''),
      segMs: Math.min(12_000, Math.max(2000, Number(body.segMs) || 6000)),
      status: 'idle',
      createdAt: Date.now(),
      scheduledAt:
        Number.isFinite(Number(body.scheduledAt)) && Number(body.scheduledAt) > Date.now()
          ? Number(body.scheduledAt)
          : null,
      startedAt: null,
      endedAt: null,
      firstSeq: 0,
      latestSeq: 0,
      lastIngestAt: null,
      pinned: null,
      slowSec: 0,
      reactionsOn: true,
      maxViewers: Math.min(HARD_VIEWER_CAP, Math.max(1, Math.floor(Number(body.maxViewers)) || DEFAULT_VIEWER_CAP)),
      kind: body.kind === 'meeting' ? 'meeting' : 'broadcast',
    };
    const hostKey = crypto.randomUUID();
    await this.state.storage.put({
      meta,
      hostKey,
      // Stream Studio account that created the event (never exposed in meta).
      ownerId: String((body as { ownerId?: unknown }).ownerId ?? '').slice(0, 64),
      admitted: [] as string[],
      chat: [] as ChatMsg[],
      stats: emptyStats(),
      log: [] as LogEntry[],
      rsvps: [] as string[],
      chatters: {} as Record<string, number>,
      seenNames: [] as string[],
      strikes: {} as Record<string, { n: number; until: number }>,
      recordings: [] as RecordingEntry[],
    });
    await this.addLog(
      'sys',
      'SYS',
      meta.scheduledAt
        ? `Event created · scheduled for ${new Date(meta.scheduledAt).toISOString()}`
        : meta.kind === 'meeting'
          ? 'Meeting started — not broadcasting'
          : 'Event created',
    );
    return json({ hostKey });
  }

  private async handleMeta(): Promise<Response> {
    const meta = await this.getMeta();
    if (!meta) return json({ error: 'not found' }, 404);
    return json(await this.publicMeta(meta));
  }

  /** Cheap host-key check for the worker's recording-upload routes. */
  private async handleAuth(req: Request): Promise<Response> {
    const hostKey = await this.state.storage.get<string>('hostKey');
    if (!hostKey || req.headers.get('x-host-key') !== hostKey) return json({ error: 'forbidden' }, 403);
    return new Response(null, { status: 204 });
  }

  /**
   * Cost guardrail: the host deliberately closed the studio tab (pagehide
   * beacon). End the program NOW instead of waiting out the paused-grace —
   * uploads have stopped, viewers get a clean "ended", storage stops accruing.
   * The event stays restartable: going live again simply clears `endedAt`.
   */
  private async handleHostExit(req: Request): Promise<Response> {
    const hostKey = await this.state.storage.get<string>('hostKey');
    if (!hostKey || req.headers.get('x-host-key') !== hostKey) return json({ error: 'forbidden' }, 403);
    const meta = await this.getMeta();
    if (!meta) return json({ error: 'not found' }, 404);
    if (meta.status === 'live' || meta.status === 'paused') {
      const now = Date.now();
      if (meta.status === 'live') this.sample(await this.getStats(), now, true);
      meta.status = 'ended';
      meta.endedAt = now;
      await this.checkpoint(now, meta);
      await this.state.storage.delete('hostGoneAt');
      this.broadcast({ t: 'state', status: 'ended', startedAt: meta.startedAt, endedAt: meta.endedAt });
      await this.addLog('live', 'END', 'Host closed the studio — stream ended. Reopen your studio link to go live again.');
      await this.state.storage.setAlarm(meta.endedAt + REPLAY_WINDOW_MS);
      await this.meterTick();
    }
    return new Response(null, { status: 204 });
  }

  /** The worker finished a multipart upload to R2 — remember the recording. */
  private async handleRecRegister(req: Request): Promise<Response> {
    const hostKey = await this.state.storage.get<string>('hostKey');
    if (!hostKey || req.headers.get('x-host-key') !== hostKey) return json({ error: 'forbidden' }, 403);
    const body = (await req.json()) as Partial<RecordingEntry>;
    const rec: RecordingEntry = {
      key: String(body.key ?? ''),
      file: String(body.file ?? 'recording').slice(0, 120),
      // What R2 actually stored (the worker passes it), else what the host said.
      bytes: Math.max(0, Number((body as { stored?: unknown }).stored) || Number(body.bytes) || 0),
      mime: String(body.mime ?? 'video/webm').slice(0, 80),
      durMs: Math.max(0, Number(body.durMs) || 0),
      at: Date.now(),
    };
    if (!rec.key) return json({ error: 'bad key' }, 400);
    const recordings = (await this.state.storage.get<RecordingEntry[]>('recordings')) ?? [];
    recordings.push(rec);
    await this.state.storage.put('recordings', recordings.slice(-REC_CAP));
    await this.addLog('rec', 'REC', `Recording stored to the cloud · ${(rec.bytes / 1_048_576).toFixed(0)} MB (kept 7 days)`);
    // Make sure the janitor is armed even if the host never hits "end stream".
    const alarm = await this.state.storage.getAlarm();
    if (alarm == null) await this.state.storage.setAlarm(Date.now() + RECORDING_RETENTION_MS);
    await this.meterTick();
    return json({ ok: true, count: recordings.length });
  }

  private async handleRecList(req: Request, url: URL): Promise<Response> {
    const hostKey = await this.state.storage.get<string>('hostKey');
    if (!hostKey || url.searchParams.get('k') !== hostKey) return json({ error: 'forbidden' }, 403);
    const recordings = (await this.state.storage.get<RecordingEntry[]>('recordings')) ?? [];
    const meta = await this.getMeta();
    const expiresAt = recordings.length
      ? Math.min(...recordings.map((r) => r.at)) + RECORDING_RETENTION_MS
      : meta?.endedAt
        ? meta.endedAt + RECORDING_RETENTION_MS
        : null;
    return json({ recordings, expiresAt });
  }

  /** Host-gated rollup for the post-stream summary screen. */
  private async handleStats(url: URL): Promise<Response> {
    const meta = await this.getMeta();
    if (!meta) return json({ error: 'not found' }, 404);
    const hostKey = await this.state.storage.get<string>('hostKey');
    if (!hostKey || url.searchParams.get('k') !== hostKey) return json({ error: 'forbidden' }, 403);
    // The working copy: live figures include what the next checkpoint will write.
    const [stats, log, chatters, recordings] = await Promise.all([
      this.getStats(),
      this.state.storage.get<LogEntry[]>('log'),
      this.hotGet('chatters'),
      this.state.storage.get<RecordingEntry[]>('recordings'),
    ]);
    const top = Object.entries(chatters ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));
    return json({
      meta: await this.publicMeta(meta),
      stats,
      log: log ?? [],
      topChatters: top,
      recordings: recordings ?? [],
    });
  }

  /** Name-only "save my spot" from the invite page — no account needed. */
  private async handleRsvp(req: Request): Promise<Response> {
    const meta = await this.getMeta();
    if (!meta) return json({ error: 'not found' }, 404);
    const { name } = (await req.json().catch(() => ({}))) as { name?: string };
    const clean = String(name ?? '').trim().slice(0, 24);
    if (!clean) return json({ error: 'name required' }, 400);
    const rsvps = (await this.state.storage.get<string[]>('rsvps')) ?? [];
    if (!rsvps.includes(clean)) {
      rsvps.push(clean);
      await this.state.storage.put('rsvps', rsvps.slice(-RSVP_CAP));
      await this.addLog('join', 'RSVP', `“${clean}” saved a spot`);
    }
    return json({ ok: true, rsvpCount: rsvps.length });
  }

  /**
   * Called by the worker after it stored a segment in R2; broadcasts to viewers. This is the
   * authoritative host-key check for every segment (the Worker's host pass only spares `/auth`).
   * The progress goes to memory and the host's attachment; the meta is written every
   * SEG_SAVE_EVERY segments (always on the first, a new codec, or when no host socket can carry it).
   */
  private async handleIngest(req: Request): Promise<Response> {
    // The body first: from here on only storage is awaited, so two uploads in flight (the studio
    // sends two at a time) can't interleave between reading the progress and moving it on.
    const body = (await req.json().catch(() => null)) as { seq: number; ms: number; at: number; mime?: string; bytes?: number } | null;
    const meta = await this.getMeta();
    if (!meta) return json({ error: 'not found' }, 404);
    const hostKey = await this.state.storage.get<string>('hostKey');
    if (!hostKey || req.headers.get('x-host-key') !== hostKey) return json({ error: 'forbidden' }, 403);

    const { seq, ms, at, mime, bytes } = body ?? ({} as Partial<NonNullable<typeof body>>);
    if (!Number.isFinite(seq) || !seq || seq <= 0) return json({ error: 'bad seq' }, 400);
    const now = Date.now();
    if (meta.status === 'live' && meta.lastIngestAt && now - meta.lastIngestAt > meta.segMs * 3) {
      await this.addLog('warn', 'WARN', `Segment gap of ${((now - meta.lastIngestAt) / 1000).toFixed(1)}s — upload hiccup`);
    }
    let save = !meta.firstSeq;
    if (mime && !meta.mime) {
      meta.mime = mime; // host's recorder decides the codec once
      save = true;
      await this.addLog('sys', 'SYS', `First segment received · ${mime.split(';')[0]}`);
    }
    // No await from here to the progress update: build on the progress as it is NOW — the other
    // upload in flight may have moved it on since this one read the meta.
    const ahead = this.prog && segCount(this.prog.use) > segCount(meta.use) ? this.prog : null;
    meta.firstSeq = meta.firstSeq || ahead?.firstSeq || seq;
    meta.latestSeq = Math.max(meta.latestSeq, ahead?.latestSeq ?? 0, seq);
    meta.lastIngestAt = now;
    // Usage rides the meta (no extra write): the segment stored, its upload, the ingest. Rows are counted when written.
    meta.use = compactUsage(addUsage(sanitizeUsage(ahead ? ahead.use : meta.use), { segBytes: Number(bytes) > 0 ? Number(bytes) : 0, segCount: 1, workerRequestsEst: 1, doRequestsEst: 1 }));
    const unsaved = (this.prog?.unsaved ?? 0) + 1;
    this.prog = { firstSeq: meta.firstSeq, latestSeq: meta.latestSeq, lastIngestAt: now, use: meta.use, unsaved };
    const carried = this.mirrorProgress();
    // The segments sample the viewer curve while live (no 30 s alarm).
    if (meta.status === 'live') await this.sampleIfDue(now);
    if (save || !carried || unsaved >= SEG_SAVE_EVERY || (this.dirty.size > 0 && now - this.lastCheckpoint >= HOT_SAVE_MS)) {
      await this.checkpoint(now, meta);
    }
    this.broadcast({ t: 'segment', seq, ms, at });
    return json({ ok: true });
  }

  // ----------------------------------------------------- alarm (the janitor)

  /**
   * One alarm, four jobs: watch a live stream (stalled or abandoned; the segments sample the curve);
   * end a paused stream whose host never came back; purge segments when the 24 h replay window
   * closes; purge server recordings after 7 days — and then the room's own storage.
   */
  async alarm(): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) return;

    // Host-gone grace expired while paused → end the stream for real.
    if (meta.status === 'paused') {
      const goneAt = await this.state.storage.get<number>('hostGoneAt');
      if (goneAt != null && !this.hostConnected() && Date.now() >= goneAt + HOST_GONE_GRACE_MS) {
        await this.state.storage.delete('hostGoneAt');
        meta.status = 'ended';
        meta.endedAt = Date.now();
        await this.checkpoint(meta.endedAt, meta);
        this.broadcast({ t: 'state', status: 'ended', startedAt: meta.startedAt, endedAt: meta.endedAt });
        await this.addLog('live', 'END', 'Auto-ended — the host did not return. Replay stays up for 24 h.');
        await this.state.storage.setAlarm(meta.endedAt + REPLAY_WINDOW_MS);
        await this.meterTick();
      }
      return;
    }

    if (meta.status === 'live') {
      const now = Date.now();
      const stats = await this.getStats();
      // Abandoned room (host vanished without ending): auto-end after 2 h of
      // silence so viewers see "ended" and the retention janitor takes over.
      if (meta.lastIngestAt && now - meta.lastIngestAt > 2 * 60 * 60_000) {
        this.sample(stats, now, true);
        meta.status = 'ended';
        meta.endedAt = meta.lastIngestAt;
        await this.checkpoint(now, meta);
        this.broadcast({ t: 'state', status: 'ended', startedAt: meta.startedAt, endedAt: meta.endedAt });
        await this.addLog('warn', 'WARN', 'Stream auto-ended after 2 h without segments');
        await this.state.storage.setAlarm(meta.endedAt + REPLAY_WINDOW_MS);
        await this.meterTick();
        return;
      }
      // The watchdog: a stalled stream still gets a curve point; this alarm's own upkeep (1 request,
      // 1 setAlarm row) rides the same checkpoint, which also writes anything unsaved.
      await this.sampleIfDue(now);
      stats.use = compactUsage(addUsage(sanitizeUsage(stats.use), { doRequestsEst: 1, rowsWrittenEst: 1 }));
      this.dirty.add('stats');
      await this.checkpoint(now);
      await this.state.storage.setAlarm(now + LIVE_WATCHDOG_MS);
      await this.meterTick(now);
      return;
    }

    if (meta.status !== 'ended' || !meta.endedAt) return;
    // A usage flush put off at the end (inside the hour) happens here at the latest — before any purge.
    const flushed = await this.meterTick();
    const now = Date.now();
    const segPurgeAt = meta.endedAt + REPLAY_WINDOW_MS;
    const recPurgeAt = meta.endedAt + RECORDING_RETENTION_MS;

    if (now >= recPurgeAt) return this.sweep(meta, now, flushed);
    if (now >= segPurgeAt) {
      try {
        await this.deletePrefix(`events/${meta.id}/seg/`);
      } catch (err) {
        // R2 hiccup: try again in an hour (an alarm that kept throwing would never arm the 7-day sweep).
        console.warn('event janitor: segment purge failed, retrying in 1 h', err instanceof Error ? err.message : err);
        await this.state.storage.setAlarm(Math.min(now + 60 * 60_000, recPurgeAt));
        return;
      }
      await this.addLog('sys', 'SYS', 'Replay window closed — segments purged after 24 h');
      await this.state.storage.setAlarm(recPurgeAt);
      return;
    }
    await this.state.storage.setAlarm(segPurgeAt);
  }

  /**
   * The 7-day sweep: the event's R2 objects (recordings, any segment left), then every row and the
   * alarm — a dead event's room keeps nothing (C10: storage 0 by day 9). Its usage is written
   * first: a flush that is held back by the hourly bound postpones the sweep until it can run, so
   * nothing is lost. R2 that can't be emptied retries hourly; past SWEEP_GRACE_MS the rows go
   * anyway and R2's lifecycle rule (`events/` after 9 days) takes what's left.
   */
  private async sweep(meta: EventMeta, now: number, flushed: FlushResult): Promise<void> {
    const late = now >= (meta.endedAt ?? now) + RECORDING_RETENTION_MS + SWEEP_GRACE_MS;
    if (!late && (flushed === 'too_soon' || flushed === 'error')) {
      await this.state.storage.setAlarm(now + (flushed === 'too_soon' ? FLUSH_EVERY_MS : 60 * 60_000));
      return;
    }
    try {
      await this.deletePrefix(`events/${meta.id}/`);
    } catch (err) {
      if (!late) {
        console.warn('event sweep: R2 purge failed, retrying in 1 h', err instanceof Error ? err.message : err);
        await this.state.storage.setAlarm(now + 60 * 60_000);
        return;
      }
    }
    // Nobody can do anything in a dead event; a socket left open would only write rows back.
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.close(1000, 'event expired');
      } catch { /* already closed */ }
    }
    // compatibility_date 2026-01-01: deleteAll() doesn't take the alarm with it (that came 2026-02-24).
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
    this.hot = {};
    this.dirty.clear();
    this.prog = null;
    this.progScanned = true;
  }

  // ---------------------------------------------------------------- usage

  /**
   * Write the event's usage (≤ 1 row an hour): what its durable totals gained since the watermark
   * kept in the usage row. A flush put off now loses nothing — the next one (at the latest the
   * replay janitor) counts it. Broadcast counts against the event and its owner's account.
   * Anything still in memory is written first, so the watermark never runs ahead of storage.
   */
  private async meterTick(now = Date.now()): Promise<FlushResult> {
    if (!this.usage.due(now)) return 'too_soon';
    const meta = await this.getMeta();
    if (!meta) return 'no_scope';
    await this.checkpoint(now);
    const [stats, recordings, ownerId] = await Promise.all([
      this.getStats(),
      this.state.storage.get<RecordingEntry[]>('recordings'),
      this.state.storage.get<string>('ownerId'),
    ]);
    return this.usage.flush(now, { scopeId: meta.id, account: ownerId || '', collect: eventUsage(meta, stats, recordings ?? []) });
  }

  private async deletePrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.env.LIVE_BUCKET.list({ prefix, cursor, limit: 500 });
      if (page.objects.length > 0) await this.env.LIVE_BUCKET.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  // ------------------------------------------------------------- WebSocket

  private async handleUpgrade(req: Request, url: URL): Promise<Response> {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'expected websocket' }, 426);
    }
    const meta = await this.getMeta();
    if (!meta) return json({ error: 'not found' }, 404);

    const name = (url.searchParams.get('name') || 'guest').slice(0, 24);
    const key = url.searchParams.get('k');
    const guestKeyParam = url.searchParams.get('g');
    const token = url.searchParams.get('token');
    const hostKey = await this.state.storage.get<string>('hostKey');
    const guestKey = await this.state.storage.get<string>('guestKey');
    const admitted = (await this.state.storage.get<string[]>('admitted')) ?? [];

    let role: Role;
    if (key && key === hostKey) role = 'host';
    else if (guestKeyParam && guestKey && guestKeyParam === guestKey) role = 'guest';
    else if (meta.access === 'open' || (token && admitted.includes(token))) role = 'viewer';
    else role = 'pending';

    const pair = new WebSocketPair();
    const server = pair[1];

    // Hard capacity gates — viewers never exceed the host's cap, and the
    // guest mesh stays small enough for a browser to mix.
    const cap = meta.maxViewers || DEFAULT_VIEWER_CAP;
    if (role === 'guest' && this.guestCount() >= MAX_GUESTS) {
      server.accept();
      try {
        server.send(JSON.stringify({ t: 'full', max: MAX_GUESTS }));
        server.close(4003, 'full');
      } catch { /* socket on its way out */ }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (role !== 'host' && role !== 'guest' && this.viewerCount() >= cap) {
      server.accept();
      try {
        server.send(JSON.stringify({ t: 'full', max: cap }));
        server.close(4003, 'full');
      } catch { /* socket on its way out */ }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    this.state.acceptWebSocket(server);
    const attach: Attach = { sid: crypto.randomUUID().slice(0, 8), name, role };
    server.serializeAttachment(attach);
    const live = meta.status === 'live';

    if (role === 'host') {
      this.progress(); // after a wake: what the other host sockets carry
      this.mirrorProgress(); // a (re)connected host carries the progress from now on
      const goneAt = await this.state.storage.get<number>('hostGoneAt');
      if (goneAt != null) {
        await this.state.storage.delete('hostGoneAt');
        await this.addLog('sys', 'SYS', 'Host reconnected');
      }
    }

    if (role === 'pending') {
      this.send(server, { t: 'pending' });
      this.lobbySync();
    } else {
      await this.sendHello(server, attach);
      await this.trackViewerJoin(attach, live);
      await this.broadcastViewers(live);
      this.peopleSync();
      if (role === 'guest') {
        this.broadcast({ t: 'guest', sid: attach.sid, name: attach.name, on: true }, (a) => a.role === 'host' || a.role === 'mod');
        await this.addLog('join', 'GUEST', `“${attach.name}” joined as an on-air guest`);
      }
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > RTC_FRAME_MAX) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // Only WebRTC signaling (SDP bodies) may use the large frame budget.
    if (msg.t !== 'rtc' && raw.length > FRAME_MAX) return;
    const me = ws.deserializeAttachment() as Attach | null;
    if (!me) return;
    // A swept (dead) event: nothing a socket says may write rows back.
    if (!(await this.state.storage.get('meta'))) return;

    switch (msg.t) {
      case 'chat':
        return this.onChat(ws, me, String(msg.text ?? ''));
      case 'emoji':
        return this.onEmoji(me, String(msg.e ?? ''));
      case 'rtc':
        return this.onRtc(me, msg);
      case 'guestkey':
        return this.onGuestKey(ws, me, Boolean(msg.rotate));
      case 'ice':
        return this.onIce(ws, me);
      case 'state':
        return this.onState(me, String(msg.status ?? ''));
      case 'config':
        return this.onConfig(me, msg);
      case 'health':
        return this.onHealth(me, msg);
      case 'log':
        return this.onHostLog(me, msg);
      case 'admit':
      case 'deny':
      case 'kick':
      case 'promote':
        return this.onModeration(me, msg.t, String(msg.sid ?? ''));
      case 'pin':
        return this.onPin(me, msg.text == null ? null : String(msg.text));
      case 'delete':
        return this.onDelete(me, String(msg.id ?? ''));
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const me = ws.deserializeAttachment() as Attach | null;
    if (!(await this.state.storage.get('meta'))) return; // a swept event: write nothing back
    // The host's socket may carry progress this room no longer has in memory (it hibernated):
    // take it, and hand it to any host socket that stays.
    if (me?.role === 'host') {
      this.absorb(me);
      this.mirrorProgress();
    }
    await this.broadcastViewers();
    if (me?.role === 'pending') this.lobbySync();
    else this.peopleSync();

    if (me?.role === 'guest') {
      this.broadcast({ t: 'guest', sid: me.sid, name: me.name, on: false }, (a) => a.role === 'host' || a.role === 'mod');
      await this.addLog('join', 'GUEST', `“${me.name}” left the on-air guests`);
    }

    // Guardrail: the host's tab closed / crashed while on the air. Pause the
    // program immediately (viewers see the BRB slate, uploads have stopped
    // anyway) and auto-end after a short grace window unless they return —
    // no zombie "live" rooms burning storage or stranding viewers.
    if (me?.role === 'host' && !this.hostConnected()) {
      const meta = await this.getMeta();
      const now = Date.now();
      if (meta && meta.status === 'live') {
        this.sample(await this.getStats(), now, true);
        meta.status = 'paused';
        // The progress and the working copy are written now: no socket carries them any more.
        await this.checkpoint(now, meta);
        this.broadcast({ t: 'state', status: 'paused', startedAt: meta.startedAt, endedAt: meta.endedAt });
        await this.state.storage.put('hostGoneAt', now);
        await this.addLog('warn', 'WARN', `Host disconnected — paused; auto-end in ${HOST_GONE_GRACE_MS / 60_000} min unless they return`);
        await this.state.storage.setAlarm(now + HOST_GONE_GRACE_MS);
      } else if (meta) {
        await this.checkpoint(now); // whatever segment progress only the host's socket carried
      }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error');
    } catch {
      /* already closed */
    }
  }

  // -------------------------------------------------------------- handlers

  private async onChat(ws: WebSocket, me: Attach, text: string): Promise<void> {
    if (me.role === 'pending') return;
    const clean = text.trim().slice(0, 500);
    if (!clean) return;
    const meta = await this.getMeta();
    if (!meta) return;
    const now = Date.now();

    // Automatic moderation (viewers only — the crew moderates itself).
    if (me.role === 'viewer') {
      const strikes = (await this.state.storage.get<Record<string, { n: number; until: number }>>('strikes')) ?? {};
      const mine = strikes[me.name] ?? { n: 0, until: 0 };
      if (mine.until > now) {
        this.send(ws, { t: 'notice', text: `You're timed out for ${Math.ceil((mine.until - now) / 1000)}s.` });
        return;
      }
      const profane = hasProfanity(clean);
      const { spam, next } = checkSpam(this.spam.get(me.sid), clean, now);
      this.spam.set(me.sid, next);
      if (profane || spam) {
        mine.n += 1;
        const reason = profane ? 'profanity' : 'spam';
        if (mine.n >= STRIKE_LIMIT) {
          mine.until = now + TIMEOUT_MS;
          mine.n = 0;
          this.send(ws, { t: 'notice', text: `You've been timed out for ${TIMEOUT_MS / 60_000} minutes (${reason}).` });
          await this.addLog('mod', 'MOD', `Auto-timeout for “${me.name}” · ${reason} · ${TIMEOUT_MS / 60_000} min`);
        } else {
          this.send(ws, { t: 'notice', text: profane ? 'Message hidden — keep it friendly.' : 'Message hidden — no need to repeat yourself.' });
          await this.addLog('mod', 'MOD', `Hid a message from “${me.name}” · ${reason} (strike ${mine.n}/${STRIKE_LIMIT})`);
        }
        strikes[me.name] = mine;
        await this.state.storage.put('strikes', strikes);
        return; // never broadcast
      }
    }

    const minGap = me.role === 'viewer' && meta.slowSec > 0 ? meta.slowSec * 1000 : CHAT_MIN_INTERVAL_MS;
    if (now - (this.lastChatAt.get(me.sid) ?? 0) < minGap) return;
    this.lastChatAt.set(me.sid, now);

    const m: ChatMsg = {
      id: crypto.randomUUID().slice(0, 12),
      sid: me.sid,
      name: me.name,
      role: me.role,
      text: clean,
      at: now,
    };
    const [chat, stats, chatters] = await Promise.all([this.hotGet('chat'), this.getStats(), this.hotGet('chatters')]);
    chat.push(m);
    if (chat.length > CHAT_CAP) chat.splice(0, chat.length - CHAT_CAP);
    stats.chatTotal += 1;
    const bucket = Math.floor(now / 60_000) * 60_000;
    const last = stats.chatCurve[stats.chatCurve.length - 1];
    if (last && last.at === bucket) last.n += 1;
    else {
      stats.chatCurve.push({ at: bucket, n: 1 });
      if (stats.chatCurve.length > CURVE_CAP) stats.chatCurve.splice(0, stats.chatCurve.length - CURVE_CAP);
    }
    if (Object.keys(chatters).length < 200 || chatters[me.name] != null) {
      chatters[me.name] = (chatters[me.name] ?? 0) + 1;
    }
    // Live: the line is in the working copy (a joiner's hello has it) and is written with the next
    // checkpoint — not 3 rows per line. Hidden lines never get here; deletes are written at once.
    this.unsavedChat += 1;
    await this.saveSoon(['chat', 'stats', 'chatters'], meta.status === 'live', now);
    this.broadcast({ t: 'chat', m });
  }

  private async onEmoji(me: Attach, e: string): Promise<void> {
    if (me.role === 'pending' || !ALLOWED_EMOJI.has(e)) return;
    const meta = await this.getMeta();
    if (!meta) return;
    if (!meta.reactionsOn && me.role === 'viewer') return;
    const stats = await this.getStats();
    stats.emojiTotal += 1;
    await this.saveSoon(['stats'], meta.status === 'live'); // live: a count in memory, no row per reaction
    this.broadcast({ t: 'emoji', e, name: me.name });
  }

  private async onState(me: Attach, status: string): Promise<void> {
    if (me.role !== 'host') return;
    if (status !== 'live' && status !== 'paused' && status !== 'ended') return;
    const meta = await this.getMeta();
    if (!meta) return;
    const prev = meta.status;
    const now = Date.now();
    meta.status = status;
    // A restart after an end is a NEW session: reset the clock, or every
    // viewer/recap shows the dead gap as elapsed airtime.
    if (status === 'live' && (!meta.startedAt || prev === 'ended')) meta.startedAt = now;
    if (status === 'live') {
      meta.endedAt = null; // restarting after an (auto-)end — not over anymore
      await this.state.storage.delete('hostGoneAt');
    }
    if (status === 'ended') meta.endedAt = now;
    // The curve: a closing point leaving the air (counts the minutes up to it), an opening one coming
    // back (a pause is never counted as watched).
    if (prev === 'live' && status !== 'live') this.sample(await this.getStats(), now, true);
    if (status === 'live' && prev !== 'live') this.sample(await this.getStats(), now, false);
    await this.checkpoint(now, meta); // the meta, the progress and everything unsaved: one write
    this.broadcast({ t: 'state', status, startedAt: meta.startedAt, endedAt: meta.endedAt });

    if (status === 'live' && prev !== 'live') {
      await this.addLog('live', 'LIVE', prev === 'paused' ? 'Resumed — back on the air' : `Stream started · ${meta.quality}`);
      await this.state.storage.setAlarm(now + LIVE_WATCHDOG_MS);
    } else if (status === 'paused') {
      await this.addLog('scene', 'SCENE', 'Cut to “Be right back” slate');
    } else if (status === 'ended') {
      await this.addLog(
        'live',
        'END',
        prev === 'idle' && meta.kind === 'meeting'
          ? 'Meeting ended by host — it was never broadcast'
          : 'Stream ended by host — replay stays up for 24 h, recordings for 7 days',
      );
      await this.state.storage.setAlarm(meta.endedAt! + REPLAY_WINDOW_MS);
      await this.meterTick();
    }
  }

  /** Host adjusts room behavior mid-stream: slow mode, reactions, viewer cap. */
  private async onConfig(me: Attach, msg: Record<string, unknown>): Promise<void> {
    if (me.role !== 'host') return;
    const meta = await this.getMeta();
    if (!meta) return;
    if (msg.slow != null) meta.slowSec = Math.min(120, Math.max(0, Math.floor(Number(msg.slow)) || 0));
    if (msg.reactions != null) meta.reactionsOn = Boolean(msg.reactions);
    if (Array.isArray(msg.quick)) {
      const q = [...new Set(msg.quick.filter((e): e is string => typeof e === 'string' && ALLOWED_EMOJI.has(e)))].slice(0, 6);
      if (q.length) meta.quick = q;
    }
    if (msg.maxViewers != null) {
      meta.maxViewers = Math.min(HARD_VIEWER_CAP, Math.max(1, Math.floor(Number(msg.maxViewers)) || DEFAULT_VIEWER_CAP));
    }
    await this.putMeta(meta);
    this.broadcast({ t: 'config', slow: meta.slowSec, reactions: meta.reactionsOn, maxViewers: meta.maxViewers, quick: meta.quick });
  }

  /** The studio reports encoder/network telemetry ~every 30 s while live. */
  private async onHealth(me: Attach, msg: Record<string, unknown>): Promise<void> {
    if (me.role !== 'host') return;
    const now = Date.now();
    if (now - this.lastHealthAt < HEALTH_MIN_INTERVAL_MS) return;
    this.lastHealthAt = now;
    const stats = await this.getStats();
    stats.healthCurve.push({
      at: now,
      up: Math.max(0, Math.round(Number(msg.up) || 0)),
      enc: Math.max(0, Math.round(Number(msg.enc) || 0)),
      fail: Math.max(0, Math.floor(Number(msg.fail) || 0)),
    });
    if (stats.healthCurve.length > CURVE_CAP) stats.healthCurve.splice(0, stats.healthCurve.length - CURVE_CAP);
    await this.saveSoon(['stats'], undefined, now);
  }

  /** The studio reports client-side production events (scene cuts, recording)
   *  so the durable activity log tells the whole story of the stream. */
  private async onHostLog(me: Attach, msg: Record<string, unknown>): Promise<void> {
    if (me.role !== 'host' && me.role !== 'mod') return;
    const kinds: LogEntry['kind'][] = ['live', 'scene', 'join', 'mod', 'warn', 'err', 'rec', 'sys'];
    const kind = kinds.includes(msg.kind as LogEntry['kind']) ? (msg.kind as LogEntry['kind']) : 'sys';
    await this.addLog(kind, String(msg.tag ?? 'SYS'), String(msg.msg ?? '').slice(0, 200));
  }

  private async onModeration(me: Attach, action: string, sid: string): Promise<void> {
    const canModerate = me.role === 'host' || me.role === 'mod';
    if (!canModerate) return;
    if (action === 'promote' && me.role !== 'host') return;

    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (!a || a.sid !== sid) continue;
      if (a.role === 'host') return; // nobody moderates the host

      if (action === 'admit' && a.role === 'pending') {
        const meta = await this.getMeta();
        const cap = meta?.maxViewers || DEFAULT_VIEWER_CAP;
        if (this.viewerCount() >= cap) {
          await this.addLog('warn', 'WARN', `Could not admit “${a.name}” — room is at its ${cap}-viewer cap`);
          return;
        }
        const token = crypto.randomUUID();
        const admitted = (await this.state.storage.get<string[]>('admitted')) ?? [];
        admitted.push(token);
        await this.state.storage.put('admitted', admitted.slice(-500));
        a.role = 'viewer';
        ws.serializeAttachment(a);
        this.send(ws, { t: 'admitted', token });
        await this.sendHello(ws, a);
        await this.trackViewerJoin(a);
        await this.broadcastViewers();
        this.lobbySync();
        this.peopleSync();
        await this.addLog('join', 'JOIN', `Admitted “${a.name}” from the lobby`);
      } else if (action === 'deny' && a.role === 'pending') {
        this.send(ws, { t: 'denied' });
        try {
          ws.close(4001, 'denied');
        } catch { /* closed */ }
        this.lobbySync();
        await this.addLog('mod', 'MOD', `Denied entry to “${a.name}”`);
      } else if (action === 'kick') {
        this.send(ws, { t: 'kicked' });
        try {
          ws.close(4002, 'kicked');
        } catch { /* closed */ }
        // A removed on-air guest's relay credential stops working now, not when it would lapse.
        if (a.role === 'guest') {
          const meta = await this.getMeta();
          if (meta) await revokeIce(this.env, `e:${meta.id}`, (w) => w === a.sid).catch(() => 0);
        }
        await this.broadcastViewers();
        this.peopleSync();
        await this.addLog('mod', 'MOD', `Removed “${a.name}” from the stream`);
      } else if (action === 'promote' && a.role === 'viewer') {
        a.role = 'mod';
        ws.serializeAttachment(a);
        this.send(ws, { t: 'role', role: 'mod' });
        this.lobbySync();
        this.peopleSync();
        await this.addLog('mod', 'MOD', `Promoted “${a.name}” to moderator`);
      }
      return;
    }
  }

  /**
   * WebRTC signaling relay for on-air guests. The mesh is host-centric:
   * guests only ever talk to the host, the host addresses one guest at a
   * time — the room never inspects SDP, it just routes envelopes.
   */
  private onRtc(me: Attach, msg: Record<string, unknown>): void {
    const d = msg.d;
    if (d == null || typeof d !== 'object') return;
    if (me.role === 'guest') {
      this.broadcast({ t: 'rtc', from: me.sid, d }, (a) => a.role === 'host');
      return;
    }
    if (me.role !== 'host') return;
    const to = String(msg.to ?? '');
    if (!to) return;
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a?.sid === to && a.role === 'guest') {
        this.send(ws, { t: 'rtc', from: me.sid, d });
        return;
      }
    }
  }

  /** Host fetches (or rotates) the guest invite key — the `g` IS the seat pass. */
  private async onGuestKey(ws: WebSocket, me: Attach, rotate: boolean): Promise<void> {
    if (me.role !== 'host') return;
    let key = await this.state.storage.get<string>('guestKey');
    if (!key || rotate) {
      key = crypto.randomUUID();
      await this.state.storage.put('guestKey', key);
      if (rotate) await this.addLog('mod', 'MOD', 'Guest invite link rotated — old links no longer work');
    }
    this.send(ws, { t: 'guestkey', key });
  }

  /**
   * ICE servers for the host ⇄ guest links: STUN always, plus a short-lived Cloudflare TURN
   * credential of this event's own for the asker when the owner configured TURN (./ice):
   * the host ≤ 4 h, each guest ≤ 2 h, counted against the event, and `iceMs` says when to
   * ask again. Only the crew that opens peer links may ask — viewers never touch WebRTC.
   */
  private async onIce(ws: WebSocket, me: Attach): Promise<void> {
    if (me.role !== 'host' && me.role !== 'guest') return;
    const meta = await this.getMeta();
    if (!meta) return;
    const g = await iceFor(this.env, { room: `e:${meta.id}`, who: me.role === 'host' ? 'host' : me.sid, bill: { scope: 'event', id: meta.id }, guest: me.role === 'guest' });
    this.send(ws, { t: 'ice', servers: g.servers, ...(g.iceMs != null ? { iceMs: g.iceMs } : {}) });
  }

  private async onPin(me: Attach, text: string | null): Promise<void> {
    if (me.role !== 'host' && me.role !== 'mod') return;
    const meta = await this.getMeta();
    if (!meta) return;
    meta.pinned = text ? text.slice(0, 200) : null;
    await this.putMeta(meta);
    this.broadcast({ t: 'pin', text: meta.pinned });
  }

  /** Moderation is never batched: the line is gone from storage before anyone is told. */
  private async onDelete(me: Attach, id: string): Promise<void> {
    if (me.role !== 'host' && me.role !== 'mod') return;
    const chat = await this.hotGet('chat');
    const at = chat.findIndex((m) => m.id === id);
    if (at >= 0) {
      chat.splice(at, 1);
      this.dirty.add('chat');
      await this.checkpoint();
      this.broadcast({ t: 'delete', id });
    }
  }

  // --------------------------------------------------------------- helpers

  private async sendHello(ws: WebSocket, me: Attach): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) return;
    const chat = await this.hotGet('chat');
    const isCrew = me.role === 'host' || me.role === 'mod';
    const log = isCrew ? ((await this.state.storage.get<LogEntry[]>('log')) ?? []).slice(-100) : undefined;
    this.send(ws, {
      t: 'hello',
      meta: await this.publicMeta(meta),
      you: { sid: me.sid, role: me.role, name: me.name },
      chat: chat.slice(-CHAT_HELLO),
      log,
    });
    if (isCrew) {
      this.lobbySync();
      this.peopleSync();
    }
  }

  /** Track unique viewers + peak, and announce milestone crossings. Live: in the working copy. */
  private async trackViewerJoin(a: Attach, live?: boolean): Promise<void> {
    if (a.role === 'host' || a.role === 'guest') return; // crew aren't audience
    const [stats, seen] = await Promise.all([this.getStats(), this.hotGet('seenNames')]);
    const changed: HotKey[] = [];
    if (!seen.includes(a.name) && seen.length < 2000) {
      seen.push(a.name);
      stats.uniqueViewers = seen.length;
      changed.push('seenNames', 'stats');
    }
    const n = this.viewerCount();
    let crossed: number | null = null;
    if (n > stats.peakViewers) {
      for (const m of MILESTONES) {
        if (stats.peakViewers < m && n >= m) crossed = m;
      }
      stats.peakViewers = n;
      stats.peakAt = Date.now();
      changed.push('stats');
    }
    await this.saveSoon(changed, live);
    if (crossed != null) {
      this.broadcast({ t: 'milestone', n: crossed });
      await this.addLog('join', 'JOIN', `${crossed} viewers — new peak this session`);
    }
  }

  private hostConnected(): boolean {
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a?.role === 'host') return true;
    }
    return false;
  }

  private viewerCount(): number {
    let n = 0;
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a && a.role !== 'pending' && a.role !== 'host' && a.role !== 'guest') n++;
    }
    return n;
  }

  private guestCount(): number {
    let n = 0;
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a?.role === 'guest') n++;
    }
    return n;
  }

  private async broadcastViewers(live?: boolean): Promise<void> {
    const n = this.viewerCount();
    this.broadcast({ t: 'viewers', n });
    // Keep peak honest on rejoins too (joins go through trackViewerJoin).
    const stats = await this.getStats();
    if (n > stats.peakViewers) {
      stats.peakViewers = n;
      stats.peakAt = Date.now();
      await this.saveSoon(['stats'], live);
    }
  }

  private lobbySync(): void {
    const pending: { sid: string; name: string }[] = [];
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a?.role === 'pending') pending.push({ sid: a.sid, name: a.name });
    }
    this.broadcast({ t: 'lobby', pending }, (a) => a.role === 'host' || a.role === 'mod');
  }

  /** Who's in the room (viewers + mods) — host/mod only, capped. */
  private peopleSync(): void {
    const list: { sid: string; name: string; role: Role }[] = [];
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a && a.role !== 'pending' && a.role !== 'host' && list.length < 200) {
        list.push({ sid: a.sid, name: a.name, role: a.role });
      }
    }
    this.broadcast({ t: 'people', list }, (a) => a.role === 'host' || a.role === 'mod');
  }

  private broadcast(obj: unknown, filter?: (a: Attach) => boolean): void {
    const payload = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (!a || (filter && !filter(a))) continue;
      try {
        ws.send(payload);
      } catch { /* socket on its way out */ }
    }
  }

  private send(ws: WebSocket, obj: unknown): void {
    try {
      ws.send(JSON.stringify(obj));
    } catch { /* socket on its way out */ }
  }
}

/**
 * The event's usage since a watermark: broadcast totals (meta.use + stats.use are cumulative) and
 * recordings registered after the last one counted (the 7-day cloud copies). Pure.
 */
export function eventUsage(meta: Pick<EventMeta, 'use'>, stats: { use?: UsageDelta }, recordings: RecordingEntry[]): (prev: unknown) => Collected {
  return (prev) => {
    const p = (prev && typeof prev === 'object' ? prev : {}) as { seg?: UsageDelta; live?: UsageDelta; recAt?: number };
    const broadcast = addUsage(subUsage(sanitizeUsage(meta.use), sanitizeUsage(p.seg)), subUsage(sanitizeUsage(stats.use), sanitizeUsage(p.live)));
    let cloud = emptyCounters();
    const since = Number(p.recAt) || 0;
    let recAt = since;
    for (const r of recordings) {
      if (!(r.at > since)) continue;
      const parts = Math.ceil(r.bytes / STREAM_ESTIMATES.cloudCopyPartBytes);
      // Per recording: init + parts + complete through the Worker (each host-key checked here), and its row writes.
      cloud = addUsage(cloud, { cloudCopyBytes: r.bytes, workerRequestsEst: parts + 2, doRequestsEst: parts + 3, rowsWrittenEst: 2 });
      recAt = Math.max(recAt, r.at);
    }
    return { delta: { broadcast: compactUsage(broadcast), cloud_copy: compactUsage(cloud) }, src: { seg: meta.use ?? {}, live: stats.use ?? {}, recAt } };
  };
}
