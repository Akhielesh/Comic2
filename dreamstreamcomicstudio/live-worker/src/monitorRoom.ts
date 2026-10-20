/**
 * MonitorRoom — one Durable Object per nursery (Baby Monitor).
 *
 * NEVER RECORDS. Video and audio flow peer-to-peer between the baby's camera
 * device and the family's viewing devices (WebRTC, DTLS-SRTP encrypted end to
 * end). This room only:
 *   - authenticates every socket against Supabase (the member's own bearer
 *     token → monitor_my_role) before it can see or send anything,
 *   - relays WebRTC signaling between members of THIS nursery,
 *   - fans out the camera's on-device analysis (calm / stirring / crying,
 *     sound + motion levels, battery) and keeps a small text timeline,
 *   - watches camera heartbeats and raises "camera offline" alerts,
 *   - sends Web Push alerts (cry, offline, low battery, loud noise),
 *   - forwards low-rate JPEG snapshots in memory when a network blocks P2P
 *     (relay mode). Frames are passed through, never stored.
 *
 * The singleton instance named KEY_HOLDER only stores the VAPID key pair.
 */

import { callRpc, type SupabaseEnv } from './supabaseAuth';
import { generateVapidKeys, isAllowedPushEndpoint, sendWebPush, type PushSubscriptionJSONLike, type VapidKeys } from './webpush';

export const KEY_HOLDER = '__vapid_keys__';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type MonRole = 'parent' | 'caregiver' | 'viewer';
/** 'admin' = a parent's short-lived control connection (never in presence). */
export type MonMode = 'camera' | 'viewer' | 'admin';
export type BabyState = 'calm' | 'stirring' | 'awake' | 'noisy' | 'fussing' | 'crying';
const BABY_STATES: BabyState[] = ['calm', 'stirring', 'awake', 'noisy', 'fussing', 'crying'];

/** Sound categories the camera's on-device detector reports (mirror of live/monitor/soundClasses.ts). */
export type SoundCat = 'cry' | 'fuss' | 'cough' | 'alarm' | 'crash' | 'loud' | 'babble' | 'laugh' | 'voices' | 'music' | 'dog';
const SOUND: Record<SoundCat, { headline: string; push: boolean; gapMs: number; ends?: boolean }> = {
  cry: { headline: '{baby} is crying', push: true, gapMs: 20_000, ends: true },
  fuss: { headline: '{baby} is fussing', push: true, gapMs: 60_000, ends: true },
  cough: { headline: '{baby} is coughing', push: true, gapMs: 60_000 },
  alarm: { headline: 'Alarm sounding in the nursery — check for smoke or CO', push: true, gapMs: 30_000 },
  crash: { headline: 'Loud bang or crash in the nursery', push: true, gapMs: 60_000 },
  loud: { headline: 'Loud sound in the nursery', push: true, gapMs: 5 * 60_000 },
  babble: { headline: '{baby} is awake and babbling', push: false, gapMs: 10 * 60_000 },
  laugh: { headline: '{baby} is laughing', push: false, gapMs: 10 * 60_000 },
  voices: { headline: 'Someone is talking in the nursery', push: false, gapMs: 15 * 60_000 },
  music: { headline: 'Music or TV playing in the nursery', push: false, gapMs: 30 * 60_000 },
  dog: { headline: 'Dog barking near the nursery', push: false, gapMs: 5 * 60_000 },
};
const isSoundCat = (v: unknown): v is SoundCat => typeof v === 'string' && v in SOUND;

/** Background-alert categories a device can opt into (and their defaults). */
const PUSH_KINDS = ['cry', 'fuss', 'cough', 'alarm', 'crash', 'loud', 'offline', 'battery'] as const;
type PushKind = (typeof PUSH_KINDS)[number];
const PUSH_DEFAULTS: Record<PushKind, boolean> = { cry: true, fuss: false, cough: true, alarm: true, crash: true, loud: false, offline: true, battery: true };

