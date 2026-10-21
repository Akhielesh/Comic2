/**
 * MonitorRoom — one Durable Object per nursery (Baby Monitor).
 *
 * NEVER RECORDS. Video and audio flow peer-to-peer between the baby's camera
 * device and the family's viewing devices (WebRTC, DTLS-SRTP encrypted end to
 * end). This room:
 *   - authenticates every socket against Supabase (the member's own bearer
 *     token → monitor_my_role) before it can see or send anything,
 *   - relays WebRTC signaling between members of THIS nursery,
 *   - fans out the camera's on-device analysis (state, sound level, motion,
 *     what it hears and sees) and keeps the nursery's history in its own
 *     SQLite database (monitorStore.ts): events, per-minute measurements,
 *     sleep sessions, incidents,
 *   - runs the alert engine: incidents that need a person are pushed to the
 *     right people, repeated or escalated until someone answers "I'm on it",
 *   - tracks sleep from the camera's minutes (sleepTracker.ts) and sends the
 *     morning report,
 *   - watches camera heartbeats and raises "camera offline" alerts,
 *   - forwards low-rate JPEG snapshots in memory when a network blocks P2P
 *     (relay mode). Frames are passed through, never stored.
 *
 * The singleton instance named KEY_HOLDER only stores the VAPID key pair.
 */

import { GuestAccess, LOCK_MS, passcodeProblem, type GuestRole } from './monitorGuests';
import { sanitizeTrack, TrackerStore, type TrackRow } from './trackerStore';
import { clockTime, isValidTz, localIso, localParts, MonitorStore, type IncidentRow, type MinuteRow, type Severity, type SleepRow, type StoredEvent } from './monitorStore';
import { endSession, manualSleep, manualWake, newSleepSm, sessionKind, stepSleep, type SleepEvent, type SleepSm, type SleepStats } from './sleepTracker';
import { callRpc, type SupabaseEnv } from './supabaseAuth';
import { generateVapidKeys, isAllowedPushEndpoint, sendWebPush, type PushSubscriptionJSONLike, type VapidKeys } from './webpush';

export const KEY_HOLDER = '__vapid_keys__';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type MonRole = 'parent' | 'caregiver' | 'viewer';
/** 'admin' = a parent's short-lived control connection (never in presence). */
export type MonMode = 'camera' | 'viewer' | 'admin';
export type BabyState = 'calm' | 'stirring' | 'awake' | 'noisy' | 'fussing' | 'crying';
const BABY_STATES: BabyState[] = ['calm', 'stirring', 'awake', 'noisy', 'fussing', 'crying'];

/** Background-alert categories a device can opt into (and their defaults). */
const PUSH_KINDS = ['cry', 'fuss', 'cough', 'alarm', 'glass', 'crash', 'zone', 'cat', 'loud', 'noise', 'camera', 'offline', 'battery', 'report', 'insight', 'guest'] as const;
export type PushKind = (typeof PUSH_KINDS)[number];
const PUSH_DEFAULTS: Record<PushKind, boolean> = {
  cry: true, fuss: false, cough: true, alarm: true, glass: true, crash: true, zone: true, cat: true,
  loud: false, noise: true, camera: true, offline: true, battery: true, report: true, insight: true, guest: true,
};

/**
 * Sound categories the camera's on-device detector reports (mirror of
 * live/monitor/soundClasses.ts). Unknown categories are ignored.
 */
export type SoundCat =
  | 'cry' | 'fuss' | 'cough' | 'sneeze' | 'snore' | 'hiccup' | 'babble' | 'laugh'
  | 'alarm' | 'glass' | 'crash' | 'loud' | 'voices' | 'music' | 'dog' | 'cat' | 'door' | 'footsteps' | 'water';
const SOUND: Record<SoundCat, { headline: string; sev: Severity; push: PushKind | null; gapMs: number; ends?: boolean; hazard?: HazardKind }> = {
  cry: { headline: '{baby} is crying', sev: 'urgent', push: 'cry', gapMs: 20_000, ends: true, hazard: 'cry' },
  fuss: { headline: '{baby} is fussing', sev: 'warn', push: 'fuss', gapMs: 60_000, ends: true },
  cough: { headline: '{baby} is coughing', sev: 'warn', push: 'cough', gapMs: 60_000 },
  sneeze: { headline: '{baby} sneezed', sev: 'info', push: null, gapMs: 2 * 60_000 },
  snore: { headline: 'Snoring or noisy breathing', sev: 'info', push: null, gapMs: 20 * 60_000 },
  hiccup: { headline: '{baby} has the hiccups', sev: 'info', push: null, gapMs: 15 * 60_000 },
  babble: { headline: '{baby} is awake and babbling', sev: 'info', push: null, gapMs: 10 * 60_000 },
  laugh: { headline: '{baby} is laughing', sev: 'info', push: null, gapMs: 10 * 60_000 },
  alarm: { headline: 'Alarm sounding in the nursery — check for smoke or CO', sev: 'urgent', push: 'alarm', gapMs: 30_000, hazard: 'alarm' },
  glass: { headline: 'Glass breaking in the nursery', sev: 'urgent', push: 'glass', gapMs: 60_000, hazard: 'glass' },
  crash: { headline: 'Loud bang or crash in the nursery', sev: 'warn', push: 'crash', gapMs: 60_000, hazard: 'crash' },
  loud: { headline: 'Loud sound in the nursery', sev: 'warn', push: 'loud', gapMs: 5 * 60_000 },
  voices: { headline: 'Someone is talking in the nursery', sev: 'info', push: null, gapMs: 15 * 60_000 },
  music: { headline: 'Music or TV playing in the nursery', sev: 'info', push: null, gapMs: 30 * 60_000 },
  dog: { headline: 'Dog barking near the nursery', sev: 'info', push: null, gapMs: 5 * 60_000 },
  cat: { headline: 'A cat is in or near the nursery', sev: 'warn', push: 'cat', gapMs: 10 * 60_000 },
  door: { headline: 'Knocking at the nursery door', sev: 'info', push: null, gapMs: 2 * 60_000 },
  footsteps: { headline: 'Footsteps in the nursery', sev: 'info', push: null, gapMs: 5 * 60_000 },
  water: { headline: 'Water running nearby', sev: 'info', push: null, gapMs: 10 * 60_000 },
};
const isSoundCat = (v: unknown): v is SoundCat => typeof v === 'string' && v in SOUND;

/** What the camera's vision reports (mirror of live/monitor/vision.ts). */
type VisionType = 'zone' | 'crib_out' | 'visit_start' | 'visit_end' | 'lights_on' | 'lights_off' | 'dark' | 'moved';
const VISION_TYPES: VisionType[] = ['zone', 'crib_out', 'visit_start', 'visit_end', 'lights_on', 'lights_off', 'dark', 'moved'];

/**
 * Alerts that need a person. `everyone`: all devices at once; otherwise the
 * person on duty first. `repeatMs`: push again until acknowledged;
 * `escalateMs`: one more push to everyone if nobody answered.
 */
export type HazardKind = 'alarm' | 'glass' | 'crash' | 'zone' | 'crib_out' | 'cry' | 'very_loud' | 'moved' | 'paused' | 'offline';
const HAZARD: Record<HazardKind, { push: PushKind; everyone: boolean; repeatMs?: number; escalateMs?: number; maxPushes: number; staleMs: number }> = {
  alarm: { push: 'alarm', everyone: true, repeatMs: 60_000, maxPushes: 10, staleMs: 60 * 60_000 },
  glass: { push: 'glass', everyone: true, escalateMs: 3 * 60_000, maxPushes: 2, staleMs: 60 * 60_000 },
  crash: { push: 'crash', everyone: false, escalateMs: 5 * 60_000, maxPushes: 2, staleMs: 60 * 60_000 },
  zone: { push: 'zone', everyone: true, repeatMs: 2 * 60_000, maxPushes: 5, staleMs: 30 * 60_000 },
  crib_out: { push: 'zone', everyone: true, repeatMs: 2 * 60_000, maxPushes: 5, staleMs: 30 * 60_000 },
  cry: { push: 'cry', everyone: false, maxPushes: 4, staleMs: 2 * 60 * 60_000 },
  very_loud: { push: 'noise', everyone: true, maxPushes: 1, staleMs: 30 * 60_000 },
  moved: { push: 'camera', everyone: false, escalateMs: 10 * 60_000, maxPushes: 2, staleMs: 2 * 60 * 60_000 },
  paused: { push: 'camera', everyone: true, escalateMs: 10 * 60_000, maxPushes: 2, staleMs: 6 * 60 * 60_000 },
  offline: { push: 'offline', everyone: true, escalateMs: 10 * 60_000, maxPushes: 2, staleMs: 6 * 60 * 60_000 },
};

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
  /** Joined with the share link + passcode (no account): the guest's id. */
  guest?: string;
}

export interface SplStatus {
  /** Fast A-weighted level now, dB. */
  db: number;
  /** Leq over the last second, dB. */
  leq: number;
  /** Fast max over the last second, dB. */
  max: number;
  /** The phone's meter has been calibrated. */
  cal: boolean;
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
  paused: 'privacy' | 'interrupted' | 'hidden' | null;
  /** How the camera keeps its screen on; 'none' = it may lock and pause the video. */
  awake: 'native' | 'video' | 'none' | null;
  talk: string | null;
  call: string | null;
  /** Sound level meter (A-weighted dB), null if the phone can't measure. */
  spl: SplStatus | null;
  /** Movement in the crib zone / outside it (null without a crib zone). */
  crib: number | null;
  outside: number | null;
  /** An adult is in the room right now. */
  visit: boolean;
}

/** A log line as clients see it. */
export interface MonLog {
  id: string;
  at: number;
  kind: string;
  sev: Severity;
  msg: string;
  by?: string;
  dev?: string;
  secs?: number;
  conf?: number;
  db?: number;
  incident?: string;
}

interface PushRec {
  sub: PushSubscriptionJSONLike;
  uid: string;
  name: string;
  /** Role when subscribed (parents-only notices, e.g. a new guest). */
  role?: MonRole;
  prefs: Record<string, boolean>;
  at: number;
}

