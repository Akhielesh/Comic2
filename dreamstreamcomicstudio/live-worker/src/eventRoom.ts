/**
 * EventRoom — one Durable Object per live event.
 *
 * Owns everything that is "the room": stream state (idle/live/paused/ended),
 * chat (ring buffer, logged normally but NEVER part of any recording), emoji
 * reactions, presence/viewer count, the approval lobby (knock → admit/deny),
 * moderation (promote/kick/delete/pin) and new-segment fan-out to viewers.
 *
 * Uses the WebSocket hibernation API so an idle room costs nothing between
 * messages. All durable facts live in storage; per-socket facts live in
 * attachments, so the room survives eviction mid-event.
 */

export type Role = 'host' | 'mod' | 'viewer' | 'pending';
export type StreamStatus = 'idle' | 'live' | 'paused' | 'ended';

export interface EventMeta {
  id: string;
  title: string;
  access: 'open' | 'approval';
  quality: string;
  mime: string;
  segMs: number;
  status: StreamStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  firstSeq: number;
  latestSeq: number;
  pinned: string | null;
}

export interface ChatMsg {
  id: string;
  sid: string;
  name: string;
  role: Role;
  text: string;
  at: number;
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
const ALLOWED_EMOJI = new Set(['❤️', '🔥', '👏', '😂', '🤯', '🎉']);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export class EventRoom {
  private lastChatAt = new Map<string, number>(); // best-effort rate limit; resets on hibernation, which is fine

  constructor(private state: DurableObjectState, _env: Env) {}

  // ---------------------------------------------------------------- storage

  private getMeta(): Promise<EventMeta | undefined> {
    return this.state.storage.get<EventMeta>('meta');
  }

  private putMeta(m: EventMeta): Promise<void> {
    return this.state.storage.put('meta', m);
  }

  private publicMeta(m: EventMeta) {
    return { ...m, viewers: this.viewerCount() };
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
      access: body.access === 'approval' ? 'approval' : 'open',
      quality: String(body.quality ?? '720p'),
      mime: String(body.mime ?? ''),
      segMs: Math.min(6000, Math.max(2000, Number(body.segMs) || 3000)),
      status: 'idle',
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      firstSeq: 0,
      latestSeq: 0,
      pinned: null,
    };
    const hostKey = crypto.randomUUID();
    await this.state.storage.put({ meta, hostKey, admitted: [] as string[], chat: [] as ChatMsg[] });
    return json({ hostKey });
  }

  private async handleMeta(): Promise<Response> {
    const meta = await this.getMeta();
    if (!meta) return json({ error: 'not found' }, 404);
    return json(this.publicMeta(meta));
  }

