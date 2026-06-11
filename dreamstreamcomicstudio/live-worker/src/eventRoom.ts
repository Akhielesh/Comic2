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
 * curve + host health telemetry (via the DO alarm while live), RSVPs, the
 * server-side recording registry — and scheduled cleanup: segments (the 24 h
 * replay window) purge a day after the stream ends, server recordings purge
 * after 7 days so storage never leaks.
 *
 * Uses the WebSocket hibernation API so an idle room costs nothing between
 * messages. All durable facts live in storage; per-socket facts live in
 * attachments, so the room survives eviction mid-event.
 */

import { EMOJI_LIBRARY, STRIKE_LIMIT, TIMEOUT_MS, checkSpam, hasProfanity, type SpamState } from './moderation';

export type Role = 'host' | 'mod' | 'guest' | 'viewer' | 'pending';
export type StreamStatus = 'idle' | 'live' | 'paused' | 'ended';

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
  /** Hard concurrent-viewer cap, host-set, never above HARD_VIEWER_CAP. */
  maxViewers: number;
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
}

interface Attach {
  sid: string;
  name: string;
  role: Role;
}

interface Env {
  EVENT_ROOM: DurableObjectNamespace;
  LIVE_BUCKET: R2Bucket;
  ALLOWED_ORIGINS: string;
}