export interface Zone {
  id: string;
  kind: 'crib' | 'danger';
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Settings {
  sensitivity: 'low' | 'medium' | 'high';
  /** Minutes between repeated cry pushes once a cry has escalated. */
  cryRepeatMin: number;
  /** Minutes of crying with nobody answering before everyone is alerted. */
  cryEscalateMin: number;
  /** "Loud" threshold for the sound meter, dB(A); null = off. */
  noiseDb: number | null;
  /** Warn when a steady sound (white-noise machine) averages over 50 dB for an hour. */
  machineCheck: boolean;
  sleepTracking: boolean;
  /** Zones per camera device. */
  zones: Record<string, Zone[]>;
  /** The nursery's time zone (from its camera phone). */
  tz: string;
  /** The baby, for the tracker's age-based guidance (wake windows, growth percentiles). */
  baby?: { birth: string | null; sex: 'f' | 'm' | null };
}

interface Duty {
  uid: string;
  name: string;
  until: number;
}

const DEFAULT_SETTINGS: Settings = {
  sensitivity: 'medium', cryRepeatMin: 3, cryEscalateMin: 5, noiseDb: 70, machineCheck: true, sleepTracking: true, zones: {}, tz: 'UTC',
};
const AUTH_TIMEOUT_MS = 10_000;
const ALARM_MS = 15_000;
const BEAT_STALE_MS = 45_000;
const OFFLINE_GRACE_MS = 20_000;
const LOG_HELLO = 150;
const TL_BUCKET_MS = 5 * 60_000;
const TL_KEEP_MS = 7 * 24 * 60 * 60_000;
const MAX_SOCKETS = 14;
const MAX_CAMERAS = 4;
const PUSH_CAP = 40;
const FRAME_MAX = 8 * 1024;
const RTC_FRAME_MAX = 64 * 1024;
const SNAPSHOT_MAX = 256 * 1024;
const SNAPSHOT_MIN_GAP_MS = 250;
const PURGE_EVERY_MS = 6 * 60 * 60_000;
const MACHINE_DB = 50;
const MACHINE_GAP_MS = 12 * 60 * 60_000;
const STATE_RANK: Record<BabyState, number> = { calm: 1, stirring: 2, awake: 2, noisy: 3, fussing: 4, crying: 5 };
const PUSH_COOLDOWN_MS: Record<string, number> = {
  alarm: 60_000, glass: 2 * 60_000, zone: 2 * 60_000, fuss: 10 * 60_000, cough: 10 * 60_000, crash: 10 * 60_000, cat: 15 * 60_000,
  loud: 10 * 60_000, noise: 10 * 60_000, camera: 10 * 60_000, offline: 5 * 60_000, battery: 30 * 60_000, insight: 6 * 60 * 60_000, guest: 0,
};
const PUSH_URGENT = new Set<PushKind>(['cry', 'alarm', 'glass', 'zone', 'offline', 'noise']);
const STUN = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const VAPID_SUBJECT = 'https://dreamstreamstudio.ai';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const clip = (s: unknown, n: number) => String(s ?? '').trim().slice(0, n);
const num = (v: unknown, lo: number, hi: number, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const numOrNull = (v: unknown, lo: number, hi: number) => (v == null || !Number.isFinite(Number(v)) ? null : num(v, lo, hi));
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const dur = (secs: number) => (secs >= 3600 ? `${Math.floor(secs / 3600)} h ${Math.round((secs % 3600) / 60)} min` : secs >= 60 ? `${Math.round(secs / 60)} min` : `${secs}s`);
const hm = (mins: number) => (mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`);

/** Severity of the log kinds the room writes itself. */
const KIND_SEV: Record<string, Severity> = {
  cry_end: 'info', fuss_end: 'info', noise: 'warn', motion: 'info', offline: 'warn', online: 'info', battery: 'warn', privacy: 'info', call: 'info',
  feed: 'care', diaper: 'care', sleep: 'care', wake: 'care', note: 'care', ack: 'care', soothe: 'care', camera: 'info', people: 'info',
  paused: 'warn', zone: 'urgent', crib_out: 'urgent', visit_start: 'info', visit_end: 'info', lights_on: 'info', lights_off: 'info', dark: 'warn', moved: 'warn',
  very_loud: 'warn', loud_db: 'warn', machine: 'warn', asleep: 'care', woke: 'care', resettled: 'care', sleep_report: 'care', duty: 'info', resolved: 'info',
};

export function sanitizeZones(v: unknown): Zone[] {
  if (!Array.isArray(v)) return [];
  const out: Zone[] = [];
  for (const z of v.slice(0, 6)) {
    if (!z || typeof z !== 'object') continue;
    const r = z as Record<string, unknown>;
    const id = clip(r.id, 12).replace(/[^a-z0-9]/gi, '');
    const kind = r.kind === 'crib' ? 'crib' : r.kind === 'danger' ? 'danger' : null;
    if (!id || !kind) continue;
    const x = num(r.x, 0, 1);
    const y = num(r.y, 0, 1);
    const w = num(r.w, 0, 1 - x);
    const h = num(r.h, 0, 1 - y);
    if (w < 0.02 || h < 0.02) continue;
    out.push({ id, kind, name: clip(r.name, 30) || (kind === 'crib' ? 'Crib' : 'Danger zone'), x, y, w, h });
  }
  // One crib per camera.
  let crib = false;
  return out.filter((z) => (z.kind === 'crib' ? !crib && (crib = true) : true));
}

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
  readonly store: MonitorStore;
  readonly guests: GuestAccess;
  readonly tracker: TrackerStore;
  readonly ready: Promise<void>;

  constructor(private state: DurableObjectState, private env: MonEnv) {
    this.store = new MonitorStore(state.storage.sql);
    this.guests = new GuestAccess(state.storage.sql);
    this.tracker = new TrackerStore(state.storage.sql);
    this.ready = state.blockConcurrencyWhile(() => this.migrate());
  }

  /** Create the tables; move the pre-database log (a KV array) into them once. */
  private async migrate(): Promise<void> {
    this.store.init();
    const old = await this.state.storage.get<{ id: string; at: number; kind: string; msg: string; by?: string; dev?: string; secs?: number; conf?: number }[]>('log');
    if (old?.length) {
      for (const e of old) {
        this.store.addEvent({ id: e.id, at: e.at, kind: e.kind, sev: this.sevOf(e.kind), msg: e.msg, by: e.by ?? null, dev: e.dev ?? null, secs: e.secs ?? null, conf: e.conf ?? null });
      }
    }
    if (old) await this.state.storage.delete('log');
  }

  private sevOf(kind: string): Severity {
    return isSoundCat(kind) ? SOUND[kind].sev : KIND_SEV[kind] ?? 'info';
  }

  // ------------------------------------------------------------------ HTTP
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/vapid') return this.handleVapid();
    if (url.pathname === '/ws') return this.handleUpgrade(req, url);
    if (url.pathname === '/export') return this.handleExport(req, url);
    if (url.pathname === '/guest' && req.method === 'POST') return this.handleGuestJoin(req, url);
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

  /** CSV download for parents and caregivers (the member's own token decides). */
  private async handleExport(req: Request, url: URL): Promise<Response> {
    // Header only — tokens never ride in URLs (they end up in logs).
    const token = clip((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), 4096);
    const nid = await this.state.storage.get<string>('nid');
    if (!token || !nid) return json({ error: 'sign in' }, 401);
    const res = await callRpc<{ ok?: boolean; role?: MonRole }>(this.env, token, 'monitor_my_role', { p_nursery: nid });
    if (!res.ok) return json({ error: 'sign in' }, res.status === 401 ? 401 : 502);
    if (!res.data.ok || (res.data.role !== 'parent' && res.data.role !== 'caregiver')) return json({ error: 'forbidden' }, 403);
    const what = url.searchParams.get('what');
    const kind = what === 'minutes' || what === 'sleep' || what === 'track' ? what : 'events';
    // An absent parameter is "default", never 0 (Number(null) === 0).
    const param = (k: string) => url.searchParams.get(k) || undefined;
    const now = Date.now();
    const to = Math.min(now, num(param('to'), 0, now + 60_000, now));
    const from = num(param('from'), to - 90 * 24 * 60 * 60_000, to, to - 7 * 24 * 60 * 60_000);
    const settings = await this.settings();
    const meta = await this.meta();
    const csv = kind === 'track' ? this.tracker.csv(from, to + 1, (t) => localIso(t, settings.tz)) : this.store.csv(kind, from, to + 1, settings.tz);
    const slug = (meta.name || 'nursery').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'nursery';
    return new Response(`﻿${csv}\r\n`, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${slug}-${kind}-${new Date(to).toISOString().slice(0, 10)}.csv"`,
        'cache-control': 'no-store',
      },
    });
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
    const viewers: { sid: string; name: string; label: string | null; role: MonRole; dn: string; relay: boolean; guest?: boolean }[] = [];
    for (const { a } of this.authed()) {
      if (a.mode === 'camera' && a.dev) {
        const ls = this.lastStatus.get(a.dev);
        cams.push({ sid: a.sid, dev: a.dev, dn: a.dn || 'Camera', by: a.name || 'Member', since: a.at, status: ls?.st ?? null, statusAt: ls?.at ?? null });
      } else if (a.mode === 'viewer') {
        viewers.push({ sid: a.sid, name: a.name || 'Member', label: a.label ?? null, role: a.role || 'viewer', dn: a.dn || 'Device', relay: !!a.relay, ...(a.guest ? { guest: true } : {}) });
      }
    }
    return { cams, viewers };
  }

  private syncPresence(): void {
    this.broadcast({ t: 'presence', ...this.presence() });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.ready;
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
    const big = msg.t === 'rtc' || msg.t === 'auth' || msg.t === 'push_sub' || msg.t === 'stats' || msg.t === 'settings';
    if (!big && raw.length > FRAME_MAX) return;

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
      case 'stats':
        return this.onStats(ws, a, msg);
      case 'log':
        return this.onLog(a, msg);
      case 'ack':
        return this.onAck(a, msg);
      case 'resolve':
        return this.onResolve(a, msg);
      case 'duty':
        return this.onDuty(a, msg);
      case 'cmd':
        return this.onCmd(a, msg);
      case 'tell':
        return this.onTell(a, msg);
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
      case 'q':
        return this.onQuery(ws, msg);
      case 'track_put':
        return this.onTrackPut(ws, a, msg);
      case 'track_del':
        return this.onTrackDel(a, msg);
      case 'sleep_delete':
        return this.onSleepDelete(a, msg);
      case 'members_changed':
        return this.onMembersChanged(a, msg);
      case 'share_set':
        return this.onShareSet(ws, a, msg);
      case 'share_off':
        return this.onShareOff(a);
      case 'guest_remove':
        return this.onGuestRemove(a, msg);
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
    await this.ready;
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
    if (typeof msg.guest === 'string') return this.onGuestAuth(ws, a, msg);
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
    const meta = { name: res.data.nursery_name || 'Nursery', baby: res.data.baby_name || null };
    await this.state.storage.put('meta', meta);
    return this.admit(ws, a, mode, msg, meta);
  }

  /** A guest's socket: the token from the share-link join, checked by this room. */
  private async onGuestAuth(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (msg.mode !== 'viewer') return this.reject(ws, 'forbidden', 'Guests can watch, but not run a camera or manage the nursery.');
    const g = await this.guests.verify(clip(msg.guest, 100), Date.now());
    if (!g) return this.reject(ws, 'removed', 'This guest pass has ended — ask a parent for the link and passcode again.');
    a.authed = true;
    a.uid = `g:${g.id}`;
    a.name = clip(g.name, 40);
    a.role = g.role;
    a.label = null;
    a.guest = g.id;
    return this.admit(ws, a, 'viewer', msg, await this.meta());
  }

  /** Common to members and guests once they're verified. */
  private async admit(ws: WebSocket, a: Attach, mode: MonMode, msg: Record<string, unknown>, meta: { name: string; baby: string | null }): Promise<void> {
    const nid = (await this.state.storage.get<string>('nid')) || '';
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

    // The camera phone knows the nursery's time zone (reports, night vs nap).
    let settings = await this.settings();
    if (mode === 'camera' && isValidTz(msg.tz) && msg.tz !== settings.tz) {
      settings = { ...settings, tz: msg.tz };
      await this.state.storage.put('settings', settings);
    }

    const [tl, ice, vapid, duty, sleep] = await Promise.all([this.timeline(), this.iceServers(), this.vapidKeys(), this.duty(), this.sleepStatus()]);
    this.send(ws, {
      t: 'hello',
      you: { sid: a.sid, uid: a.uid, name: a.name, role: a.role, label: a.label, mode, dev: a.dev, ...(a.guest ? { guest: true } : {}) },
      nursery: { id: nid, ...meta },
      ...this.presence(),
      log: this.store.events({ limit: LOG_HELLO }).reverse().map(toLog),
      tl,
      settings,
      incidents: this.store.activeIncidents(),
      track: { running: this.tracker.running(), latest: this.tracker.latest() },
      duty,
      sleep,
      ice,
      vapid: vapid?.publicKey ?? null,
    });
    if (a.role === 'parent') this.send(ws, { t: 'share', share: this.guests.info(Date.now()) });

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
        await this.resolveHazard('offline', a.dev, 'back online');
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

  private async meta(): Promise<{ name: string; baby: string | null }> {
    return (await this.state.storage.get<{ name: string; baby: string | null }>('meta')) ?? { name: 'Nursery', baby: null };
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
    const spl = s.spl && typeof s.spl === 'object' ? (s.spl as Record<string, unknown>) : null;
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
      paused: s.paused === 'privacy' || s.paused === 'interrupted' || s.paused === 'hidden' ? s.paused : null,
      awake: s.awake === 'native' || s.awake === 'video' || s.awake === 'none' ? s.awake : null,
      talk: s.talk ? clip(s.talk, 80) : null,
      call: s.call ? clip(s.call, 60) : null,
      spl: spl
        ? { db: Math.round(num(spl.db, 0, 140) * 10) / 10, leq: Math.round(num(spl.leq, 0, 140) * 10) / 10, max: Math.round(num(spl.max, 0, 140) * 10) / 10, cal: Boolean(spl.cal) }
        : null,
      crib: s.crib == null ? null : Math.round(num(s.crib, 0, 100)),
      outside: s.outside == null ? null : Math.round(num(s.outside, 0, 100)),
      visit: Boolean(s.visit),
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

  // ------------------------------------------------------- camera events
  private async onCamEvent(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.mode !== 'camera' || !a.dev) return;
    const kind = String(msg.kind ?? '');
    const meta = await this.meta();
    const who = meta.baby || 'Baby';
    const where = a.dn || 'Camera';
    if (kind === 'sound') return this.onSoundEvent(a, msg, meta, who, where);
    if (kind === 'vision') return this.onVisionEvent(a, msg, meta, who, where);
    if (kind === 'noise') return this.onNoiseEvent(a, msg, meta, where);
    if (kind === 'paused') {
      // The camera page went to the background or the phone locked: the video stops.
      const entry = await this.addLog({ kind: 'paused', msg: `${where}’s screen locked or the app was left — video paused`, dev: a.dev });
      return this.raiseHazard('paused', entry, { title: 'Baby camera video paused', body: `${meta.name} · ${where} locked its screen or left Stream Studio — sound may continue, but open the app on that phone`, entryId: entry.id }, a.dev);
    }
    if (kind === 'resumed') {
      const open = this.store.openIncident('paused', a.dev);
      if (open) await this.addLog({ kind: 'online', msg: `${where} is back — video resumed`, dev: a.dev });
      return this.resolveHazard('paused', a.dev, 'back');
    }
    if (kind === 'privacy') {
      await this.addLog({ kind: 'privacy', msg: msg.on ? `Video paused for privacy on ${where} — sound monitoring continues` : `Video resumed on ${where}`, dev: a.dev });
      return;
    }
    if (kind === 'cry') {
      // Older camera builds (pre-AI): same as a sound event.
      return this.onSoundEvent(a, { cat: 'cry', phase: 'start' }, meta, who, where);
    } else if (kind === 'cry_end') {
      return this.onSoundEvent(a, { cat: 'cry', phase: 'end', secs: msg.secs }, meta, who, where);
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
      await this.addLog({ kind: cat === 'cry' ? 'cry_end' : 'fuss_end', msg: `${who} settled${secs ? ` after ${dur(secs)} of ${cat === 'cry' ? 'crying' : 'fussing'}` : ''}`, dev: a.dev, secs });
      if (cat === 'cry') await this.resolveHazard('cry', a.dev, `settled after ${dur(secs)}`);
      return;
    }
    // A misbehaving camera can't flood the log or everyone's phones.
    const key = `${a.dev}:${cat}`;
    const now = Date.now();
    if (now - (this.lastSoundAt.get(key) ?? 0) < info.gapMs) return;
    this.lastSoundAt.set(key, now);
    const title = info.headline.replace('{baby}', who);
    const extra = cat === 'alarm' && (msg.pattern === 'T3' || msg.pattern === 'T4') ? ` (${msg.pattern === 'T3' ? 'smoke-alarm' : 'CO-alarm'} beep pattern)` : '';
    const entry = await this.addLog({ kind: cat, msg: `${title}${extra} · ${where}`, dev: a.dev, conf });
    const note = { title, body: `${meta.name} · ${where} — tap to check in`, entryId: entry.id };
    if (info.hazard) await this.raiseHazard(info.hazard, entry, note, a.dev);
    else if (info.push) await this.pushAlert(info.push, note, a.dev, { audience: 'duty' });
  }

  /** On-device vision: zones, climb-outs, visits, lights, camera moved (see live/monitor/vision.ts). */
  private async onVisionEvent(a: Attach, msg: Record<string, unknown>, meta: { name: string; baby: string | null }, who: string, where: string): Promise<void> {
    if (!a.dev) return;
    const type = VISION_TYPES.includes(msg.type as VisionType) ? (msg.type as VisionType) : null;
    if (!type) return;
    const now = Date.now();
    const key = `${a.dev}:v:${type}:${clip(msg.zone, 12)}`;
    if (now - (this.lastSoundAt.get(key) ?? 0) < (type === 'visit_end' || type === 'visit_start' ? 20_000 : 60_000)) return;
    this.lastSoundAt.set(key, now);
    const settings = await this.settings();
    const zone = (settings.zones[a.dev] ?? []).find((z) => z.id === clip(msg.zone, 12));
    const zoneName = zone?.name || clip(msg.name, 30) || 'a danger zone';
    switch (type) {
      case 'zone': {
        const title = `Movement in ${zoneName}`;
        const entry = await this.addLog({ kind: 'zone', msg: `${title} · ${where}`, dev: a.dev });
        return this.raiseHazard('zone', entry, { title, body: `${meta.name} · ${where} — check on ${who} now`, entryId: entry.id }, a.dev);
      }
      case 'crib_out': {
        const title = `Movement outside the crib — ${who} may be climbing out`;
        const entry = await this.addLog({ kind: 'crib_out', msg: `${title} · ${where}`, dev: a.dev });
        return this.raiseHazard('crib_out', entry, { title, body: `${meta.name} · ${where} — check on ${who} now`, entryId: entry.id }, a.dev);
      }
      case 'moved': {
        const title = 'Camera was moved — check it still sees the crib';
        const entry = await this.addLog({ kind: 'moved', msg: `${title} · ${where}${msg.via === 'tilt' ? ' (the phone tilted)' : ''}`, dev: a.dev });
        return this.raiseHazard('moved', entry, { title: 'Baby camera was moved', body: `${meta.name} · ${where} may have fallen or been knocked — check it can still see ${who}`, entryId: entry.id }, a.dev);
      }
      case 'dark':
        await this.addLog({ kind: 'dark', msg: `Camera can’t see — the room is completely dark or the lens is covered · ${where}`, dev: a.dev });
        return;
      case 'visit_start':
        await this.addLog({ kind: 'visit_start', msg: `Someone came into the nursery · ${where}`, dev: a.dev });
        return;
      case 'visit_end': {
        const secs = Math.round(num(msg.secs, 0, 4 * 3600));
        await this.addLog({ kind: 'visit_end', msg: `Visit ended${secs ? ` after ${dur(secs)}` : ''} · ${where}`, dev: a.dev, secs });
        return;
      }
      case 'lights_on':
      case 'lights_off':
        await this.addLog({ kind: type, msg: `Lights turned ${type === 'lights_on' ? 'on' : 'off'} · ${where}`, dev: a.dev });
        return;
    }
  }

  /** Sound-meter episodes from the camera (see NoiseGuard in live/monitor/soundLevel.ts). */
  private async onNoiseEvent(a: Attach, msg: Record<string, unknown>, meta: { name: string; baby: string | null }, where: string): Promise<void> {
    if (!a.dev) return;
    const type = msg.type === 'very_loud' ? 'very_loud' : msg.type === 'loud' ? 'loud' : null;
    if (!type) return;
    const db = Math.round(num(msg.db, 0, 140));
    const cal = Boolean(msg.cal);
    const approx = cal ? '' : '≈';
    if (msg.phase === 'end') {
      const secs = Math.round(num(msg.secs, 0, 4 * 3600));
      if (type === 'very_loud') await this.resolveHazard('very_loud', a.dev, `quiet again after ${dur(secs)}`);
      return;
    }
    const now = Date.now();
    const key = `${a.dev}:n:${type}`;
    if (now - (this.lastSoundAt.get(key) ?? 0) < (type === 'very_loud' ? 60_000 : 5 * 60_000)) return;
    this.lastSoundAt.set(key, now);
    if (type === 'very_loud') {
      const title = `Very loud noise in the nursery (${approx}${db} dB)`;
      const entry = await this.addLog({ kind: 'very_loud', msg: `${title} · ${where}`, dev: a.dev, db });
      return this.raiseHazard('very_loud', entry, { title, body: `${meta.name} · ${where} — loud enough to be harmful with exposure`, entryId: entry.id }, a.dev);
    }
    const settings = await this.settings();
    const title = `Noise above ${settings.noiseDb ?? 70} dB (${approx}${db} dB)`;
    const entry = await this.addLog({ kind: 'loud_db', msg: `${title} · ${where}`, dev: a.dev, db });
    await this.pushAlert('loud', { title, body: `${meta.name} · ${where}`, entryId: entry.id }, a.dev, { audience: 'duty' });
  }

  // --------------------------------------------------------- minute stats
  /** The camera's per-minute measurements (batched while it was offline). */
  private async onStats(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.mode !== 'camera' || !a.dev || !Array.isArray(msg.rows)) return;
    const now = Date.now();
    const rows: MinuteRow[] = [];
    for (const r of (msg.rows as unknown[]).slice(0, 240)) {
      if (!r || typeof r !== 'object') continue;
      const x = r as Record<string, unknown>;
      const m = Math.floor(Number(x.m) / 60_000) * 60_000;
      if (!Number.isFinite(m) || m > now + 2 * 60_000 || m < now - 6 * 60 * 60_000) continue;
      const sounds: Record<string, number> = {};
      if (x.sounds && typeof x.sounds === 'object') {
        for (const [k, v] of Object.entries(x.sounds as Record<string, unknown>)) if (isSoundCat(k)) sounds[k] = Math.round(num(v, 0, 60));
      }
      rows.push({
        dev: a.dev, m,
        laeq: numOrNull(x.laeq, 0, 140), lmax: numOrNull(x.lmax, 0, 140), l10: numOrNull(x.l10, 0, 140), l50: numOrNull(x.l50, 0, 140), l90: numOrNull(x.l90, 0, 140), lpk: numOrNull(x.lpk, 0, 160),
        cal: x.cal ? 1 : 0,
        motion: numOrNull(x.motion, 0, 100), mmax: numOrNull(x.mmax, 0, 100), crib: numOrNull(x.crib, 0, 100), outside: numOrNull(x.outside, 0, 100), light: numOrNull(x.light, 0, 255),
        state: numOrNull(x.state, 1, 5), sounds, visit: x.visit ? 1 : 0,
      });
    }
    rows.sort((p, q) => p.m - q.m);
    for (const r of rows) this.store.putMinute(r);
    if (rows.length) {
      this.send(ws, { t: 'stats_ok', upto: rows[rows.length - 1].m });
      this.broadcast({ t: 'minutes', rows }, (x) => x.mode === 'viewer');
      await this.afterMinutes(a.dev, rows);
    }
  }

  /** Sleep tracking + the sound-machine check run on the nursery's main camera. */
  private async afterMinutes(dev: string, rows: MinuteRow[]): Promise<void> {
    const settings = await this.settings();
    let sleepDev = await this.state.storage.get<{ dev: string; at: number }>('sleepDev');
    const last = rows[rows.length - 1].m;
    if (!sleepDev || sleepDev.dev === dev || last - sleepDev.at > 10 * 60_000) sleepDev = { dev, at: last };
    if (sleepDev.dev !== dev) return;
    await this.state.storage.put('sleepDev', sleepDev);

    if (settings.sleepTracking) {
      const sm = (await this.state.storage.get<SleepSm>('sleepSm')) ?? newSleepSm();
      const events: SleepEvent[] = [];
      for (const r of rows) events.push(...stepSleep(sm, { m: r.m, state: r.state, motion: r.motion, crib: r.crib, sounds: r.sounds, visit: r.visit }, newId));
      await this.state.storage.put('sleepSm', sm);
      await this.onSleepEvents(events);
    }
    if (settings.machineCheck) await this.machineCheck(dev, last);
  }

  private async onSleepEvents(events: SleepEvent[]): Promise<void> {
    if (!events.length) return;
    const meta = await this.meta();
    const settings = await this.settings();
    const who = meta.baby || 'Baby';
    for (const e of events) {
      switch (e.type) {
        case 'started':
          this.store.putSleep({ id: e.session, start: e.at, end: null, onset: null, kind: 'night', source: e.source, asleep_min: 0, awake_min: 0, wakings: 0, longest_min: 0, cry_min: 0, laeq: null, summary: null });
          break;
        case 'asleep':
          await this.addLog({ kind: 'asleep', msg: `${who} fell asleep at ${clockTime(e.at, settings.tz)}`, at: e.at });
          break;
        case 'woke':
          await this.addLog({ kind: 'woke', msg: `${who} woke up at ${clockTime(e.at, settings.tz)}`, at: e.at });
          break;
        case 'resettled':
          await this.addLog({ kind: 'resettled', msg: `${who} went back to sleep after ${hm(e.mins)} awake`, at: e.at });
          break;
        case 'ended':
          await this.finishSleep(e.session, e.end, e.discarded, e.stats);
          break;
      }
    }
    this.broadcast({ t: 'sleep', sleep: await this.sleepStatus() });
  }

  /** Close a session: summarise it, log it, and send the morning report for nights. */
  private async finishSleep(id: string, end: number, discarded: boolean, s: SleepStats): Promise<void> {
    const row = this.store.sleep(id);
    if (!row) return;
    if (discarded) {
      this.store.putSleep({ ...row, end, summary: { discarded: true } });
      return;
    }
    const settings = await this.settings();
    const meta = await this.meta();
    const summary = this.summarise(row.start, end);
    const kind = sessionKind(localParts(row.start, settings.tz).h, s.asleepMin);
    const final: SleepRow = {
      ...row, end, onset: row.onset ?? s.onset ?? row.start, kind, source: s.source,
      asleep_min: s.asleepMin, awake_min: s.awakeMin, wakings: s.wakings.length, longest_min: s.longest, cry_min: s.cryMin,
      laeq: summary.laeq, summary: { ...summary, wakeups: s.wakings },
    };
    this.store.putSleep(final);
    const who = meta.baby || 'Baby';
    const headline = `${who} slept ${hm(s.asleepMin)}${s.wakings.length ? ` · woke ${s.wakings.length}×` : ' straight through'}`;
    const entry = await this.addLog({ kind: 'sleep_report', msg: `${kind === 'night' ? 'Night' : 'Nap'} report: ${headline}`, at: end, meta: { session: id } });
    if (kind === 'night') {
      await this.pushAlert('report', { title: `Good morning — ${headline}`, body: `${meta.name} · longest stretch ${hm(s.longest)}${summary.laeq != null ? ` · room averaged ${Math.round(summary.laeq)} dB` : ''} — tap for the full report`, entryId: entry.id });
    }
  }

  /** Room conditions and notable events in a window. */
  private summarise(from: number, to: number): { laeq: number | null; l90: number | null; peak: number | null; light: number | null; counts: Record<string, number>; visits: number; noisyMin: number } {
    const rows = this.store.minutes(from, to);
    const vals = (k: keyof MinuteRow) => rows.map((r) => r[k] as number | null).filter((v): v is number => v != null);
    const energy = (xs: number[]) => (xs.length ? 10 * Math.log10(xs.reduce((a, d) => a + 10 ** (d / 10), 0) / xs.length) : null);
    const laeq = energy(vals('laeq'));
    const l90s = vals('l90');
    const tally = this.store.tally(from, to);
    const counts: Record<string, number> = {};
    for (const k of ['cry', 'fuss', 'cough', 'sneeze', 'snore', 'hiccup', 'alarm', 'glass', 'crash', 'zone', 'crib_out', 'very_loud', 'loud_db', 'lights_on', 'cat', 'dog']) if (tally[k]?.n) counts[k] = tally[k].n;
    return {
      laeq: laeq == null ? null : Math.round(laeq * 10) / 10,
      l90: l90s.length ? Math.round((l90s.reduce((a, b) => a + b, 0) / l90s.length) * 10) / 10 : null,
      peak: vals('lmax').length ? Math.max(...vals('lmax')) : null,
      light: vals('light').length ? Math.round(vals('light').reduce((a, b) => a + b, 0) / vals('light').length) : null,
      counts,
      visits: tally.visit_start?.n ?? 0,
      noisyMin: rows.filter((r) => (r.laeq ?? 0) >= 60).length,
    };
  }

  /**
   * Infant sleep machines often run louder than the 50 dB(A) hospital-nursery
   * limit (Hugh et al., Pediatrics 2014). A steady hour above it earns a nudge.
   */
  private async machineCheck(dev: string, last: number): Promise<void> {
    const prevAt = (await this.state.storage.get<number>('machineAt')) ?? 0;
    if (last - prevAt < MACHINE_GAP_MS) return;
    const rows = this.store.minutes(last - 59 * 60_000, last + 60_000, dev).filter((r) => r.laeq != null && r.l10 != null && r.l90 != null);
    if (rows.length < 50) return;
    const leq = 10 * Math.log10(rows.reduce((a, r) => a + 10 ** (r.laeq! / 10), 0) / rows.length);
    const spread = rows.reduce((a, r) => a + (r.l10! - r.l90!), 0) / rows.length;
    if (leq < MACHINE_DB || spread > 8) return;
    await this.state.storage.put('machineAt', last);
    const cal = rows.filter((r) => r.cal).length > rows.length / 2;
    const db = Math.round(leq);
    const title = cal ? `Sound machine may be too loud (${db} dB for the last hour)` : `Sound machine may be too loud (≈${db} dB for the last hour)`;
    const body = `Steady sound in the nursery averaged ${cal ? '' : 'about '}${db} dB — above the 50 dB guideline for infant sleep. Move it farther from the crib (2 m / 6½ ft or more) or turn it down.${cal ? '' : ' Calibrate the camera’s sound meter to confirm.'}`;
    const entry = await this.addLog({ kind: 'machine', msg: `${title} — move it farther from the crib or turn it down`, dev, db, sev: cal ? 'warn' : 'info' });
    await this.pushAlert('insight', { title, body, entryId: entry.id }, dev);
  }

  private async sleepStatus(): Promise<{ phase: SleepSm['phase']; since: number | null; session: string | null; asleepMin: number; wakings: number; last: SleepRow | null }> {
    const sm = (await this.state.storage.get<SleepSm>('sleepSm')) ?? newSleepSm();
    const since = sm.phase === 'awake' ? sm.awakeSince : sm.phase === 'asleep' ? sm.quietSince ?? sm.onset : sm.phase === 'settling' ? sm.start : null;
    return { phase: sm.phase, since, session: sm.session, asleepMin: sm.asleepMin, wakings: sm.wakings.length, last: this.store.lastSleep(1)[0] ?? null };
  }

  // ------------------------------------------------------------ incidents
  /** Open (or join) an incident and alert people about it. */
  private async raiseHazard(kind: HazardKind, entry: MonLog, note: { title: string; body: string; entryId: string }, dev: string): Promise<void> {
    const h = HAZARD[kind];
    const now = Date.now();
    const settings = await this.settings();
    let inc = this.store.openIncident(kind, dev);
    if (inc && inc.status === 'acked' && now - (inc.ack_at ?? 0) > 10 * 60_000) {
      // Answered a while ago and happening again: that's a new incident.
      this.store.updateIncident(inc.id, { status: 'resolved', resolved_at: now });
      this.broadcast({ t: 'incident', inc: { ...inc, status: 'resolved', resolved_at: now } });
      inc = null;
    }
    if (inc) {
      this.store.setEventIncident(entry.id, inc.id);
      return;
    }
    const escalate = kind === 'cry' ? settings.cryEscalateMin * 60_000 : h.repeatMs ?? h.escalateMs;
    const row: IncidentRow = {
      id: newId(), at: now, kind, sev: entry.sev, title: note.title, dev, status: 'open',
      ack_by: null, ack_at: null, resolved_at: null, pushes: 1, next_at: escalate != null ? now + escalate : null,
    };
    this.store.addIncident(row);
    this.store.setEventIncident(entry.id, row.id);
    this.broadcast({ t: 'incident', inc: row });
    await this.pushAlert(h.push, note, dev, { audience: h.everyone ? 'all' : 'duty', incident: row.id });
    if (row.next_at) await this.ensureAlarm(row.next_at - now);
  }

  private async resolveHazard(kind: HazardKind, dev: string, why: string): Promise<void> {
    const inc = this.store.openIncident(kind, dev);
    if (!inc) return;
    const now = Date.now();
    this.store.updateIncident(inc.id, { status: 'resolved', resolved_at: now, next_at: null });
    this.broadcast({ t: 'incident', inc: { ...inc, status: 'resolved', resolved_at: now, next_at: null }, why });
  }

  /** Re-alert incidents nobody has answered; tidy up stale ones. */
  private async escalate(now: number): Promise<void> {
    const settings = await this.settings();
    const meta = await this.meta();
    const who = meta.baby || 'Baby';
    for (const inc of this.store.dueIncidents(now)) {
      const h = HAZARD[inc.kind as HazardKind];
      if (!h) continue;
      const mins = Math.max(1, Math.round((now - inc.at) / 60_000));
      const title =
        inc.kind === 'cry' ? `${who} has been crying for ${mins} min — no one has responded`
        : inc.kind === 'alarm' ? `Alarm still sounding in ${meta.name} — no one has responded`
        : `Still no response: ${inc.title}`;
      const entry = await this.addLog({ kind: 'escalated', msg: title, dev: inc.dev ?? undefined, sev: inc.sev, incident: inc.id });
      await this.pushAlert(h.push, { title, body: `${meta.name} — tap “I’m on it” when someone is checking`, entryId: entry.id }, inc.dev ?? undefined, { audience: 'all', incident: inc.id, force: true });
      const pushes = inc.pushes + 1;
      const repeat = inc.kind === 'cry' ? settings.cryRepeatMin * 60_000 : h.repeatMs;
      const next = pushes < h.maxPushes && repeat ? now + repeat : null;
      this.store.updateIncident(inc.id, { pushes, next_at: next });
      this.broadcast({ t: 'incident', inc: { ...inc, pushes, next_at: next } });
    }
    for (const inc of this.store.activeIncidents()) {
      const h = HAZARD[inc.kind as HazardKind];
      const stale = inc.status === 'acked' ? now - (inc.ack_at ?? inc.at) > 30 * 60_000 : now - inc.at > (h?.staleMs ?? 60 * 60_000);
      if (stale) {
        this.store.updateIncident(inc.id, { status: 'resolved', resolved_at: now, next_at: null });
        this.broadcast({ t: 'incident', inc: { ...inc, status: 'resolved', resolved_at: now, next_at: null } });
      }
    }
  }

  // ---------------------------------------------------------- family acts
  private async onLog(a: Attach, msg: Record<string, unknown>): Promise<void> {
    const kinds = ['feed', 'diaper', 'sleep', 'wake', 'note'] as const;
    const kind = kinds.includes(msg.kind as (typeof kinds)[number]) ? (msg.kind as (typeof kinds)[number]) : null;
    if (!kind) return;
    const label = { feed: 'Fed', diaper: 'Diaper change', sleep: 'Down for sleep', wake: 'Woke up', note: 'Note' }[kind];
    const text = clip(msg.text, 160);
    await this.addLog({ kind, msg: text ? `${label} — ${text}` : label, by: a.label ? `${a.name} (${a.label})` : a.name });
    // "Down for sleep" / "Woke up" steer the sleep tracker.
    if (kind === 'sleep' || kind === 'wake') {
      const sm = (await this.state.storage.get<SleepSm>('sleepSm')) ?? newSleepSm();
      const now = Date.now();
      const events = kind === 'sleep' ? manualSleep(sm, now, newId()) : manualWake(sm, now);
      await this.state.storage.put('sleepSm', sm);
      await this.onSleepEvents(events);
    }
  }

  // ------------------------------------------------------------ tracker
  /** Add or edit a tracker entry (feeds, diapers, sleep…) — parents and caregivers, guests included. */
  private async onTrackPut(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role === 'viewer') return this.send(ws, { t: 'track_err', id: clip((msg.item as Record<string, unknown> | undefined)?.id, 40), msg: 'Viewers can see the tracker but not log — ask a parent to make you a caregiver.' });
    const now = Date.now();
    const who = { name: a.label ? `${a.name} (${a.label})` : a.name || 'Someone', uid: a.uid || a.sid };
    const r = sanitizeTrack((msg.item ?? {}) as Record<string, unknown>, who, now);
    if (!r.ok) return this.send(ws, { t: 'track_err', id: clip((msg.item as Record<string, unknown> | undefined)?.id, 40), msg: r.error });
    const before = this.tracker.get(r.row.id);
    const saved = this.tracker.put(r.row);
    if (!saved) return this.send(ws, { t: 'track_del', id: r.row.id });
    this.broadcast({ t: 'track', item: saved });
    await this.trackLog(saved, before, a);
  }

  private async onTrackDel(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role === 'viewer') return;
    const id = clip(msg.id, 40);
    if (id && this.tracker.delete(id, Date.now())) this.broadcast({ t: 'track_del', id });
  }

  /** One line in the activity log when something is logged or a timer stops — and sleep steers the sleep tracker. */
  private async trackLog(row: TrackRow, before: TrackRow | null, a: Attach): Promise<void> {
    const started = !before;
    const stopped = !!before && before.end == null && row.end != null;
    if (!started && !stopped) return;
    const d = row.data as Record<string, number | string | boolean | undefined>;
    const mins = row.end != null ? Math.max(1, Math.round((row.end - row.start) / 60_000)) : 0;
    const by = a.label ? `${a.name} (${a.label})` : a.name;
    let kind = 'note';
    let text: string | null = null;
    switch (row.kind) {
      case 'bottle':
        kind = 'feed';
        text = `Bottle · ${d.ml} ml${d.milk === 'breast' ? ' breast milk' : d.milk === 'formula' ? ' formula' : ''}`;
        break;
      case 'breast':
        if (row.end == null) return;
        kind = 'feed';
        text = `Breastfed ${mins} min${d.left || d.right ? ` (L ${Math.round(Number(d.left ?? 0) / 60)} · R ${Math.round(Number(d.right ?? 0) / 60)})` : ''}`;
        break;
      case 'solids':
        kind = 'feed';
        text = `Solids${d.foods ? ` · ${d.foods}` : ''}`;
        break;
      case 'diaper':
        kind = 'diaper';
        text = `Diaper · ${d.pee && d.poo ? 'wet + dirty' : d.poo ? 'dirty' : d.pee ? 'wet' : 'dry'}`;
        break;
      case 'sleep':
        kind = row.end == null ? 'sleep' : 'wake';
        text = row.end == null ? 'Down for sleep' : `Woke up after ${dur(mins * 60)}`;
        if (started && row.end != null) text = `Slept ${dur(mins * 60)}`;
        break;
      case 'pump':
        if (row.end == null) return;
        text = `Pumped ${Number(d.mlLeft ?? 0) + Number(d.mlRight ?? 0)} ml`;
        break;
      case 'med':
        text = `Gave ${d.name}${d.dose ? ` ${d.dose} ${d.unit ?? ''}`.trimEnd() : ''}`;
        break;
      case 'temp':
        text = `Temperature ${d.c} °C${d.method ? ` (${d.method})` : ''}`;
        break;
      case 'growth':
        text = `Measured${d.kg ? ` · ${d.kg} kg` : ''}${d.cm ? ` · ${d.cm} cm` : ''}${d.headCm ? ` · head ${d.headCm} cm` : ''}`;
        break;
      case 'activity':
        if (row.end == null) return;
        text = `${{ tummy: 'Tummy time', bath: 'Bath', play: 'Play', outdoor: 'Outside', reading: 'Reading', skin: 'Skin-to-skin' }[String(d.type)] ?? 'Activity'} · ${mins} min`;
        break;
      case 'note':
        text = d.note ? `Note — ${String(d.note).slice(0, 140)}` : null;
        break;
    }
    if (!text) return;
    await this.addLog({ kind, msg: text, by, sev: 'care' });
    // The sleep timer is the same thing as "Down for sleep" / "Woke up" for the camera's sleep tracker.
    if (row.kind === 'sleep' && row.start > Date.now() - 10 * 60_000) {
      const sm = (await this.state.storage.get<SleepSm>('sleepSm')) ?? newSleepSm();
      const events = row.end == null ? manualSleep(sm, Date.now(), newId()) : stopped ? manualWake(sm, Date.now()) : [];
      if (events.length) {
        await this.state.storage.put('sleepSm', sm);
        await this.onSleepEvents(events);
      }
    }
  }

  /** "I'm on it" — tells everyone someone is checking; answers the incident. */
  private async onAck(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role === 'viewer') return;
    const ref = clip(msg.id, 20);
    const now = Date.now();
    const incId = clip(msg.inc, 20) || (ref ? this.store.getEvent(ref)?.incident : null) || null;
    const inc = incId ? this.store.incident(incId) : null;
    const who = a.label || a.name || 'Someone';
    let line = `${who} is checking on it`;
    if (inc && inc.status === 'open') {
      const secs = Math.round((now - inc.at) / 1000);
      this.store.updateIncident(inc.id, { status: 'acked', ack_by: who, ack_at: now, next_at: null });
      this.broadcast({ t: 'incident', inc: { ...inc, status: 'acked', ack_by: who, ack_at: now, next_at: null } });
      line = `${who} is checking on it — responded in ${dur(secs)}`;
    }
    await this.addLog({ kind: 'ack', msg: line, by: a.name, dev: ref || undefined, incident: inc?.id });
    this.broadcast({ t: 'ack', ref, inc: inc?.id ?? null, by: a.name, label: a.label ?? null, at: now });
  }

  /** "All clear" — a parent/caregiver closes an incident. */
  private async onResolve(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role === 'viewer') return;
    const inc = this.store.incident(clip(msg.inc, 20));
    if (!inc || inc.status === 'resolved') return;
    const now = Date.now();
    this.store.updateIncident(inc.id, { status: 'resolved', resolved_at: now, next_at: null, ack_by: inc.ack_by ?? (a.label || a.name || null), ack_at: inc.ack_at ?? now });
    this.broadcast({ t: 'incident', inc: { ...inc, status: 'resolved', resolved_at: now, next_at: null } });
    await this.addLog({ kind: 'resolved', msg: `${a.label || a.name} marked “${inc.title}” all clear`, by: a.name, incident: inc.id });
  }

  private async duty(): Promise<Duty | null> {
    const d = await this.state.storage.get<Duty>('duty');
    return d && d.until > Date.now() ? d : null;
  }

  /** "On duty": routine alerts go to this person first; hazards still reach everyone. */
  private async onDuty(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role === 'viewer' || !a.uid) return;
    const cur = await this.duty();
    const who = a.label || a.name || 'Someone';
    if (msg.on) {
      const hours = Math.round(num(msg.hours, 1, 24, 12));
      const d: Duty = { uid: a.uid, name: who, until: Date.now() + hours * 60 * 60_000 };
      await this.state.storage.put('duty', d);
      await this.addLog({ kind: 'duty', msg: `${who} is on duty for the next ${hours} h — routine alerts go to them first`, by: a.name });
      this.broadcast({ t: 'duty', duty: d });
    } else if (cur && (cur.uid === a.uid || a.role === 'parent')) {
      await this.state.storage.delete('duty');
      await this.addLog({ kind: 'duty', msg: `${who} ended ${cur.uid === a.uid ? 'their' : `${cur.name}’s`} duty — alerts go to everyone`, by: a.name });
      this.broadcast({ t: 'duty', duty: null });
    }
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

  /** Camera → one viewer: "your voice is too loud here" / "feedback — you're near the camera". */
  private onTell(a: Attach, msg: Record<string, unknown>): void {
    if (a.mode !== 'camera') return;
    const c = msg.c === 'feedback' || msg.c === 'talk_gain' ? msg.c : null;
    const to = clip(msg.to, 20);
    if (!c || !to) return;
    const v = (msg.v ?? {}) as Record<string, unknown>;
    const safe = c === 'talk_gain' ? { factor: num(v.factor, 0.3, 1, 1), db: Math.round(num(v.db, 0, 140)) } : { freq: Math.round(num(v.freq, 0, 20_000)) };
    for (const s of this.authed()) {
      if (s.a.sid === to && s.a.mode === 'viewer') return this.send(s.ws, { t: 'tell', c, v: safe, from: a.sid });
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

  // -------------------------------------------------------------- queries
  /** History, log pages, sleep and reports for the family's screens. */
  private async onQuery(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const id = clip(msg.id, 20);
    const q = String(msg.q ?? '');
    const now = Date.now();
    const reply = (data: Record<string, unknown>) => this.send(ws, { t: 'r', id, q, ...data });
    if (q === 'history') {
      const to = Math.min(now + 60_000, num(msg.to, 0, now + 60_000, now));
      const from = num(msg.from, to - 7 * 24 * 60 * 60_000, to, to - 6 * 60 * 60_000);
      return reply({ from, to, ...historyBuckets(this.store.minutes(from, to, msg.dev ? clip(msg.dev, 40) : undefined), from, to) });
    }
    if (q === 'events') {
      const kinds = Array.isArray(msg.kinds) ? (msg.kinds as unknown[]).map((k) => clip(k, 20)).filter(Boolean).slice(0, 30) : undefined;
      const limit = Math.round(num(msg.limit, 1, 200, 80));
      const rows = this.store.events({ before: msg.before == null ? undefined : num(msg.before, 0, now + 1), limit: limit + 1, kinds }).map(toLog);
      return reply({ rows: rows.slice(0, limit), more: rows.length > limit });
    }
    if (q === 'track') {
      // The tracker's log for a window, with the camera's automatic sleep sessions alongside.
      const to = num(msg.to, 0, now + 24 * 60 * 60_000, now + 60_000);
      const from = num(msg.from, to - 400 * 24 * 60 * 60_000, to, to - 2 * 24 * 60 * 60_000);
      const auto: TrackRow[] = this.store
        .sleepBetween(from, to)
        .filter((x) => !x.summary?.discarded && x.onset != null)
        .map((x) => ({ id: `ms-${x.id}`, kind: 'sleep', start: x.onset ?? x.start, end: x.end, by: 'Camera', by_uid: 'camera', data: { where: 'crib', wakings: x.wakings }, src: 'monitor', updated: x.end ?? now }));
      return reply({ from, to, items: this.tracker.range(from, to), auto, settings: { tz: (await this.settings()).tz, baby: (await this.settings()).baby ?? null } });
    }
    if (q === 'track_sync') {
      return reply({ items: this.tracker.changedSince(num(msg.since, 0, now, 0)), now });
    }
    if (q === 'sleep') {
      const days = Math.round(num(msg.days, 1, 60, 14));
      return reply({ sessions: this.store.sleepBetween(now - days * 24 * 60 * 60_000, now + 1).filter((s) => !s.summary?.discarded), status: await this.sleepStatus(), tz: (await this.settings()).tz });
    }
    if (q === 'report') {
      const sid = clip(msg.session, 20);
      const row = sid ? this.store.sleep(sid) : this.store.lastSleep(1, 'night')[0] ?? null;
      if (!row) return reply({ report: null });
      const end = row.end ?? now;
      const minutes = this.store.minutes(row.start, end + 60_000);
      const incidents = this.store.incidentsBetween(row.start, end).filter((i) => i.ack_at);
      return reply({
        report: {
          ...row,
          ...historyBuckets(minutes, row.start, end + 60_000, 5 * 60_000),
          events: this.store.eventsBetween(row.start, end + 60_000).filter((e) => e.sev !== 'info' || e.kind === 'visit_start').map(toLog).slice(0, 300),
          response: incidents.length ? Math.round(incidents.reduce((s, i) => s + ((i.ack_at ?? i.at) - i.at), 0) / incidents.length / 1000) : null,
        },
        tz: (await this.settings()).tz,
      });
    }
    if (q === 'weeks') {
      return reply({ days: this.weeks(now, (await this.settings()).tz, Math.round(num(msg.days, 7, 28, 14))) });
    }
    if (q === 'day') {
      // Today (in the nursery's zone) at a glance.
      const settings = await this.settings();
      const p = localParts(now, settings.tz);
      const sinceMidnight = (p.h * 60 + p.mi) * 60_000;
      const from = now - sinceMidnight;
      const t = this.store.tally(from, now + 1);
      const sessions = this.store.sleepBetween(from, now + 1).filter((s) => !s.summary?.discarded);
      const sleepMin = sessions.reduce((acc, s) => acc + s.asleep_min, 0);
      return reply({ from, tally: t, sleepMin, naps: sessions.filter((s) => s.kind === 'nap').length, summary: this.summarise(from, now + 1) });
    }
  }

  /**
   * What the monitor measured, per local day (oldest first, today last and
   * partial): sleep the camera saw, night wakings, crying, alerts and how
   * fast someone answered, and the sound level while the baby slept.
   */
  weeks(now: number, tz: string, days = 14): {
    day: number; sleepMin: number; nightMin: number; naps: number; wakings: number; longestMin: number;
    cryMin: number; cries: number; alerts: number; responseSec: number | null; sleepLaeq: number | null; loud: number;
  }[] {
    const p = localParts(now, tz);
    const today = now - (p.h * 60 + p.mi) * 60_000 - (now % 60_000);
    const sessions = this.store.sleepBetween(today - days * 86_400_000, now + 1).filter((x) => !x.summary?.discarded);
    const out = [];
    for (let k = days - 1; k >= 0; k--) {
      const from = today - k * 86_400_000;
      const to = k === 0 ? now + 1 : from + 86_400_000;
      const mine = sessions.filter((x) => x.start >= from && x.start < to);
      const nights = mine.filter((x) => x.kind === 'night');
      const t = this.store.tally(from, to);
      const inc = this.store.incidentsBetween(from, to);
      const answered = inc.filter((i) => i.ack_at != null);
      // Energy-average LAeq over the minutes the baby was asleep.
      let e = 0;
      let n = 0;
      for (const x of mine) {
        for (const m of this.store.minutes(x.onset ?? x.start, x.end ?? to)) {
          if (m.laeq == null) continue;
          e += 10 ** (m.laeq / 10);
          n++;
        }
      }
      out.push({
        day: from,
        sleepMin: mine.reduce((a, x) => a + x.asleep_min, 0),
        nightMin: nights.reduce((a, x) => a + x.asleep_min, 0),
        naps: mine.filter((x) => x.kind === 'nap').length,
        wakings: nights.reduce((a, x) => a + x.wakings, 0),
        longestMin: mine.reduce((a, x) => Math.max(a, x.longest_min), 0),
        cryMin: Math.round((t.cry_end?.secs ?? 0) / 60),
        cries: t.cry?.n ?? 0,
        alerts: inc.length,
        responseSec: answered.length ? Math.round(answered.reduce((a, i) => a + (i.ack_at! - i.at), 0) / answered.length / 1000) : null,
        sleepLaeq: n ? Math.round(10 * Math.log10(e / n) * 10) / 10 : null,
        loud: (t.very_loud?.n ?? 0) + (t.loud_db?.n ?? 0),
      });
    }
    return out;
  }

  private async onSleepDelete(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role !== 'parent') return;
    const row = this.store.sleep(clip(msg.session, 20));
    if (!row || row.end == null) return;
    this.store.putSleep({ ...row, summary: { ...(row.summary ?? {}), discarded: true, by: a.name } });
    await this.addLog({ kind: 'note', msg: `${a.label || a.name} removed a ${row.kind} from the sleep history`, by: a.name, sev: 'info' });
    this.broadcast({ t: 'sleep', sleep: await this.sleepStatus() });
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
      role: a.role,
      prefs: Object.fromEntries(
        PUSH_KINDS.map((k) => {
          // Life-safety alerts can't be switched off.
          if (k === 'alarm') return [k, true];
          // Older apps sent "noise" for what is now "loud" (and had no "very loud").
          const legacy = p.loud === undefined;
          const v = legacy && k === 'loud' ? p.noise : legacy && k === 'noise' ? undefined : p[k];
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

  /**
   * Alert the people who opted in. `audience: 'duty'` reaches only the person
   * on duty (when someone is); `force` skips the per-kind cooldown (escalations).
   */
  private async pushAlert(kind: PushKind, note: { title: string; body: string; entryId: string }, dev?: string, opts: { audience?: 'all' | 'duty' | 'parents'; incident?: string; force?: boolean } = {}): Promise<void> {
    const now = Date.now();
    const key = `${kind}:${dev ?? '-'}`;
    const last = (await this.state.storage.get<Record<string, number>>('lastPush')) ?? {};
    const settings = await this.settings();
    const cooldown = kind === 'cry' ? settings.cryRepeatMin * 60_000 : kind === 'report' ? 0 : PUSH_COOLDOWN_MS[kind] ?? 10 * 60_000;
    if (!opts.force && now - (last[key] ?? 0) < cooldown) return;
    last[key] = now;
    await this.state.storage.put('lastPush', last);

    const keys = await this.vapidKeys();
    const subs = (await this.state.storage.get<PushRec[]>('push')) ?? [];
    if (!keys || subs.length === 0) return;
    const duty = opts.audience === 'duty' ? await this.duty() : null;
    const nid = await this.state.storage.get<string>('nid');
    const payload = { title: note.title, body: note.body, kind, nid, ref: note.entryId, inc: opts.incident ?? null, at: now };
    const gone = new Set<string>();
    await Promise.all(
      subs
        .filter((r) => (kind === 'alarm' ? true : r.prefs[kind] ?? PUSH_DEFAULTS[kind]))
        .filter((r) => !duty || r.uid === duty.uid)
        .filter((r) => opts.audience !== 'parents' || r.role === 'parent' || r.role === undefined)
        .map(async (r) => {
          const out = await sendWebPush(r.sub, payload, keys, {
            subject: VAPID_SUBJECT,
            urgency: PUSH_URGENT.has(kind) || kind === 'cough' || kind === 'crash' ? 'high' : 'normal',
            ttlSec: kind === 'cry' || kind === 'alarm' || kind === 'zone' ? 300 : kind === 'report' ? 6 * 3600 : 1800,
            topic: `${kind}${(nid ?? '').slice(0, 8)}`,
          });
          if (out === 'gone') gone.add(r.sub.endpoint);
        }),
    );
    if (gone.size) await this.state.storage.put('push', subs.filter((r) => !gone.has(r.sub.endpoint)));
  }

  // ------------------------------------------------------------- settings
  private async settings(): Promise<Settings> {
    const s = { ...DEFAULT_SETTINGS, ...((await this.state.storage.get<Partial<Settings>>('settings')) ?? {}) };
    return { ...s, zones: s.zones ?? {} };
  }

  /** Nursery-wide settings. Parents change everything; caregivers can place zones. */
  private async onSettings(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role === 'viewer') return;
    const cur = await this.settings();
    const parent = a.role === 'parent';
    if (parent) {
      if (msg.sensitivity === 'low' || msg.sensitivity === 'medium' || msg.sensitivity === 'high') cur.sensitivity = msg.sensitivity;
      if (msg.cryRepeatMin != null) cur.cryRepeatMin = Math.round(num(msg.cryRepeatMin, 1, 30, 3));
      if (msg.cryEscalateMin != null) cur.cryEscalateMin = Math.round(num(msg.cryEscalateMin, 1, 30, 5));
      if (msg.noiseDb === null) cur.noiseDb = null;
      else if (msg.noiseDb != null) cur.noiseDb = Math.round(num(msg.noiseDb, 45, 100, 70));
      if (typeof msg.machineCheck === 'boolean') cur.machineCheck = msg.machineCheck;
      if (typeof msg.sleepTracking === 'boolean') cur.sleepTracking = msg.sleepTracking;
      if (msg.baby && typeof msg.baby === 'object') {
        const b = msg.baby as Record<string, unknown>;
        const birth = typeof b.birth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.birth) && Date.parse(b.birth) <= Date.now() && Date.parse(b.birth) > Date.now() - 6 * 366 * 86400_000 ? b.birth : null;
        cur.baby = { birth, sex: b.sex === 'f' || b.sex === 'm' ? b.sex : null };
      }
    }
    if (msg.zones && typeof msg.zones === 'object' && typeof (msg.zones as Record<string, unknown>).dev === 'string') {
      const z = msg.zones as { dev: string; list: unknown };
      const dev = clip(z.dev, 40);
      if (dev) {
        const list = sanitizeZones(z.list);
        const next = { ...cur.zones, [dev]: list };
        // Keep zones for at most 6 cameras.
        cur.zones = Object.fromEntries(Object.entries(next).slice(-6));
        await this.addLog({ kind: 'note', msg: `${a.label || a.name} ${list.length ? `set ${list.length} zone${list.length === 1 ? '' : 's'}` : 'cleared the zones'} on a camera`, by: a.name, sev: 'info' });
      }
    }
    await this.state.storage.put('settings', cur);
    this.broadcast({ t: 'settings', settings: cur });
  }

  // ------------------------------------------------------------- guests
  /** Someone opened the share link and typed the passcode. */
  private async handleGuestJoin(req: Request, url: URL): Promise<Response> {
    const nid = await this.state.storage.get<string>('nid');
    if (!nid || url.searchParams.get('nid') !== nid) return json({ ok: false, reason: 'bad_link' }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ ok: false, reason: 'bad_link' }, 400);
    }
    const now = Date.now();
    const r = await this.guests.join(
      { code: clip(body.code, 64), pass: String(body.pass ?? '').slice(0, 200), name: String(body.name ?? ''), dev: clip(body.dev, 40), ip: req.headers.get('cf-connecting-ip') || undefined },
      now,
    );
    const meta = await this.meta();
    if (r.ok) {
      const entry = await this.addLog({ kind: 'people', msg: `${r.guest.name} joined as a guest with the share link`, by: r.guest.name });
      await this.pushAlert('guest', { title: `${r.guest.name} is now a guest of ${meta.name}`, body: 'They joined with the share link and passcode. Remove them any time in Watch → People.', entryId: entry.id }, undefined, { audience: 'parents', force: true });
      this.sendShareInfo();
      return json({ ok: true, token: r.token, guest: { name: r.guest.name, role: r.guest.role, until: r.guest.expires_at }, nursery: meta });
    }
    if (r.disabled) {
      const entry = await this.addLog({ kind: 'people', sev: 'warn', msg: 'The share link was turned off after too many wrong passcodes — guests were signed out' });
      await this.pushAlert('guest', { title: `Share link for ${meta.name} turned off`, body: 'Someone kept entering the wrong passcode. Make a new link and passcode if you still want to share.', entryId: entry.id }, undefined, { audience: 'parents', force: true });
      this.kickGuests(null);
      this.sendShareInfo();
    } else if (r.reason === 'locked' && r.retryAt === now + LOCK_MS) {
      const entry = await this.addLog({ kind: 'people', sev: 'warn', msg: 'Wrong passcode entered 5 times — the share link is locked for 15 minutes' });
      await this.pushAlert('guest', { title: `Wrong passcodes for ${meta.name}`, body: 'The share link is locked for 15 minutes. If this wasn’t someone you invited, turn the link off.', entryId: entry.id }, undefined, { audience: 'parents', force: true });
      this.sendShareInfo();
    }
    const status = r.reason === 'bad_link' ? 404 : r.reason === 'slow_down' || r.reason === 'locked' ? 429 : r.reason === 'wrong' || r.reason === 'name' ? 401 : 410;
    return json({ ok: false, reason: r.reason, retryAt: r.retryAt ?? null, left: r.left ?? null }, status);
  }

  private async onShareSet(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role !== 'parent' || a.guest) return;
    const pass = String(msg.pass ?? '');
    const meta = await this.meta();
    const problem = passcodeProblem(pass, [meta.baby, meta.name]);
    if (problem) return this.send(ws, { t: 'share_err', msg: problem });
    const role: GuestRole = msg.role === 'caregiver' ? 'caregiver' : 'viewer';
    const days = msg.days === 1 || msg.days === 7 || msg.days === 30 ? msg.days : null;
    const { removed } = await this.guests.createShare({ pass, role, days, by: a.name || 'A parent' }, Date.now());
    this.kickGuests(removed);
    await this.addLog({ kind: 'people', msg: `${a.name} made a new share link (${role === 'caregiver' ? 'watch, talk & answer alerts' : 'watch & listen'}${days ? `, ${days} day${days > 1 ? 's' : ''}` : ''})`, by: a.name });
    this.sendShareInfo();
  }

  private async onShareOff(a: Attach): Promise<void> {
    if (a.role !== 'parent' || a.guest) return;
    const removed = this.guests.revokeShare(Date.now());
    this.kickGuests(removed);
    await this.addLog({ kind: 'people', msg: `${a.name} turned the share link off${removed.length ? ` and signed out ${removed.length} guest${removed.length > 1 ? 's' : ''}` : ''}`, by: a.name });
    this.sendShareInfo();
  }

  private async onGuestRemove(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role !== 'parent' || a.guest) return;
    const id = clip(msg.id, 20);
    const g = this.guests.guests(Date.now()).find((x) => x.id === id);
    if (!g || !this.guests.removeGuest(id, Date.now())) return;
    this.kickGuests([id]);
    await this.addLog({ kind: 'people', msg: `${a.name} removed guest ${g.name}`, by: a.name });
    this.sendShareInfo();
  }

  /** Close removed guests' sockets and forget their phones (null = every guest). */
  private kickGuests(ids: string[] | null): void {
    const set = ids ? new Set(ids) : null;
    for (const s of this.authed()) {
      if (s.a.guest && (!set || set.has(s.a.guest))) {
        this.send(s.ws, { t: 'error', code: 'removed', msg: 'Your guest pass for this nursery has ended.' });
        try {
          s.ws.close(4004, 'removed');
        } catch { /* closed */ }
      }
    }
    if (set && set.size === 0) return;
    void (async () => {
      const subs = (await this.state.storage.get<PushRec[]>('push')) ?? [];
      const keep = subs.filter((r) => !r.uid.startsWith('g:') || (set != null && !set.has(r.uid.slice(2))));
      if (keep.length !== subs.length) await this.state.storage.put('push', keep);
    })();
  }

  private sendShareInfo(): void {
    const info = this.guests.info(Date.now());
    for (const s of this.authed()) if (s.a.role === 'parent' && !s.a.guest) this.send(s.ws, { t: 'share', share: info });
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
      // Guests aren't Supabase members; their access is the share link's.
      if (s.a.uid && !s.a.guest && !ids.has(s.a.uid)) {
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
  private async addLog(e: { kind: string; msg: string; by?: string; dev?: string; secs?: number; conf?: number; db?: number; sev?: Severity; incident?: string; at?: number; meta?: Record<string, unknown> }): Promise<MonLog> {
    const row: StoredEvent = {
      id: newId().slice(0, 10),
      at: e.at ?? Date.now(),
      kind: e.kind,
      sev: e.sev ?? this.sevOf(e.kind),
      msg: clip(e.msg, 240),
      by: e.by ?? null,
      dev: e.dev ?? null,
      secs: e.secs ?? null,
      conf: e.conf ?? null,
      db: e.db ?? null,
      incident: e.incident ?? null,
      meta: e.meta ?? null,
    };
    this.store.addEvent(row);
    const entry = toLog(row);
    this.broadcast({ t: 'log', entry });
    return entry;
  }

  // ---------------------------------------------------------------- alarm
  private async ensureAlarm(inMs: number): Promise<void> {
    const cur = await this.state.storage.getAlarm();
    const want = Date.now() + Math.max(1000, inMs);
    if (cur == null || cur > want) await this.state.storage.setAlarm(want);
  }

  async alarm(): Promise<void> {
    await this.ready;
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
    const meta = await this.meta();
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
        await this.raiseHazard('offline', entry, { title: 'Baby camera not responding', body: `${meta.name} · ${a.dn} — the phone may be locked, asleep or off Wi-Fi`, entryId: entry.id }, a.dev);
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
        await this.raiseHazard('offline', entry, { title: 'Baby camera went offline', body: `${meta.name} · ${p.dn} disconnected — check its battery and Wi-Fi`, entryId: entry.id }, dev);
      } else again = true;
    }
    if (changed) await this.state.storage.put('pendingOffline', pending);

    // 4. Incidents nobody answered.
    await this.escalate(now);

    // 5. A sleep session whose camera went away for good.
    const sm = await this.state.storage.get<SleepSm>('sleepSm');
    if (sm?.session && sm.lastM != null && now - sm.lastM > 45 * 60_000) {
      const events = endSession(sm, sm.lastM + 60_000);
      await this.state.storage.put('sleepSm', sm);
      await this.onSleepEvents(events);
    }

    // 6. Retention.
    const purgedAt = (await this.state.storage.get<number>('purgedAt')) ?? 0;
    if (now - purgedAt > PURGE_EVERY_MS) {
      this.store.purge(now);
      this.guests.purge(now);
      this.tracker.purge(now);
      await this.state.storage.put('purgedAt', now);
    }

    if (this.curBucket) await this.saveBucket(this.curBucket);
    // Next wake-up: cameras need heartbeat checks, incidents need escalation,
    // an open sleep session needs closing if its camera never comes back.
    let want: number | null = again ? now + ALARM_MS : null;
    const nextInc = this.store.nextIncidentAt();
    if (nextInc != null) want = Math.min(want ?? Infinity, Math.max(now + 1000, nextInc));
    const open = await this.state.storage.get<SleepSm>('sleepSm');
    if (open?.session) want = Math.min(want ?? Infinity, now + 15 * 60_000);
    if (want != null) await this.state.storage.setAlarm(want);
  }
}