export interface MonEnv extends SupabaseEnv {
  MONITOR_ROOM: DurableObjectNamespace;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

interface Attach {
  sid: string;
  at: number;
  authed: boolean;
  uid?: string;
  name?: string;
  role?: MonRole;
  label?: string | null;
  mode?: MonMode;
  dev?: string;
  dn?: string;
  /** Viewer: camera device id it wants relayed snapshots from. */
  relay?: string;
}

export interface CamStatus {
  state: BabyState;
  /** Sound level above the room's noise floor, dB (0–60). */
  level: number;
  /** Motion 0–100. */
  motion: number;
  /** Mean luminance 0–255 — low = dark room. */
  light: number;
  battery: number | null;
  charging: boolean | null;
  soothing: string | null;
  cry: number;
  /** Most important sound right now + what the AI hears (top 3, 0–100). */
  sound: SoundCat | null;
  conf: number;
  top: [SoundCat, number][];
  model: 'off' | 'loading' | 'ready' | 'failed';
  paused: 'privacy' | 'interrupted' | null;
  talk: string | null;
  call: string | null;
}

export interface MonLog {
  id: string;
  at: number;
  kind:
    | SoundCat
    | 'cry_end' | 'fuss_end' | 'noise' | 'motion' | 'offline' | 'online' | 'battery' | 'privacy' | 'call'
    | 'feed' | 'diaper' | 'sleep' | 'wake' | 'note' | 'ack' | 'soothe' | 'camera' | 'people';
  msg: string;
  by?: string;
  dev?: string;
  secs?: number;
  conf?: number;
}

interface PushRec {
  sub: PushSubscriptionJSONLike;
  uid: string;
  name: string;
  prefs: Record<string, boolean>;
  at: number;
}

interface Settings {
  sensitivity: 'low' | 'medium' | 'high';
  /** Minutes between repeated cry pushes during one long crying spell. */
  cryRepeatMin: number;
}

const DEFAULT_SETTINGS: Settings = { sensitivity: 'medium', cryRepeatMin: 3 };
const AUTH_TIMEOUT_MS = 10_000;
const ALARM_MS = 15_000;
const BEAT_STALE_MS = 45_000;
const OFFLINE_GRACE_MS = 20_000;
const LOG_CAP = 600;
const LOG_HELLO = 120;
const TL_BUCKET_MS = 5 * 60_000;
const TL_KEEP_MS = 7 * 24 * 60 * 60_000;
const MAX_SOCKETS = 14;
const MAX_CAMERAS = 4;
const PUSH_CAP = 40;
const FRAME_MAX = 8 * 1024;
const RTC_FRAME_MAX = 64 * 1024;
const SNAPSHOT_MAX = 256 * 1024;
const SNAPSHOT_MIN_GAP_MS = 250;
const STATE_RANK: Record<BabyState, number> = { calm: 1, stirring: 2, awake: 2, noisy: 3, fussing: 4, crying: 5 };
const PUSH_COOLDOWN_MS: Record<string, number> = {
  alarm: 60_000, fuss: 10 * 60_000, cough: 10 * 60_000, crash: 10 * 60_000, loud: 10 * 60_000, offline: 5 * 60_000, battery: 30 * 60_000,
};
const PUSH_URGENT = new Set(['cry', 'alarm', 'offline']);
const STUN = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const VAPID_SUBJECT = 'https://dreamstreamstudio.ai';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const clip = (s: unknown, n: number) => String(s ?? '').trim().slice(0, n);
const num = (v: unknown, lo: number, hi: number, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

export class MonitorRoom {
  // In-memory, best-effort (rebuilt after eviction; the alarm re-seeds grace).
  private beats = new Map<string, number>();
  private staleFlagged = new Set<string>();
  private lastStatus = new Map<string, { st: CamStatus; at: number }>();
  private lastSnapAt = new Map<string, number>();
  private lastStatusAt = new Map<string, number>();
  private lastSoundAt = new Map<string, number>();
  private curBucket: { t: number; s: number; cry: number } | null = null;
  private lastBucketSave = 0;
  private vapid: VapidKeys | null = null;
  private ice: { at: number; servers: unknown[] } | null = null;

  constructor(private state: DurableObjectState, private env: MonEnv) {}

  // ------------------------------------------------------------------ HTTP
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/vapid') return this.handleVapid();
    if (url.pathname === '/ws') return this.handleUpgrade(req, url);
    return json({ error: 'not found' }, 404);
  }

  /** Key-holder instance only: get-or-create the VAPID key pair. */
  private async handleVapid(): Promise<Response> {
    let keys = await this.state.storage.get<VapidKeys>('vapid');
    if (!keys) {
      keys = await generateVapidKeys();
      await this.state.storage.put('vapid', keys);
    }
    return json(keys);
  }

  private async vapidKeys(): Promise<VapidKeys | null> {
    if (this.vapid) return this.vapid;
    try {
      const stub = this.env.MONITOR_ROOM.get(this.env.MONITOR_ROOM.idFromName(KEY_HOLDER));
      const res = await stub.fetch(new Request('https://monitor.internal/vapid'));
      if (res.ok) this.vapid = (await res.json()) as VapidKeys;
    } catch {
      /* push degrades to in-app alerts */
    }
    return this.vapid;
  }

  private async iceServers(): Promise<unknown[]> {
    if (this.ice && Date.now() - this.ice.at < 60 * 60_000) return this.ice.servers;
    let servers: unknown[] = STUN;
    // Optional TURN (Cloudflare Realtime) for networks that block peer-to-peer.
    if (this.env.TURN_KEY_ID && this.env.TURN_KEY_API_TOKEN) {
      try {
        const res = await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.TURN_KEY_ID}/credentials/generate-ice-servers`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${this.env.TURN_KEY_API_TOKEN}`, 'content-type': 'application/json' },
            body: JSON.stringify({ ttl: 6 * 3600 }),
          },
        );
        if (res.ok) {
          const body = (await res.json()) as { iceServers?: unknown };
          const turn = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
          if (turn.length) servers = [...STUN, ...turn];
        }
      } catch {
        /* STUN-only; relay mode still covers blocked networks */
      }
    }
    this.ice = { at: Date.now(), servers };
    return servers;
  }

  private async handleUpgrade(req: Request, url: URL): Promise<Response> {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'expected websocket' }, 426);
    const nid = url.searchParams.get('nid') || '';
    if (!UUID_RE.test(nid)) return json({ error: 'bad nursery' }, 400);
    const known = await this.state.storage.get<string>('nid');
    if (!known) await this.state.storage.put('nid', nid);
    else if (known !== nid) return json({ error: 'bad nursery' }, 400);

    const pair = new WebSocketPair();
    const server = pair[1];
    if (this.sockets().length >= MAX_SOCKETS + 4) {
      server.accept();
      try {
        server.send(JSON.stringify({ t: 'error', code: 'full', msg: 'Too many devices are connected to this nursery right now.' }));
        server.close(4003, 'full');
      } catch { /* closing */ }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    this.state.acceptWebSocket(server);
    const a: Attach = { sid: crypto.randomUUID().slice(0, 10), at: Date.now(), authed: false };
    server.serializeAttachment(a);
    await this.ensureAlarm(AUTH_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ------------------------------------------------------------- sockets
  private sockets(): { ws: WebSocket; a: Attach }[] {
    const out: { ws: WebSocket; a: Attach }[] = [];
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a) out.push({ ws, a });
    }
    return out;
  }

  private authed(): { ws: WebSocket; a: Attach }[] {
    return this.sockets().filter((s) => s.a.authed);
  }

  private send(ws: WebSocket, obj: unknown): void {
    try {
      ws.send(JSON.stringify(obj));
    } catch { /* closing */ }
  }

  private broadcast(obj: unknown, filter?: (a: Attach) => boolean): void {
    const payload = JSON.stringify(obj);
    for (const { ws, a } of this.authed()) {
      if (filter && !filter(a)) continue;
      try {
        ws.send(payload);
      } catch { /* closing */ }
    }
  }

  private presence() {
    const cams: { sid: string; dev: string; dn: string; by: string; since: number; status: CamStatus | null; statusAt: number | null }[] = [];
    const viewers: { sid: string; name: string; label: string | null; role: MonRole; dn: string; relay: boolean }[] = [];
    for (const { a } of this.authed()) {
      if (a.mode === 'camera' && a.dev) {
        const ls = this.lastStatus.get(a.dev);
        cams.push({ sid: a.sid, dev: a.dev, dn: a.dn || 'Camera', by: a.name || 'Member', since: a.at, status: ls?.st ?? null, statusAt: ls?.at ?? null });
      } else if (a.mode === 'viewer') {
        viewers.push({ sid: a.sid, name: a.name || 'Member', label: a.label ?? null, role: a.role || 'viewer', dn: a.dn || 'Device', relay: !!a.relay });
      }
    }
    return { cams, viewers };
  }

  private syncPresence(): void {
    this.broadcast({ t: 'presence', ...this.presence() });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Attach | null;
    if (!a) return;

    // Binary = relay snapshot (JPEG) from an authenticated camera.
    if (typeof raw !== 'string') {
      if (!a.authed || a.mode !== 'camera' || !a.dev || raw.byteLength > SNAPSHOT_MAX) return;
      const now = Date.now();
      if (now - (this.lastSnapAt.get(a.dev) ?? 0) < SNAPSHOT_MIN_GAP_MS) return;
      this.lastSnapAt.set(a.dev, now);
      for (const s of this.authed()) {
        if (s.a.mode === 'viewer' && s.a.relay === a.dev) {
          try {
            s.ws.send(raw);
          } catch { /* closing */ }
        }
      }
      return;
    }

    if (raw.length > RTC_FRAME_MAX) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t !== 'rtc' && msg.t !== 'auth' && msg.t !== 'push_sub' && raw.length > FRAME_MAX) return;

    if (!a.authed) {
      if (msg.t === 'auth') await this.onAuth(ws, a, msg);
      return;
    }

    switch (msg.t) {
      case 'rtc':
        return this.onRtc(a, msg);
      case 'status':
        return this.onStatus(a, msg);
      case 'beat':
        if (a.mode === 'camera' && a.dev) this.markBeat(a.dev);
        return;
      case 'event':
        return this.onCamEvent(a, msg);
      case 'log':
        return this.onLog(a, msg);
      case 'ack':
        return this.onAck(a, msg);
      case 'cmd':
        return this.onCmd(a, msg);
      case 'relay':
        return this.onRelay(ws, a, msg);
      case 'push_sub':
        return this.onPushSub(ws, a, msg);
      case 'push_unsub':
        return this.onPushUnsub(a, msg);
      case 'push_test':
        return this.onPushTest(ws, a);
      case 'settings':
        return this.onSettings(a, msg);
      case 'members_changed':
        return this.onMembersChanged(a, msg);
      case 'end_all':
        return this.onEndAll(a);
      case 'bye':
        if (a.mode === 'camera' && a.dev) {
          await this.state.storage.put(`bye:${a.dev}`, Date.now());
          await this.addLog({ kind: 'camera', msg: `${a.dn || 'Camera'} was stopped by ${a.name}`, by: a.name, dev: a.dev });
        }
        return;
      case 'ping':
        return this.send(ws, { t: 'pong', at: Date.now() });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const a = ws.deserializeAttachment() as Attach | null;
    if (!a?.authed) return;
    if (a.mode === 'camera' && a.dev) {
      const stillThere = this.authed().some((s) => s.ws !== ws && s.a.mode === 'camera' && s.a.dev === a.dev);
      if (!stillThere) {
        const bye = await this.state.storage.get<number>(`bye:${a.dev}`);
        if (bye && Date.now() - bye < 30_000) {
          await this.state.storage.delete(`bye:${a.dev}`);
        } else {
          // Unexpected drop: alert unless it comes back within the grace window.
          const pending = (await this.state.storage.get<Record<string, { at: number; dn: string }>>('pendingOffline')) ?? {};
          pending[a.dev] = { at: Date.now(), dn: a.dn || 'Camera' };
          await this.state.storage.put('pendingOffline', pending);
          await this.ensureAlarm(OFFLINE_GRACE_MS);
        }
        this.beats.delete(a.dev);
        this.lastStatus.delete(a.dev);
      }
      // Viewers relaying this camera no longer need to; tell the camera's peers.
      this.broadcast({ t: 'cam_gone', sid: a.sid, dev: a.dev });
    }
    if (a.mode === 'viewer') {
      this.broadcast({ t: 'peer_gone', sid: a.sid }, (x) => x.mode === 'camera');
      if (a.relay) this.updateRelayWant(a.relay);
    }
    this.syncPresence();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error');
    } catch { /* closed */ }
  }

  // ---------------------------------------------------------------- auth
  private async onAuth(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    const token = clip(msg.token, 4096);
    const mode: MonMode = msg.mode === 'camera' ? 'camera' : msg.mode === 'admin' ? 'admin' : 'viewer';
    const nid = (await this.state.storage.get<string>('nid')) || '';
    if (!token || !nid) return this.reject(ws, 'auth', 'Sign in again to open this nursery.');

    const res = await callRpc<{ ok?: boolean; user_id?: string; role?: MonRole; label?: string | null; display_name?: string; nursery_name?: string; baby_name?: string | null }>(
      this.env,
      token,
      'monitor_my_role',
      { p_nursery: nid },
    );
    if (!res.ok) {
      return this.reject(ws, 'auth', res.status === 401 ? 'Your session expired — sign in again.' : 'Could not verify your account right now.');
    }
    if (!res.data.ok || !res.data.user_id || !res.data.role) {
      return this.reject(ws, 'forbidden', 'You are not a member of this nursery.');
    }
    if (mode === 'admin' && res.data.role !== 'parent') {
      return this.reject(ws, 'forbidden', 'Only parents can manage this nursery.');
    }
    if (mode === 'camera' && res.data.role === 'viewer') {
      return this.reject(ws, 'forbidden', 'Your role can watch but not run the camera. Ask a parent to make you a caregiver.');
    }
    const camCount = this.authed().filter((s) => s.a.mode === 'camera').length;
    if (mode === 'camera' && camCount >= MAX_CAMERAS) {
      return this.reject(ws, 'full', `This nursery already has ${MAX_CAMERAS} cameras running.`);
    }

    a.authed = true;
    a.uid = res.data.user_id;
    a.name = clip(res.data.display_name || 'Member', 40);
    a.role = res.data.role;
    a.label = res.data.label ?? null;
    a.mode = mode;
    a.dev = clip(msg.dev, 40) || a.sid;
    a.dn = clip(msg.dn, 40) || (mode === 'camera' ? 'Camera' : 'Device');
    ws.serializeAttachment(a);

    // A device re-joining as the same camera replaces its stale socket.
    if (mode === 'camera') {
      for (const s of this.authed()) {
        if (s.ws !== ws && s.a.mode === 'camera' && s.a.dev === a.dev) {
          try {
            s.ws.close(4005, 'replaced');
          } catch { /* closed */ }
        }
      }
    }

    const meta = { name: res.data.nursery_name || 'Nursery', baby: res.data.baby_name || null };
    await this.state.storage.put('meta', meta);

    const [log, tl, settings, ice, vapid] = await Promise.all([
      this.state.storage.get<MonLog[]>('log'),
      this.timeline(),
      this.settings(),
      this.iceServers(),
      this.vapidKeys(),
    ]);
    this.send(ws, {
      t: 'hello',
      you: { sid: a.sid, uid: a.uid, name: a.name, role: a.role, label: a.label, mode, dev: a.dev },
      nursery: { id: nid, ...meta },
      ...this.presence(),
      log: (log ?? []).slice(-LOG_HELLO),
      tl,
      settings,
      ice,
      vapid: vapid?.publicKey ?? null,
    });

    if (mode === 'camera') {
      this.markBeat(a.dev);
      const pending = (await this.state.storage.get<Record<string, { at: number; dn: string }>>('pendingOffline')) ?? {};
      const wasAlerted = await this.state.storage.get<boolean>(`alerted:${a.dev}`);
      if (pending[a.dev]) {
        delete pending[a.dev];
        await this.state.storage.put('pendingOffline', pending);
      }
      if (wasAlerted) {
        await this.state.storage.delete(`alerted:${a.dev}`);
        await this.addLog({ kind: 'online', msg: `${a.dn} is back online`, dev: a.dev });
      } else {
        await this.addLog({ kind: 'camera', msg: `${a.dn} started watching${meta.baby ? ` ${meta.baby}` : ''} (by ${a.name})`, by: a.name, dev: a.dev });
      }
      await this.ensureAlarm(ALARM_MS);
    }
    this.syncPresence();
  }

  private reject(ws: WebSocket, code: string, msg: string): void {
    this.send(ws, { t: 'error', code, msg });
    try {
      ws.close(code === 'auth' ? 4001 : code === 'full' ? 4003 : 4004, code);
    } catch { /* closed */ }
  }

  // -------------------------------------------------------------- relays
  private onRtc(a: Attach, msg: Record<string, unknown>): void {
    const to = clip(msg.to, 20);
    if (!to || msg.d == null || typeof msg.d !== 'object') return;
    for (const s of this.authed()) {
      if (s.a.sid !== to) continue;
      // Media only ever pairs a camera with a viewer of the same nursery.
      if (s.a.mode === a.mode) return;
      this.send(s.ws, { t: 'rtc', from: a.sid, d: msg.d, name: a.name, label: a.label ?? null, role: a.role });
      return;
    }
  }

  private markBeat(dev: string): void {
    this.beats.set(dev, Date.now());
    this.staleFlagged.delete(dev);
  }

  private onStatus(a: Attach, msg: Record<string, unknown>): void {
    if (a.mode !== 'camera' || !a.dev) return;
    const now = Date.now();
    this.markBeat(a.dev);
    if (now - (this.lastStatusAt.get(a.dev) ?? 0) < 800) return;
    this.lastStatusAt.set(a.dev, now);
    const s = (msg.st ?? {}) as Record<string, unknown>;
    const state: BabyState = BABY_STATES.includes(s.state as BabyState) ? (s.state as BabyState) : 'calm';
    const top = Array.isArray(s.top)
      ? (s.top as unknown[])
          .filter((x): x is [SoundCat, number] => Array.isArray(x) && isSoundCat(x[0]))
          .slice(0, 3)
          .map(([c, v]) => [c, Math.round(num(v, 0, 100))] as [SoundCat, number])
      : [];
    const st: CamStatus = {
      state,
      level: Math.round(num(s.level, 0, 90)),
      motion: Math.round(num(s.motion, 0, 100)),
      light: Math.round(num(s.light, 0, 255)),
      battery: s.battery == null ? null : Math.round(num(s.battery, 0, 100)),
      charging: s.charging == null ? null : Boolean(s.charging),
      soothing: s.soothing ? clip(s.soothing, 20) : null,
      cry: Math.round(num(s.cry, 0, 100)),
      sound: isSoundCat(s.sound) ? s.sound : null,
      conf: Math.round(num(s.conf, 0, 100)),
      top,
      model: s.model === 'loading' || s.model === 'ready' || s.model === 'failed' ? s.model : 'off',
      paused: s.paused === 'privacy' || s.paused === 'interrupted' ? s.paused : null,
      talk: s.talk ? clip(s.talk, 80) : null,
      call: s.call ? clip(s.call, 60) : null,
    };
    this.lastStatus.set(a.dev, { st, at: now });
    this.broadcast({ t: 'status', dev: a.dev, sid: a.sid, st, at: now }, (x) => x.mode === 'viewer');
    void this.trackBucket(state, now);
  }

  /** 5-minute timeline buckets keep the WORST state seen (cry beats calm). */
  private async trackBucket(state: BabyState, now: number): Promise<void> {
    const t = Math.floor(now / TL_BUCKET_MS) * TL_BUCKET_MS;
    const rank = STATE_RANK[state];
    if (!this.curBucket || this.curBucket.t !== t) {
      if (this.curBucket) await this.saveBucket(this.curBucket);
      this.curBucket = { t, s: rank, cry: 0 };
    }
    const changed = rank > this.curBucket.s;
    this.curBucket.s = Math.max(this.curBucket.s, rank);
    if (state === 'crying') this.curBucket.cry += 1;
    if (changed || now - this.lastBucketSave > 60_000) await this.saveBucket(this.curBucket);
  }

  private async saveBucket(b: { t: number; s: number; cry: number }): Promise<void> {
    this.lastBucketSave = Date.now();
    const tl = (await this.state.storage.get<[number, number, number][]>('tl')) ?? [];
    const last = tl[tl.length - 1];
    if (last && last[0] === b.t) {
      last[1] = Math.max(last[1], b.s);
      last[2] = Math.max(last[2], b.cry);
    } else {
      tl.push([b.t, b.s, b.cry]);
    }
    const cutoff = Date.now() - TL_KEEP_MS;
    while (tl.length && tl[0][0] < cutoff) tl.shift();
    await this.state.storage.put('tl', tl);
  }

  private async timeline(): Promise<[number, number, number][]> {
    const tl = (await this.state.storage.get<[number, number, number][]>('tl')) ?? [];
    const since = Date.now() - 24 * 60 * 60_000;
    return tl.filter((b) => b[0] >= since);
  }

  private async onCamEvent(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.mode !== 'camera' || !a.dev) return;
    const kind = String(msg.kind ?? '');
    const meta = (await this.state.storage.get<{ name: string; baby: string | null }>('meta')) ?? { name: 'Nursery', baby: null };
    const who = meta.baby || 'Baby';
    const where = a.dn || 'Camera';
    if (kind === 'sound') return this.onSoundEvent(a, msg, meta, who, where);
    if (kind === 'privacy') {
      await this.addLog({ kind: 'privacy', msg: msg.on ? `Video paused for privacy on ${where} — sound monitoring continues` : `Video resumed on ${where}`, dev: a.dev });
      return;
    }
    if (kind === 'cry') {
      const entry = await this.addLog({ kind: 'cry', msg: `${who} is crying · ${where}`, dev: a.dev });
      await this.pushAlert('cry', { title: `${who} is crying`, body: `${meta.name} · ${where} — tap to check in`, entryId: entry.id }, a.dev);
    } else if (kind === 'cry_end') {
      const secs = Math.round(num(msg.secs, 0, 7200));
      await this.addLog({ kind: 'cry_end', msg: `${who} settled${secs ? ` after ${secs >= 60 ? `${Math.round(secs / 60)} min` : `${secs}s`}` : ''}`, dev: a.dev });
    } else if (kind === 'noise') {
      const entry = await this.addLog({ kind: 'noise', msg: `Loud sound in ${meta.name} · ${where}`, dev: a.dev });
      await this.pushAlert('loud', { title: 'Loud sound in the nursery', body: `${meta.name} · ${where}`, entryId: entry.id }, a.dev);
    } else if (kind === 'motion') {
      await this.addLog({ kind: 'motion', msg: `${who} is moving around · ${where}`, dev: a.dev });
    } else if (kind === 'battery') {
      const pct = Math.round(num(msg.pct, 0, 100));
      const entry = await this.addLog({ kind: 'battery', msg: `${where} battery low (${pct}%) — plug it in`, dev: a.dev });
      await this.pushAlert('battery', { title: 'Baby camera battery low', body: `${where} is at ${pct}% — plug it in so monitoring doesn't stop`, entryId: entry.id }, a.dev);
    } else if (kind === 'soothe') {
      await this.addLog({ kind: 'soothe', msg: clip(msg.msg, 120) || `Soothing sounds on ${where}`, dev: a.dev });
    }
  }

  /** On-device sound detection: start/end of a category (see live/monitor/soundBrain.ts). */
  private async onSoundEvent(a: Attach, msg: Record<string, unknown>, meta: { name: string; baby: string | null }, who: string, where: string): Promise<void> {
    if (!a.dev || !isSoundCat(msg.cat)) return;
    const cat = msg.cat;
    const info = SOUND[cat];
    const conf = Math.round(num(msg.conf, 0, 100));
    if (msg.phase === 'end') {
      if (!info.ends) return;
      const secs = Math.round(num(msg.secs, 0, 7200));
      const dur = secs >= 60 ? `${Math.round(secs / 60)} min` : `${secs}s`;
      await this.addLog({ kind: cat === 'cry' ? 'cry_end' : 'fuss_end', msg: `${who} settled${secs ? ` after ${dur} of ${cat === 'cry' ? 'crying' : 'fussing'}` : ''}`, dev: a.dev, secs });
      return;
    }
    // A misbehaving camera can't flood the log or everyone's phones.
    const key = `${a.dev}:${cat}`;
    const now = Date.now();
    if (now - (this.lastSoundAt.get(key) ?? 0) < info.gapMs) return;
    this.lastSoundAt.set(key, now);
    const title = info.headline.replace('{baby}', who);
    const entry = await this.addLog({ kind: cat, msg: `${title} · ${where}`, dev: a.dev, conf });
    if (info.push) await this.pushAlert(cat as PushKind, { title, body: `${meta.name} · ${where} — tap to check in`, entryId: entry.id }, a.dev);
  }

  private async onLog(a: Attach, msg: Record<string, unknown>): Promise<void> {
    const kinds = ['feed', 'diaper', 'sleep', 'wake', 'note'] as const;
    const kind = kinds.includes(msg.kind as (typeof kinds)[number]) ? (msg.kind as (typeof kinds)[number]) : null;
    if (!kind) return;
    const label = { feed: 'Fed', diaper: 'Diaper change', sleep: 'Down for sleep', wake: 'Woke up', note: 'Note' }[kind];
    const text = clip(msg.text, 160);
    await this.addLog({ kind, msg: text ? `${label} — ${text}` : label, by: a.label ? `${a.name} (${a.label})` : a.name });
  }

  /** "I'm on it" — tells everyone else someone is checking on the baby. */
  private async onAck(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role === 'viewer') return;
    const ref = clip(msg.id, 20);
    await this.addLog({ kind: 'ack', msg: `${a.label || a.name} is checking on it`, by: a.name, dev: ref || undefined });
    this.broadcast({ t: 'ack', ref, by: a.name, label: a.label ?? null, at: Date.now() });
  }

  /** Remote controls for a camera device: soothing sounds, quality, lens. */
  private onCmd(a: Attach, msg: Record<string, unknown>): void {
    const c = String(msg.c ?? '');
    const allowed = new Set(['soothe', 'soothe_stop', 'quality', 'flip', 'talk', 'video']);
    if (!allowed.has(c)) return;
    if (a.role === 'viewer' && c !== 'quality') return;
    const to = clip(msg.to, 20);
    for (const s of this.authed()) {
      if (s.a.sid === to && s.a.mode === 'camera') {
        const v = (msg.v ?? null) as Record<string, unknown> | null;
        this.send(s.ws, { t: 'cmd', c, v, from: a.sid, by: a.label || a.name });
        if (c === 'video' && v?.on) void this.addLog({ kind: 'call', msg: `${a.label || a.name} video-called ${s.a.dn || 'the nursery'}`, by: a.name, dev: s.a.dev });
        return;
      }
    }
  }

  private onRelay(ws: WebSocket, a: Attach, msg: Record<string, unknown>): void {
    if (a.mode !== 'viewer') return;
    const prev = a.relay;
    a.relay = msg.on ? clip(msg.dev, 40) || undefined : undefined;
    ws.serializeAttachment(a);
    if (prev && prev !== a.relay) this.updateRelayWant(prev);
    if (a.relay) this.updateRelayWant(a.relay);
  }

  private updateRelayWant(dev: string): void {
    const n = this.authed().filter((s) => s.a.mode === 'viewer' && s.a.relay === dev).length;
    this.broadcast({ t: 'relay_want', n }, (x) => x.mode === 'camera' && x.dev === dev);
  }

  // ---------------------------------------------------------------- push
  private async onPushSub(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    const sub = msg.sub as PushSubscriptionJSONLike | undefined;
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys?.p256dh || !sub.keys?.auth) return;
    if (!isAllowedPushEndpoint(sub.endpoint) || sub.endpoint.length > 1024) {
      return this.send(ws, { t: 'notice', text: 'This browser’s push service is not supported.' });
    }
    const p = (msg.prefs ?? {}) as Record<string, unknown>;
    const rec: PushRec = {
      sub: { endpoint: sub.endpoint, keys: { p256dh: clip(sub.keys.p256dh, 200), auth: clip(sub.keys.auth, 64) } },
      uid: a.uid!,
      name: a.name || 'Member',
      prefs: Object.fromEntries(
        PUSH_KINDS.map((k) => {
          const v = k === 'loud' && p.loud === undefined ? p.noise : p[k];
          return [k, typeof v === 'boolean' ? v : PUSH_DEFAULTS[k]];
        }),
      ),
      at: Date.now(),
    };
    const all = ((await this.state.storage.get<PushRec[]>('push')) ?? []).filter((r) => r.sub.endpoint !== rec.sub.endpoint);
    all.push(rec);
    await this.state.storage.put('push', all.slice(-PUSH_CAP));
    this.send(ws, { t: 'push_ok', prefs: rec.prefs });
  }

  private async onPushUnsub(a: Attach, msg: Record<string, unknown>): Promise<void> {
    const endpoint = String(msg.endpoint ?? '');
    const all = (await this.state.storage.get<PushRec[]>('push')) ?? [];
    // Only the owner of a subscription may remove it.
    await this.state.storage.put('push', all.filter((r) => !(r.sub.endpoint === endpoint && r.uid === a.uid)));
  }

  private async onPushTest(ws: WebSocket, a: Attach): Promise<void> {
    const keys = await this.vapidKeys();
    const mine = ((await this.state.storage.get<PushRec[]>('push')) ?? []).filter((r) => r.uid === a.uid);
    if (!keys || mine.length === 0) return this.send(ws, { t: 'notice', text: 'Turn on alerts on this device first.' });
    const nid = await this.state.storage.get<string>('nid');
    let sent = 0;
    for (const r of mine) {
      const out = await sendWebPush(r.sub, { title: 'Test alert', body: 'Baby monitor alerts are working on this device.', kind: 'test', nid, at: Date.now() }, keys, { subject: VAPID_SUBJECT, urgency: 'normal' });
      if (out === 'sent') sent++;
    }
    this.send(ws, { t: 'notice', text: sent ? 'Test alert sent — check your notifications.' : 'The push service rejected the test. Turn alerts off and on again.' });
  }

  /** Alert everyone who opted in, with per-kind cooldowns so a long cry doesn't spam. */
  private async pushAlert(kind: PushKind, note: { title: string; body: string; entryId: string }, dev?: string): Promise<void> {
    const now = Date.now();
    const key = `${kind}:${dev ?? '-'}`;
    const last = (await this.state.storage.get<Record<string, number>>('lastPush')) ?? {};
    const settings = await this.settings();
    const cooldown = kind === 'cry' ? settings.cryRepeatMin * 60_000 : PUSH_COOLDOWN_MS[kind] ?? 10 * 60_000;
    if (now - (last[key] ?? 0) < cooldown) return;
    last[key] = now;
    await this.state.storage.put('lastPush', last);

    const keys = await this.vapidKeys();
    const subs = (await this.state.storage.get<PushRec[]>('push')) ?? [];
    if (!keys || subs.length === 0) return;
    const nid = await this.state.storage.get<string>('nid');
    const payload = { title: note.title, body: note.body, kind, nid, ref: note.entryId, at: now };
    const gone = new Set<string>();
    await Promise.all(
      subs
        .filter((r) => r.prefs[kind] ?? (kind === 'loud' ? r.prefs.noise : undefined) ?? PUSH_DEFAULTS[kind])
        .map(async (r) => {
          const out = await sendWebPush(r.sub, payload, keys, {
            subject: VAPID_SUBJECT,
            urgency: PUSH_URGENT.has(kind) || kind === 'cough' || kind === 'crash' ? 'high' : 'normal',
            ttlSec: kind === 'cry' || kind === 'alarm' ? 300 : 1800,
            topic: `${kind}${(nid ?? '').slice(0, 8)}`,
          });
          if (out === 'gone') gone.add(r.sub.endpoint);
        }),
    );
    if (gone.size) await this.state.storage.put('push', subs.filter((r) => !gone.has(r.sub.endpoint)));
  }

  // ------------------------------------------------------------- settings
  private async settings(): Promise<Settings> {
    return { ...DEFAULT_SETTINGS, ...((await this.state.storage.get<Partial<Settings>>('settings')) ?? {}) };
  }

  private async onSettings(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role !== 'parent') return;
    const cur = await this.settings();
    if (msg.sensitivity === 'low' || msg.sensitivity === 'medium' || msg.sensitivity === 'high') cur.sensitivity = msg.sensitivity;
    if (msg.cryRepeatMin != null) cur.cryRepeatMin = Math.round(num(msg.cryRepeatMin, 1, 30, 3));
    await this.state.storage.put('settings', cur);
    this.broadcast({ t: 'settings', settings: cur });
  }

  /** A parent changed the member list: drop sockets of anyone removed. */
  private async onMembersChanged(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role !== 'parent') return;
    const token = clip(msg.token, 4096);
    const nid = await this.state.storage.get<string>('nid');
    if (!token || !nid) return;
    const res = await callRpc<{ ok?: boolean; ids?: string[] }>(this.env, token, 'monitor_member_ids', { p_nursery: nid });
    if (!res.ok || !res.data.ok || !Array.isArray(res.data.ids)) return;
    const ids = new Set(res.data.ids);
    for (const s of this.authed()) {
      if (s.a.uid && !ids.has(s.a.uid)) {
        this.send(s.ws, { t: 'error', code: 'removed', msg: 'You were removed from this nursery.' });
        try {
          s.ws.close(4004, 'removed');
        } catch { /* closed */ }
      }
    }
    await this.addLog({ kind: 'people', msg: `${a.name} updated who can access this nursery`, by: a.name });
    this.broadcast({ t: 'roles_changed' });
  }

  /** Panic button: end every viewing session but the parent's own. */
  private async onEndAll(a: Attach): Promise<void> {
    if (a.role !== 'parent') return;
    for (const s of this.authed()) {
      if (s.a.mode === 'viewer' && s.a.sid !== a.sid) {
        this.send(s.ws, { t: 'error', code: 'ended', msg: `${a.name} ended all viewing sessions.` });
        try {
          s.ws.close(4006, 'ended');
        } catch { /* closed */ }
      }
    }
    await this.addLog({ kind: 'people', msg: `${a.name} ended all other viewing sessions`, by: a.name });
  }

  // ------------------------------------------------------------------ log
  private async addLog(e: Omit<MonLog, 'id' | 'at'>): Promise<MonLog> {
    const entry: MonLog = { id: crypto.randomUUID().slice(0, 10), at: Date.now(), ...e, msg: clip(e.msg, 200) };
    const log = (await this.state.storage.get<MonLog[]>('log')) ?? [];
    log.push(entry);
    const cutoff = Date.now() - TL_KEEP_MS;
    const kept = log.filter((l) => l.at >= cutoff).slice(-LOG_CAP);
    await this.state.storage.put('log', kept);
    this.broadcast({ t: 'log', entry });
    return entry;
  }

  // ---------------------------------------------------------------- alarm
  private async ensureAlarm(inMs: number): Promise<void> {
    const cur = await this.state.storage.getAlarm();
    const want = Date.now() + inMs;
    if (cur == null || cur > want) await this.state.storage.setAlarm(want);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let again = false;

    // 1. Sockets that never authenticated are dropped.
    for (const { ws, a } of this.sockets()) {
      if (!a.authed) {
        if (now - a.at > AUTH_TIMEOUT_MS) {
          try {
            ws.close(4001, 'auth timeout');
          } catch { /* closed */ }
        } else again = true;
      }
    }

    // 2. Connected cameras that stopped heartbeating (phone locked, app frozen).
    const meta = (await this.state.storage.get<{ name: string; baby: string | null }>('meta')) ?? { name: 'Nursery', baby: null };
    for (const { a } of this.authed()) {
      if (a.mode !== 'camera' || !a.dev) continue;
      again = true;
      const beat = this.beats.get(a.dev);
      if (beat == null) {
        this.beats.set(a.dev, now); // evicted & rebuilt — start a fresh grace
        continue;
      }
      if (now - beat > BEAT_STALE_MS && !this.staleFlagged.has(a.dev)) {
        this.staleFlagged.add(a.dev);
        await this.state.storage.put(`alerted:${a.dev}`, true);
        const entry = await this.addLog({ kind: 'offline', msg: `${a.dn} stopped responding — check the camera phone`, dev: a.dev });
        await this.pushAlert('offline', { title: 'Baby camera not responding', body: `${meta.name} · ${a.dn} — the phone may be locked, asleep or off Wi-Fi`, entryId: entry.id }, a.dev);
      }
    }

    // 3. Cameras that dropped without saying goodbye.
    const pending = (await this.state.storage.get<Record<string, { at: number; dn: string }>>('pendingOffline')) ?? {};
    let changed = false;
    for (const [dev, p] of Object.entries(pending)) {
      const back = this.authed().some((s) => s.a.mode === 'camera' && s.a.dev === dev);
      if (back) {
        delete pending[dev];
        changed = true;
      } else if (now - p.at >= OFFLINE_GRACE_MS) {
        delete pending[dev];
        changed = true;
        await this.state.storage.put(`alerted:${dev}`, true);
        const entry = await this.addLog({ kind: 'offline', msg: `${p.dn} went offline`, dev });
        await this.pushAlert('offline', { title: 'Baby camera went offline', body: `${meta.name} · ${p.dn} disconnected — check its battery and Wi-Fi`, entryId: entry.id }, dev);
      } else again = true;
    }
    if (changed) await this.state.storage.put('pendingOffline', pending);

    if (this.curBucket) await this.saveBucket(this.curBucket);
    if (again) await this.state.storage.setAlarm(now + ALARM_MS);
  }
}