const CHAT_CAP = 200; // ring buffer — chat is logged, never rendered into video
const CHAT_HELLO = 50; // recent messages sent on join
const CHAT_MIN_INTERVAL_MS = 400;
const LOG_CAP = 400;
const CURVE_CAP = 1500; // ~12 h of 30 s samples
const CURVE_SAMPLE_MS = 30_000;
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

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export class EventRoom {
  private lastChatAt = new Map<string, number>(); // best-effort rate limit; resets on hibernation, which is fine
  private spam = new Map<string, SpamState>(); // best-effort repeat detector; same trade-off
  private lastHealthAt = 0;

  constructor(private state: DurableObjectState, private env: Env) {}

  // ---------------------------------------------------------------- storage

  private getMeta(): Promise<EventMeta | undefined> {
    return this.state.storage.get<EventMeta>('meta');
  }

  private putMeta(m: EventMeta): Promise<void> {
    return this.state.storage.put('meta', m);
  }

  private async getStats(): Promise<Stats> {
    const s = (await this.state.storage.get<Stats>('stats')) ?? emptyStats();
    if (!s.healthCurve) s.healthCurve = []; // rooms created before health telemetry
    return s;
  }

  private async publicMeta(m: EventMeta) {
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
    };
    const hostKey = crypto.randomUUID();
    await this.state.storage.put({
      meta,
      hostKey,
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
      meta.status = 'ended';
      meta.endedAt = Date.now();
      await this.putMeta(meta);
      await this.state.storage.delete('hostGoneAt');
      this.broadcast({ t: 'state', status: 'ended', startedAt: meta.startedAt, endedAt: meta.endedAt });
      await this.addLog('live', 'END', 'Host closed the studio — stream ended. Reopen your studio link to go live again.');
      await this.state.storage.setAlarm(meta.endedAt + REPLAY_WINDOW_MS);
    }
    return new Response(null, { status: 204 });
  }

  /** The worker finished a multipart upload to R2 — remember the recording. */
  private async handleRecRegister(req: Request): Promise<Response> {
    const hostKey = await this.state.storage.get<string>('hostKey');
    if (req.headers.get('x-host-key') !== hostKey) return json({ error: 'forbidden' }, 403);
    const body = (await req.json()) as Partial<RecordingEntry>;
    const rec: RecordingEntry = {
      key: String(body.key ?? ''),
      file: String(body.file ?? 'recording').slice(0, 120),
      bytes: Math.max(0, Number(body.bytes) || 0),
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
    return json({ ok: true, count: recordings.length });
  }

  private async handleRecList(req: Request, url: URL): Promise<Response> {
    const hostKey = await this.state.storage.get<string>('hostKey');
    if (url.searchParams.get('k') !== hostKey) return json({ error: 'forbidden' }, 403);
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
    if (url.searchParams.get('k') !== hostKey) return json({ error: 'forbidden' }, 403);
    const [stats, log, chatters, recordings] = await Promise.all([
      this.getStats(),
      this.state.storage.get<LogEntry[]>('log'),
      this.state.storage.get<Record<string, number>>('chatters'),
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

  /** Called by the worker after it stored a segment in R2; broadcasts to viewers. */
  private async handleIngest(req: Request): Promise<Response> {
    const meta = await this.getMeta();
    if (!meta) return json({ error: 'not found' }, 404);
    const hostKey = await this.state.storage.get<string>('hostKey');
    if (req.headers.get('x-host-key') !== hostKey) return json({ error: 'forbidden' }, 403);

    const { seq, ms, at, mime } = (await req.json()) as { seq: number; ms: number; at: number; mime?: string };
    if (!Number.isFinite(seq) || seq <= 0) return json({ error: 'bad seq' }, 400);
    const now = Date.now();
    if (meta.status === 'live' && meta.lastIngestAt && now - meta.lastIngestAt > meta.segMs * 3) {
      await this.addLog('warn', 'WARN', `Segment gap of ${((now - meta.lastIngestAt) / 1000).toFixed(1)}s — upload hiccup`);
    }
    meta.firstSeq = meta.firstSeq || seq;
    meta.latestSeq = Math.max(meta.latestSeq, seq);
    meta.lastIngestAt = now;
    if (mime && !meta.mime) {
      meta.mime = mime; // host's recorder decides the codec once
      await this.addLog('sys', 'SYS', `First segment received · ${mime.split(';')[0]}`);
    }
    await this.putMeta(meta);
    this.broadcast({ t: 'segment', seq, ms, at });
    return json({ ok: true });
  }

  // ----------------------------------------------------- alarm (the janitor)

  /**
   * One alarm, three jobs: sample the viewer curve while live; purge segments
   * when the 24 h replay window closes; purge server recordings after 7 days.
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
        await this.putMeta(meta);
        this.broadcast({ t: 'state', status: 'ended', startedAt: meta.startedAt, endedAt: meta.endedAt });
        await this.addLog('live', 'END', 'Auto-ended — the host did not return. Replay stays up for 24 h.');
        await this.state.storage.setAlarm(meta.endedAt + REPLAY_WINDOW_MS);
      }
      return;
    }

    if (meta.status === 'live') {
      // Abandoned room (host vanished without ending): auto-end after 2 h of
      // silence so viewers see "ended" and the retention janitor takes over.
      if (meta.lastIngestAt && Date.now() - meta.lastIngestAt > 2 * 60 * 60_000) {
        meta.status = 'ended';
        meta.endedAt = meta.lastIngestAt;
        await this.putMeta(meta);
        this.broadcast({ t: 'state', status: 'ended', startedAt: meta.startedAt, endedAt: meta.endedAt });
        await this.addLog('warn', 'WARN', 'Stream auto-ended after 2 h without segments');
        await this.state.storage.setAlarm(meta.endedAt + REPLAY_WINDOW_MS);
        return;
      }
      const stats = await this.getStats();
      stats.curve.push({ at: Date.now(), n: this.viewerCount() });
      if (stats.curve.length > CURVE_CAP) stats.curve.splice(0, stats.curve.length - CURVE_CAP);
      await this.state.storage.put('stats', stats);
      await this.state.storage.setAlarm(Date.now() + CURVE_SAMPLE_MS);
      return;
    }

    if (meta.status !== 'ended' || !meta.endedAt) return;
    const now = Date.now();
    const segPurgeAt = meta.endedAt + REPLAY_WINDOW_MS;
    const recPurgeAt = meta.endedAt + RECORDING_RETENTION_MS;

    if (now >= recPurgeAt) {
      await this.deletePrefix(`events/${meta.id}/rec/`);
      await this.deletePrefix(`events/${meta.id}/seg/`);
      await this.state.storage.put('recordings', [] as RecordingEntry[]);
      await this.addLog('sys', 'SYS', 'Retention sweep — recordings purged after 7 days');
      return; // done; no further alarms
    }
    if (now >= segPurgeAt) {
      await this.deletePrefix(`events/${meta.id}/seg/`);
      await this.addLog('sys', 'SYS', 'Replay window closed — segments purged after 24 h');
      await this.state.storage.setAlarm(recPurgeAt);
      return;
    }
    await this.state.storage.setAlarm(segPurgeAt);
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

    if (role === 'host') {
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
      await this.trackViewerJoin(attach);
      await this.broadcastViewers();
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

    switch (msg.t) {
      case 'chat':
        return this.onChat(ws, me, String(msg.text ?? ''));
      case 'emoji':
        return this.onEmoji(me, String(msg.e ?? ''));
      case 'rtc':
        return this.onRtc(me, msg);
      case 'guestkey':
        return this.onGuestKey(ws, me, Boolean(msg.rotate));
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
      if (meta && meta.status === 'live') {
        meta.status = 'paused';
        await this.putMeta(meta);
        this.broadcast({ t: 'state', status: 'paused', startedAt: meta.startedAt, endedAt: meta.endedAt });
        await this.state.storage.put('hostGoneAt', Date.now());
        await this.addLog('warn', 'WARN', `Host disconnected — paused; auto-end in ${HOST_GONE_GRACE_MS / 60_000} min unless they return`);
        await this.state.storage.setAlarm(Date.now() + HOST_GONE_GRACE_MS);
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
    const [chat, stats, chatters] = await Promise.all([
      this.state.storage.get<ChatMsg[]>('chat').then((c) => c ?? []),
      this.getStats(),
      this.state.storage.get<Record<string, number>>('chatters').then((c) => c ?? {}),
    ]);
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
    await this.state.storage.put({ chat, stats, chatters });
    this.broadcast({ t: 'chat', m });
  }

  private async onEmoji(me: Attach, e: string): Promise<void> {
    if (me.role === 'pending' || !ALLOWED_EMOJI.has(e)) return;
    const meta = await this.getMeta();
    if (!meta) return;
    if (!meta.reactionsOn && me.role === 'viewer') return;
    const stats = await this.getStats();
    stats.emojiTotal += 1;
    await this.state.storage.put('stats', stats);
    this.broadcast({ t: 'emoji', e, name: me.name });
  }

  private async onState(me: Attach, status: string): Promise<void> {
    if (me.role !== 'host') return;
    if (status !== 'live' && status !== 'paused' && status !== 'ended') return;
    const meta = await this.getMeta();
    if (!meta) return;
    const prev = meta.status;
    meta.status = status;
    if (status === 'live' && !meta.startedAt) meta.startedAt = Date.now();
    if (status === 'live') {
      meta.endedAt = null; // restarting after an (auto-)end — not over anymore
      await this.state.storage.delete('hostGoneAt');
    }
    if (status === 'ended') meta.endedAt = Date.now();
    await this.putMeta(meta);
    this.broadcast({ t: 'state', status, startedAt: meta.startedAt, endedAt: meta.endedAt });

    if (status === 'live' && prev !== 'live') {
      await this.addLog('live', 'LIVE', prev === 'paused' ? 'Resumed — back on the air' : `Stream started · ${meta.quality}`);
      await this.state.storage.setAlarm(Date.now() + CURVE_SAMPLE_MS);
    } else if (status === 'paused') {
      await this.addLog('scene', 'SCENE', 'Cut to “Be right back” slate');
    } else if (status === 'ended') {
      await this.addLog('live', 'END', 'Stream ended by host — replay stays up for 24 h, recordings for 7 days');
      await this.state.storage.setAlarm(meta.endedAt! + REPLAY_WINDOW_MS);
    }
  }

  /** Host adjusts room behavior mid-stream: slow mode, reactions, viewer cap. */
  private async onConfig(me: Attach, msg: Record<string, unknown>): Promise<void> {
    if (me.role !== 'host') return;
    const meta = await this.getMeta();
    if (!meta) return;
    if (msg.slow != null) meta.slowSec = Math.min(120, Math.max(0, Math.floor(Number(msg.slow)) || 0));
    if (msg.reactions != null) meta.reactionsOn = Boolean(msg.reactions);
    if (msg.maxViewers != null) {
      meta.maxViewers = Math.min(HARD_VIEWER_CAP, Math.max(1, Math.floor(Number(msg.maxViewers)) || DEFAULT_VIEWER_CAP));
    }
    await this.putMeta(meta);
    this.broadcast({ t: 'config', slow: meta.slowSec, reactions: meta.reactionsOn, maxViewers: meta.maxViewers });
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
    await this.state.storage.put('stats', stats);
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

  private async onPin(me: Attach, text: string | null): Promise<void> {
    if (me.role !== 'host' && me.role !== 'mod') return;
    const meta = await this.getMeta();
    if (!meta) return;
    meta.pinned = text ? text.slice(0, 200) : null;
    await this.putMeta(meta);
    this.broadcast({ t: 'pin', text: meta.pinned });
  }

  private async onDelete(me: Attach, id: string): Promise<void> {
    if (me.role !== 'host' && me.role !== 'mod') return;
    const chat = (await this.state.storage.get<ChatMsg[]>('chat')) ?? [];
    const next = chat.filter((m) => m.id !== id);
    if (next.length !== chat.length) {
      await this.state.storage.put('chat', next);
      this.broadcast({ t: 'delete', id });
    }
  }

  // --------------------------------------------------------------- helpers

  private async sendHello(ws: WebSocket, me: Attach): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) return;
    const chat = (await this.state.storage.get<ChatMsg[]>('chat')) ?? [];
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

  /** Track unique viewers + peak, and announce milestone crossings. */
  private async trackViewerJoin(a: Attach): Promise<void> {
    if (a.role === 'host' || a.role === 'guest') return; // crew aren't audience
    const [stats, seen] = await Promise.all([
      this.getStats(),
      this.state.storage.get<string[]>('seenNames').then((s) => s ?? []),
    ]);
    if (!seen.includes(a.name) && seen.length < 2000) {
      seen.push(a.name);
      stats.uniqueViewers = seen.length;
    }
    const n = this.viewerCount();
    let crossed: number | null = null;
    if (n > stats.peakViewers) {
      for (const m of MILESTONES) {
        if (stats.peakViewers < m && n >= m) crossed = m;
      }
      stats.peakViewers = n;
      stats.peakAt = Date.now();
    }
    await this.state.storage.put({ stats, seenNames: seen });
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

  private async broadcastViewers(): Promise<void> {
    const n = this.viewerCount();
    this.broadcast({ t: 'viewers', n });
    // Keep peak honest on rejoins too (joins go through trackViewerJoin).
    const stats = await this.getStats();
    if (n > stats.peakViewers) {
      stats.peakViewers = n;
      stats.peakAt = Date.now();
      await this.state.storage.put('stats', stats);
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