function toLog(e: StoredEvent): MonLog {
  const out: MonLog = { id: e.id, at: e.at, kind: e.kind, sev: e.sev, msg: e.msg };
  if (e.by) out.by = e.by;
  if (e.dev) out.dev = e.dev;
  if (e.secs != null) out.secs = e.secs;
  if (e.conf != null) out.conf = e.conf;
  if (e.db != null) out.db = e.db;
  if (e.incident) out.incident = e.incident;
  return out;
}

/** Aggregate minutes into chart buckets (energy-average for dB, max for peaks). */
export function historyBuckets(rows: MinuteRow[], from: number, to: number, bucketMs?: number): {
  res: number;
  pts: { t: number; laeq: number | null; lmax: number | null; l90: number | null; motion: number | null; crib: number | null; light: number | null; state: number | null; cal: number; visit: number; sounds: Record<string, number> }[];
} {
  const span = to - from;
  const res = bucketMs ?? (span <= 3 * 60 * 60_000 ? 60_000 : span <= 12 * 60 * 60_000 ? 5 * 60_000 : span <= 3 * 24 * 60 * 60_000 ? 15 * 60_000 : 60 * 60_000);
  const by = new Map<number, MinuteRow[]>();
  for (const r of rows) {
    const t = Math.floor(r.m / res) * res;
    const list = by.get(t);
    if (list) list.push(r);
    else by.set(t, [r]);
  }
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const pts = [...by.entries()].sort((a, b) => a[0] - b[0]).map(([t, rs]) => {
    const laeqs = rs.map((r) => r.laeq).filter((v): v is number => v != null);
    const lmaxs = rs.map((r) => r.lmax).filter((v): v is number => v != null);
    const sounds: Record<string, number> = {};
    for (const r of rs) for (const [k, v] of Object.entries(r.sounds)) sounds[k] = (sounds[k] ?? 0) + v;
    return {
      t,
      laeq: laeqs.length ? Math.round(10 * Math.log10(laeqs.reduce((a, d) => a + 10 ** (d / 10), 0) / laeqs.length) * 10) / 10 : null,
      lmax: lmaxs.length ? Math.max(...lmaxs) : null,
      l90: avg(rs.map((r) => r.l90).filter((v): v is number => v != null)),
      motion: avg(rs.map((r) => r.motion).filter((v): v is number => v != null)),
      crib: avg(rs.map((r) => r.crib).filter((v): v is number => v != null)),
      light: avg(rs.map((r) => r.light).filter((v): v is number => v != null)),
      state: rs.reduce<number | null>((a, r) => (r.state == null ? a : Math.max(a ?? 0, r.state)), null),
      cal: rs.some((r) => r.cal) ? 1 : 0,
      visit: rs.some((r) => r.visit) ? 1 : 0,
      sounds,
    };
  });
  return { res, pts };
}