  /** Called by the worker after it stored a segment in R2; broadcasts to viewers. */
  private async handleIngest(req: Request): Promise<Response> {
    const meta = await this.getMeta();
    if (!meta) return json({ error: 'not found' }, 404);
    const hostKey = await this.state.storage.get<string>('hostKey');
    if (req.headers.get('x-host-key') !== hostKey) return json({ error: 'forbidden' }, 403);

    const { seq, ms, at, mime } = (await req.json()) as { seq: number; ms: number; at: number; mime?: string };
    if (!Number.isFinite(seq) || seq <= 0) return json({ error: 'bad seq' }, 400);
    meta.firstSeq = meta.firstSeq || seq;
    meta.latestSeq = Math.max(meta.latestSeq, seq);
    if (mime && !meta.mime) meta.mime = mime; // host's recorder decides the codec once
    await this.putMeta(meta);
    this.broadcast({ t: 'segment', seq, ms, at });
    return json({ ok: true });
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
    const token = url.searchParams.get('token');
    const hostKey = await this.state.storage.get<string>('hostKey');
    const admitted = (await this.state.storage.get<string[]>('admitted')) ?? [];

    let role: Role;
    if (key && key === hostKey) role = 'host';
    else if (meta.access === 'open' || (token && admitted.includes(token))) role = 'viewer';
    else role = 'pending';

    const pair = new WebSocketPair();
    const server = pair[1];
    this.state.acceptWebSocket(server);
    const attach: Attach = { sid: crypto.randomUUID().slice(0, 8), name, role };
    server.serializeAttachment(attach);

    if (role === 'pending') {
      this.send(server, { t: 'pending' });
      this.lobbySync();
    } else {
      await this.sendHello(server, attach);
      this.broadcastViewers();
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > 4096) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const me = ws.deserializeAttachment() as Attach | null;
    if (!me) return;

    switch (msg.t) {
      case 'chat':
        return this.onChat(ws, me, String(msg.text ?? ''));
      case 'emoji':
        return this.onEmoji(me, String(msg.e ?? ''));
      case 'state':
        return this.onState(me, String(msg.status ?? ''));
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
    this.broadcastViewers();
    if (me?.role === 'pending') this.lobbySync();
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
    const now = Date.now();
    if (now - (this.lastChatAt.get(me.sid) ?? 0) < CHAT_MIN_INTERVAL_MS) return;
    this.lastChatAt.set(me.sid, now);

    const m: ChatMsg = {
      id: crypto.randomUUID().slice(0, 12),
      sid: me.sid,
      name: me.name,
      role: me.role,
      text: clean,
      at: now,
    };
    const chat = (await this.state.storage.get<ChatMsg[]>('chat')) ?? [];
    chat.push(m);
    if (chat.length > CHAT_CAP) chat.splice(0, chat.length - CHAT_CAP);
    await this.state.storage.put('chat', chat);
    this.broadcast({ t: 'chat', m });
  }

  private onEmoji(me: Attach, e: string): void {
    if (me.role === 'pending' || !ALLOWED_EMOJI.has(e)) return;
    this.broadcast({ t: 'emoji', e, name: me.name });
  }

  private async onState(me: Attach, status: string): Promise<void> {
    if (me.role !== 'host') return;
    if (status !== 'live' && status !== 'paused' && status !== 'ended') return;
    const meta = await this.getMeta();
    if (!meta) return;
    meta.status = status;
    if (status === 'live' && !meta.startedAt) meta.startedAt = Date.now();
    if (status === 'ended') meta.endedAt = Date.now();
    await this.putMeta(meta);
    this.broadcast({ t: 'state', status, startedAt: meta.startedAt, endedAt: meta.endedAt });
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
        const token = crypto.randomUUID();
        const admitted = (await this.state.storage.get<string[]>('admitted')) ?? [];
        admitted.push(token);
        await this.state.storage.put('admitted', admitted.slice(-500));
        a.role = 'viewer';
        ws.serializeAttachment(a);
        this.send(ws, { t: 'admitted', token });
        await this.sendHello(ws, a);
        this.broadcastViewers();
        this.lobbySync();
      } else if (action === 'deny' && a.role === 'pending') {
        this.send(ws, { t: 'denied' });
        try {
          ws.close(4001, 'denied');
        } catch { /* closed */ }
        this.lobbySync();
      } else if (action === 'kick') {
        this.send(ws, { t: 'kicked' });
        try {
          ws.close(4002, 'kicked');
        } catch { /* closed */ }
        this.broadcastViewers();
      } else if (action === 'promote' && a.role === 'viewer') {
        a.role = 'mod';
        ws.serializeAttachment(a);
        this.send(ws, { t: 'role', role: 'mod' });
        this.lobbySync();
      }
      return;
    }
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
    this.send(ws, {
      t: 'hello',
      meta: this.publicMeta(meta),
      you: { sid: me.sid, role: me.role, name: me.name },
      chat: chat.slice(-CHAT_HELLO),
    });
    if (me.role === 'host' || me.role === 'mod') this.lobbySync();
  }

  private viewerCount(): number {
    let n = 0;
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a && a.role !== 'pending' && a.role !== 'host') n++;
    }
    return n;
  }

  private broadcastViewers(): void {
    this.broadcast({ t: 'viewers', n: this.viewerCount() });
  }

  private lobbySync(): void {
    const pending: { sid: string; name: string }[] = [];
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a?.role === 'pending') pending.push({ sid: a.sid, name: a.name });
    }
    this.broadcast({ t: 'lobby', pending }, (a) => a.role === 'host' || a.role === 'mod');
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
