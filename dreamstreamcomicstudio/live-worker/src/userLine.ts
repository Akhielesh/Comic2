/**
 * UserLine — one Durable Object per Stream Studio member: their personal
 * line for direct calls (think of it as their phone number).
 *
 *  - Each open app keeps one socket here (GET /api/calls/u/<uid>/ws). The
 *    first frame carries the member's own Supabase token; live_me must say
 *    it's a member with this very uid, which also claims the line. Only a
 *    claimed line ever rings, and a claim nobody has renewed for 30 days
 *    lapses — so a line rings only for a real, current member.
 *  - Placing a call (dcall_start): the caller's token is checked again
 *    (membership can be revoked while a socket stays open) and their family
 *    re-read unless that was under a minute ago; then the caller's limits,
 *    then the call's own room is made (callRoom.ts → /x/init) and rings
 *    everyone asked. Hanging up before the call got going (dcall_cancel)
 *    really cancels it — even while the room is still being made.
 *  - Being rung (/x/ring, from a call's room): the rules in directCalls.ts
 *    decide; the open apps get `dcall_ring` (with a ticket into the call's
 *    room) and phones with "Ring this device" a Web Push — signed with the
 *    same VAPID key pair as the baby monitor's (a browser keeps one
 *    subscription per key, so a second pair would break nursery alerts). The
 *    reply never waits for the push, so a ring and a silenced ring take the
 *    same time.
 *  - Sockets: only the member's own authenticated apps count towards the
 *    10-device limit; sockets that haven't authenticated have a small pool of
 *    their own (the oldest is let go first), so knowing a member's id isn't
 *    enough to crowd their apps off the line.
 *  - Keeps the member's direct-call history (missed calls marked), their
 *    favourites, the people they blocked and who may call them — synced to
 *    every device.
 *
 * The worker routes only /ws here; /x/* is for other Durable Objects.
 */

import {
  allowStart,
  appendLog,
  BLOCKED_CAP,
  blockTarget,
  CALL_ID_RE,
  CLAIM_STALE_MS,
  cleanPerson,
  cleanPrefs,
  cleanUids,
  ctxText,
  DEFAULT_PREFS,
  DIRECT_LOG_CAP,
  FAMILY_CALL_TTL_MS,
  FAMILY_TTL_MS,
  familyFrom,
  FAVS_CAP,
  judgeRing,
  MAX_DIRECT_TO,
  newCallId,
  noteCaller,
  PUSH_SUBS_CAP,
  ringDecision,
  statusOf,
  setPerson,
  UUID_RE,
  type CallerHistory,
  type DirectPrefs,
  type FamilyCache,
  type PersonRec,
  type RingCtx,
  type RingDecision,
  type RingingRec,
  type StartRate,
} from './directCalls';
import { RING_MS, type CallRecord } from './familyCalls';
import { callRpc, verifyMember, type SupabaseEnv } from './supabaseAuth';
import { isAllowedPushEndpoint, sendWebPush, type PushSubscriptionJSONLike, type VapidKeys } from './webpush';
import { replacedEndpoint, storeReplacing } from './pushReplace';
import { UsageMeter, type SocketUsage } from './usageMeter';
import { FAIR_USE, isUsageKind, sanitizeUsage, type UsageMonth } from '../../shared/stream/usage';

/** The baby monitor's VAPID key holder (one key pair for every push this app sends). */
const KEY_HOLDER = '__vapid_keys__';
const VAPID_SUBJECT = 'https://dreamstreamstudio.ai';

export interface UserLineEnv extends SupabaseEnv {
  MONITOR_ROOM: DurableObjectNamespace;
  CALL_ROOM: DurableObjectNamespace;
  // No STREAM_USAGE here on purpose: every call's Analytics Engine point is written once, by the room
  // that measured it (CallRoom / MonitorRoom). The line keeps only the member's own month row.
}

/** The member's own usage this month (`{t:'usage_get'}` → `{t:'usage'}`; Phase B's Usage card). */
export interface AccountUsageReply {
  t: 'usage';
  usage: UsageMonth;
  allowances: { relayDataGb: number; cloudCopyGb: number };
}

interface Attach {
  sid: string;
  at: number;
  authed: boolean;
  /** Its auth frame arrived and is being checked. */
  authing?: boolean;
  /** Closed by us (the runtime can still list a closing socket): no longer counted, never authenticated. */
  gone?: boolean;
  dev?: string;
  dn?: string;
  /** Usage this app carries until the account's month row is written (usageMeter.ts). */
  u?: SocketUsage;
}

interface Owner {
  uid: string;
  name: string;
  /** Last time live_me vouched for this member (a claim lapses after 30 days). */
  verifiedAt: number;
}

interface PushRec {
  sub: PushSubscriptionJSONLike;
  at: number;
}

/** How a call that rang this line was handled (decides its history line). */
interface Seen {
  how: RingDecision;
  from: string;
  name: string;
  at: number;
  ctx: RingCtx;
  /** Someone the member blocked was behind it (the caller, whoever added them, or someone in the call). */
  blocked?: boolean;
}

interface StartRec {
  ref: string;
  at: number;
  id?: string;
  ticket?: string;
  error?: string;
}

const AUTH_TIMEOUT_MS = 10_000;
/** Open apps per member (authenticated sockets only). */
export const MAX_SOCKETS = 10;
/** Sockets still waiting for their auth frame; past this the oldest is let go. */
export const MAX_PENDING = 6;
const FRAME_MAX = 8 * 1024;
/** How long a ringing call is offered to a device that opens the app. */
const RINGING_MS = RING_MS + 5000;
/** Calls that rang here are remembered this long (a call's history line can come hours later). */
const SEEN_MS = 24 * 60 * 60_000;
const START_DEDUPE_MS = 60_000;
/** A call hung up before it got going is remembered (by its ref) this long. */
const CANCEL_MS = 60_000;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const clip = (s: unknown, n: number) => String(s ?? '').trim().slice(0, n);

export class UserLine {
  private vapid: VapidKeys | null = null;
  /**
   * The account's usage month (calls it placed, …): ≤ 1 `use:YYYY-MM` row an hour, for the member's own
   * Usage card. No Analytics Engine sink: the room that measured each call already wrote its point, and
   * a second one here would double every call in Admin → Costs.
   */
  private readonly usage: UsageMeter;

  constructor(private state: DurableObjectState, private env: UserLineEnv) {
    this.usage = new UsageMeter({ storage: state.storage, sink: null, scope: 'account' });
    // Idle lines never wake the object: the runtime answers keepalive pings.
    try {
      state.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    } catch { /* older runtime: answered below */ }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/ws') return this.handleUpgrade(req, url);
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (url.pathname === '/x/ring') return this.handleRing(body);
      if (url.pathname === '/x/update') return this.handleUpdate(body);
      if (url.pathname === '/x/log') return this.handleLog(body);
      if (url.pathname === '/x/use') return this.handleUse(body);
    }
    return json({ error: 'not found' }, 404);
  }

  // -------------------------------------------------------------- storage
  private get<T>(k: string): Promise<T | undefined> {
    return this.state.storage.get<T>(k);
  }

  private async owner(): Promise<Owner | null> {
    return (await this.get<Owner>('owner')) ?? null;
  }

  private async ringing(now = Date.now()): Promise<RingingRec[]> {
    return ((await this.get<RingingRec[]>('ringing')) ?? []).filter((r) => now - r.at < RINGING_MS);
  }

  private async lists(): Promise<{ favs: PersonRec[]; blocked: PersonRec[]; prefs: DirectPrefs }> {
    const [favs, blocked, prefs] = await Promise.all([this.get<PersonRec[]>('favs'), this.get<PersonRec[]>('blocked'), this.get<DirectPrefs>('prefs')]);
    return { favs: favs ?? [], blocked: blocked ?? [], prefs: prefs ?? DEFAULT_PREFS };
  }

  private async vapidKeys(): Promise<VapidKeys | null> {
    if (this.vapid) return this.vapid;
    try {
      const res = await this.env.MONITOR_ROOM.get(this.env.MONITOR_ROOM.idFromName(KEY_HOLDER)).fetch(new Request('https://monitor.internal/vapid'));
      if (res.ok) this.vapid = (await res.json()) as VapidKeys;
    } catch { /* push degrades to in-app ringing */ }
    return this.vapid;
  }

  private room(id: string): DurableObjectStub {
    return this.env.CALL_ROOM.get(this.env.CALL_ROOM.idFromName(id));
  }

  private async toRoom<T>(id: string, path: string, body: unknown): Promise<T | null> {
    try {
      const res = await this.room(id).fetch(new Request(`https://call.internal${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
      return (await res.json().catch(() => null)) as T | null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------- sockets
  private async handleUpgrade(req: Request, url: URL): Promise<Response> {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'expected websocket' }, 426);
    const uid = url.searchParams.get('uid') || '';
    if (!UUID_RE.test(uid)) return json({ error: 'bad line' }, 400);
    // The line belongs to the uid it was first opened for (it's named after it).
    const known = await this.get<string>('uid');
    if (!known) await this.state.storage.put('uid', uid);
    else if (known !== uid) return json({ error: 'bad line' }, 400);
    const pair = new WebSocketPair();
    this.admit(pair[1]);
    await this.ensureAlarm(AUTH_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * A new socket waits for its auth frame. Only authenticated apps count
   * towards the member's device limit (checked at auth); unauthenticated
   * sockets get a small pool of their own, and when it's full the oldest
   * goes — one that never even sent an auth frame first — so anyone who
   * knows a member's id can't fill the line and keep their apps off it.
   */
  admit(ws: WebSocket): void {
    const pending = this.sockets()
      .filter((s) => !s.a.authed)
      .sort((x, y) => Number(!!x.a.authing) - Number(!!y.a.authing) || x.a.at - y.a.at);
    for (const s of pending.slice(0, Math.max(0, pending.length - MAX_PENDING + 1))) this.retire(s.ws, s.a, 4000, 'crowded');
    this.state.acceptWebSocket(ws);
    ws.serializeAttachment({ sid: crypto.randomUUID().slice(0, 10), at: Date.now(), authed: false } satisfies Attach);
  }

  /** Open sockets (one we closed may still be listed while it closes — it doesn't count). */
  private sockets(): { ws: WebSocket; a: Attach }[] {
    const out: { ws: WebSocket; a: Attach }[] = [];
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a && !a.gone) out.push({ ws, a });
    }
    return out;
  }

  /** Close a socket and stop counting it at once (a peer that never finishes the close can't keep its slot). */
  private retire(ws: WebSocket, a: Attach, code: number, reason: string): void {
    try {
      ws.serializeAttachment({ ...a, authed: false, authing: false, gone: true } satisfies Attach);
    } catch { /* closed */ }
    try {
      ws.close(code, reason);
    } catch { /* closed */ }
  }

  private apps(): { ws: WebSocket; a: Attach }[] {
    return this.sockets().filter((s) => s.a.authed);
  }

  private send(ws: WebSocket, obj: unknown): void {
    try {
      ws.send(JSON.stringify(obj));
    } catch { /* closing */ }
  }

  /** To every open app of this member. */
  private all(obj: unknown): void {
    const payload = JSON.stringify(obj);
    for (const { ws } of this.apps()) {
      try {
        ws.send(payload);
      } catch { /* closing */ }
    }
  }

  private reject(ws: WebSocket, code: string, msg: string, close: number): void {
    this.send(ws, { t: 'error', code, msg });
    const a = ws.deserializeAttachment() as Attach | null;
    if (a) return this.retire(ws, a, close, code);
    try {
      ws.close(close, code);
    } catch { /* closed */ }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Attach | null;
    if (!a || a.gone || typeof raw !== 'string' || raw.length > FRAME_MAX) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!a.authed) {
      if (msg.t === 'auth' && !a.authing) await this.onAuth(ws, a, msg);
      return;
    }
    switch (msg.t) {
      case 'ping':
        return this.send(ws, { t: 'pong', at: Date.now() });
      case 'dcall_start':
        return this.onStart(ws, msg);
      case 'dcall_invite':
        return this.onInvite(ws, msg);
      case 'dcall_cancel':
        return this.onCancel(msg);
      case 'dcall_decline':
        return this.onDecline(msg);
      case 'call_push':
        return this.onPush(ws, msg);
      case 'call_push_off':
        return this.onPushOff(msg);
      case 'fav':
      case 'block':
        return this.onList(msg);
      case 'prefs':
        return this.onPrefs(msg);
      case 'usage_get':
        return this.onUsageGet(ws);
      case 'family_refresh': {
        // At most once a minute (each read is a few Supabase calls) — or every 10 s right after
        // this member changed who's in a nursery, so someone removed stops counting at once.
        const [owner, cur] = await Promise.all([this.owner(), this.get<FamilyCache>('family')]);
        const gap = msg.changed === true ? 10_000 : 60_000;
        if (owner && (!cur || Date.now() - cur.at > gap)) await this.refreshFamily(owner, clip(msg.token, 4096));
        return;
      }
    }
  }

  /** Finish the closing handshake and stop counting the socket (the runtime can list it until the close completes). */
  async webSocketClose(ws: WebSocket): Promise<void> {
    const a = ws.deserializeAttachment() as Attach | null;
    if (a && !a.gone) this.retire(ws, a, 1000, 'bye');
    if (a?.u) this.handOver(ws, a);
  }

  /** A closing app's unwritten usage moves to another open app (or memory) — once, never lost to a close. */
  private handOver(ws: WebSocket, a: Attach): void {
    this.usage.release(a);
    try {
      ws.serializeAttachment({ ...a, authed: false, authing: false, gone: true } satisfies Attach);
    } catch { /* closed */ }
    const next = this.apps().find((s) => s.ws !== ws);
    if (next && this.usage.stash(next.a)) next.ws.serializeAttachment(next.a);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const a = ws.deserializeAttachment() as Attach | null;
    if (a && !a.gone) this.retire(ws, a, 1011, 'error');
    if (a?.u) this.handOver(ws, a);
  }

  /** The member's own token: live_me must say it's a member with this line's uid. That claims the line. */
  private async onAuth(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    const token = clip(msg.token, 4096);
    const uid = await this.get<string>('uid');
    if (!token || !uid) return this.reject(ws, 'auth', 'Sign in again to make calls.', 4001);
    a.authing = true;
    ws.serializeAttachment(a);
    const res = await callRpc<{ member?: boolean; user_id?: string; profile?: { display_name?: string } }>(this.env, token, 'live_me');
    // Let go while it was being checked (crowded out, or closed): nothing more to do.
    if ((ws.deserializeAttachment() as Attach | null)?.gone) return;
    a.authing = false;
    if (!res.ok) return this.reject(ws, 'auth', res.status === 401 ? 'Your session expired — sign in again.' : 'Could not verify your account right now.', 4001);
    if (!res.data.member || !res.data.user_id) return this.reject(ws, 'forbidden', 'Unlock Stream Studio with your welcome code to make calls.', 4003);
    if (res.data.user_id !== uid) return this.reject(ws, 'forbidden', 'This line belongs to someone else.', 4003);
    // Only the member's own apps count towards the limit ('full' — the app tries again later).
    if (this.apps().length >= MAX_SOCKETS) return this.reject(ws, 'full', 'Stream Studio is open on too many devices.', 4003);
    const now = Date.now();
    const owner: Owner = { uid, name: clip(res.data.profile?.display_name || 'Member', 40), verifiedAt: now };
    await this.state.storage.put('owner', owner);
    a.authed = true;
    a.dev = clip(msg.dev, 40) || a.sid;
    a.dn = clip(msg.dn, 40) || 'Device';
    ws.serializeAttachment(a);
    const [vapid, ringing, log, lists] = await Promise.all([this.vapidKeys(), this.ringing(now), this.get<CallRecord[]>('log'), this.lists()]);
    this.send(ws, {
      t: 'hello',
      you: { sid: a.sid, uid, name: owner.name, mode: 'me', dev: a.dev },
      vapid: vapid?.publicKey ?? null,
      ringing,
      log: (log ?? []).slice(-DIRECT_LOG_CAP),
      ...lists,
    });
    // Who shares a nursery with this member — worked out after the hello, never blocking it.
    const fam = await this.get<FamilyCache>('family');
    if (!fam || now - fam.at > FAMILY_TTL_MS) await this.refreshFamily(owner, token);
  }

  /**
   * Re-read the member's family (everyone sharing one of their nurseries)
   * with their own token — checked to be theirs first.
   */
  private async refreshFamily(owner: Owner, token: string): Promise<FamilyCache | null> {
    if (!token) return null;
    const who = await verifyMember(this.env, token);
    if (who?.userId !== owner.uid) return null;
    const list = await callRpc<{ ok?: boolean; nurseries?: { id: string; name?: string; baby_name?: string | null }[] }>(this.env, token, 'monitor_list');
    if (!list.ok || !list.data.ok) return null;
    const nurseries = (list.data.nurseries ?? []).filter((n) => UUID_RE.test(String(n.id))).slice(0, 10);
    const people: Record<string, { user_id: string; label?: string | null; is_me?: boolean }[]> = {};
    await Promise.all(
      nurseries.map(async (n) => {
        const r = await callRpc<{ ok?: boolean; people?: { user_id: string; label?: string | null; is_me?: boolean }[] }>(this.env, token, 'monitor_people', { p_nursery: n.id });
        if (r.ok && r.data.ok) people[n.id] = r.data.people ?? [];
      }),
    );
    const cache: FamilyCache = { at: Date.now(), map: familyFrom(nurseries, people) };
    await this.state.storage.put('family', cache);
    return cache;
  }

  /**
   * The family map for placing a call: re-read first (with the caller's own,
   * just-checked token) unless it's under a minute old, so someone removed
   * from a nursery stops counting as family on their very next call. A map
   * that can't be re-read vouches for nobody.
   */
  private async family(owner: Owner, token: string): Promise<FamilyCache> {
    const cur = await this.get<FamilyCache>('family');
    if (cur && Date.now() - cur.at < FAMILY_CALL_TTL_MS) return cur;
    return (await this.refreshFamily(owner, token).catch(() => null)) ?? { at: 0, map: {} };
  }

  /**
   * Every call is placed with a fresh token, checked again here (cached for a
   * minute): a membership revoked while this socket stayed open stops calls
   * at once. A token that doesn't check out sends the app to sign in again.
   */
  private async caller(ws: WebSocket, msg: Record<string, unknown>, ref?: string): Promise<{ owner: Owner; token: string } | null> {
    const owner = await this.owner();
    if (!owner) return null;
    const token = clip(msg.token, 4096);
    const who = token ? await verifyMember(this.env, token) : null;
    if (!who || who.userId !== owner.uid) {
      this.send(ws, { t: 'call_err', error: 'auth', ...(ref != null ? { ref } : {}), ...(msg.id ? { id: clip(msg.id, 20) } : {}) });
      this.reject(ws, 'auth', 'Sign in again to make calls.', 4001);
      return null;
    }
    const fresh: Owner = { uid: owner.uid, name: clip(who.displayName || owner.name, 40), verifiedAt: Date.now() };
    await this.state.storage.put('owner', fresh);
    return { owner: fresh, token };
  }

  // ------------------------------------------------------ placing a call
  private async onStart(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const ref = clip(msg.ref, 20);
    const now = Date.now();
    // The same start again (its answer was lost with a connection): the same answer.
    const starts = ((await this.get<StartRec[]>('starts')) ?? []).filter((s) => now - s.at < START_DEDUPE_MS);
    const prev = starts.find((s) => s.ref === ref);
    if (prev && ref) return this.answerStart(ws, prev);
    // Hung up before this even arrived.
    if (ref && (await this.cancelled(ref))) return this.answerStart(ws, { ref, at: now, error: 'cancelled' });

    const me = await this.caller(ws, msg, ref);
    if (!me) return;
    const { owner, token } = me;
    const to = cleanUids(msg.to, MAX_DIRECT_TO).filter((u) => u !== owner.uid);
    if (!to.length) return this.send(ws, { t: 'call_err', error: 'nobody', ref });
    const fam = await this.family(owner, token);
    const rate = allowStart(await this.get<StartRate>('rate'), now, to.filter((u) => !fam.map[u]));
    await this.state.storage.put('rate', rate.rate);
    let rec: StartRec;
    if (!rate.ok) {
      rec = { ref, at: now, error: 'slow_down' };
    } else {
      const id = newCallId();
      const r = await this.toRoom<{ status?: string; ticket?: string }>(id, '/x/init', {
        id,
        from: { uid: owner.uid, name: owner.name },
        video: msg.video !== false,
        to: to.map((u) => ({ uid: u, family: !!fam.map[u], where: fam.map[u]?.where ?? null })),
        famAt: fam.at,
        // Kept by the call's room: speaks for this caller if someone else in the call adds people.
        fam: Object.keys(fam.map),
      });
      rec = r?.status === 'ringing' && r.ticket ? { ref, at: now, id, ticket: r.ticket } : { ref, at: now, error: r?.status === 'restricted' ? 'restricted' : 'unavailable' };
    }
    const latest = ((await this.get<StartRec[]>('starts')) ?? []).filter((s) => now - s.at < START_DEDUPE_MS && s.ref !== ref);
    await this.state.storage.put('starts', [...latest, rec].slice(-20));
    // Hung up while the room was being made: the call ends before anyone answers into it.
    // The answer goes first: waiting on the room's wrap-up (the callee's history line) would time how they treat you.
    if (ref && rec.id && (await this.cancelled(ref))) {
      this.answerStart(ws, { ref, at: now, error: 'cancelled' });
      this.background(this.toRoom(rec.id, '/x/cancel', { id: rec.id, by: owner.uid }));
      return;
    }
    this.answerStart(ws, rec);
  }

  /** A call this member hung up on (by its ref) before it got going. */
  private async cancelled(ref: string): Promise<boolean> {
    const now = Date.now();
    return ((await this.get<{ ref: string; at: number }[]>('cancels')) ?? []).some((c) => c.ref === ref && now - c.at < CANCEL_MS);
  }

  /**
   * Hung up before the call got going (the app had no call id yet, or hadn't
   * reached the call's room): the call is cancelled at once — the people
   * being rung stop ringing — rather than ringing on until the caller's
   * grace runs out. Works whichever comes first, this or the start.
   */
  private async onCancel(msg: Record<string, unknown>): Promise<void> {
    const owner = await this.owner();
    const ref = clip(msg.ref, 20);
    if (!owner || !ref) return;
    const now = Date.now();
    const cancels = ((await this.get<{ ref: string; at: number }[]>('cancels')) ?? []).filter((c) => now - c.at < CANCEL_MS && c.ref !== ref);
    await this.state.storage.put('cancels', [...cancels, { ref, at: now }].slice(-20));
    const rec = ((await this.get<StartRec[]>('starts')) ?? []).find((s) => s.ref === ref);
    const id = rec?.id ?? clip(msg.id, 20);
    // The room checks it's the caller's own call (and only ever drops the caller's not-yet-arrived place).
    if (CALL_ID_RE.test(id)) this.background(this.toRoom(id, '/x/cancel', { id, by: owner.uid }));
  }

  private answerStart(ws: WebSocket, rec: StartRec): void {
    if (rec.error || !rec.id) this.send(ws, { t: 'call_err', error: rec.error ?? 'unavailable', ref: rec.ref });
    else this.send(ws, { t: 'dcall_started', ref: rec.ref, id: rec.id, ticket: rec.ticket, status: 'ringing' });
  }

  /** Ring more people into a direct call you're in (the same checks and limits as placing one). */
  private async onInvite(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const id = clip(msg.id, 20);
    if (!CALL_ID_RE.test(id)) return;
    const me = await this.caller(ws, msg);
    if (!me) return;
    const { owner, token } = me;
    const to = cleanUids(msg.to, MAX_DIRECT_TO).filter((u) => u !== owner.uid);
    if (!to.length) return;
    const now = Date.now();
    const fam = await this.family(owner, token);
    const rate = allowStart(await this.get<StartRate>('rate'), now, to.filter((u) => !fam.map[u]));
    await this.state.storage.put('rate', rate.rate);
    if (!rate.ok) return this.send(ws, { t: 'dcall_invited', id, status: 'slow_down' });
    const r = await this.toRoom<{ status?: string }>(id, '/x/invite', {
      id,
      by: owner.uid,
      to: to.map((u) => ({ uid: u, family: !!fam.map[u], where: fam.map[u]?.where ?? null })),
      famAt: fam.at,
    });
    this.send(ws, { t: 'dcall_invited', id, status: r?.status ?? 'unavailable' });
  }

  // -------------------------------------------------------- being rung
  /**
   * A call's room rings this member. Answers only what any caller would hear,
   * as fast as any caller would hear it. `by` is whoever added this member to
   * the call (when it isn't the caller) and `with` who's already in it: a
   * block of any of them silences the ring, and the rate limits count against
   * whoever rang.
   */
  private async handleRing(body: Record<string, unknown>): Promise<Response> {
    const owner = await this.owner();
    const now = Date.now();
    // Never claimed (or lapsed): nothing to ring, and nothing is written.
    if (!owner || now - owner.verifiedAt > CLAIM_STALE_MS) return json({ status: 'unavailable' });
    const id = clip(body.id, 20);
    const from = cleanPerson(body.from);
    const ticket = clip(body.ticket, 100);
    if (!CALL_ID_RE.test(id) || !from || !ticket || from.uid === owner.uid) return json({ status: 'unavailable' });
    const by0 = cleanPerson(body.by);
    const by = by0 && by0.uid !== from.uid && by0.uid !== owner.uid ? by0 : null;
    const [fam, lists, hist] = await Promise.all([this.get<FamilyCache>('family'), this.lists(), this.get<Record<string, CallerHistory>>('hist')]);
    // Your own map and the ringing side's (re-read for this call): the newer decides.
    const judged = judgeRing({
      from,
      by,
      others: cleanUids(body.with, 8).filter((u) => u !== owner.uid),
      mine: fam?.map ?? {},
      mineAt: fam?.at ?? 0,
      now,
      vouch: body.family === true,
      vouchAt: typeof body.famAt === 'number' && Number.isFinite(body.famAt) ? Math.min(body.famAt, now) : null,
      fromVouch: body.fromFamily === true,
      fromVouchAt: typeof body.fromFamAt === 'number' && Number.isFinite(body.fromFamAt) ? Math.min(body.fromFamAt, now) : null,
      where: body.where ? clip(body.where, 60) : null,
      blocked: lists.blocked,
    });
    const { family, blocked, ringer, ctx } = judged;
    let how = ringDecision({ claimed: true, verifiedAt: owner.verifiedAt, now, blocked, prefs: lists.prefs, family, history: hist?.[ringer.uid] });
    // A caller you've silenced doesn't get through by having someone else add you to their call.
    if (how === 'ring' && by && ringDecision({ claimed: true, verifiedAt: owner.verifiedAt, now, blocked, prefs: lists.prefs, family, history: hist?.[from.uid] }) === 'silent') how = 'silent';

    const seen = (await this.get<Record<string, Seen>>('seen')) ?? {};
    for (const [k, v] of Object.entries(seen)) if (now - v.at > SEEN_MS) delete seen[k];
    seen[id] = { how, from: from.uid, name: from.name, at: now, ctx, ...(blocked ? { blocked: true } : {}) };
    const keys = Object.keys(seen);
    for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete seen[k];
    await this.state.storage.put('seen', seen);
    // Rings from outside the family count towards "3 an hour" (silenced ones too) — for whoever rang.
    if ((how === 'ring' || how === 'silent') && !family && !blocked) await this.state.storage.put('hist', noteCaller(hist ?? {}, ringer.uid, 'ring', now));

    if (how === 'ring') {
      const video = body.video !== false;
      const rec: RingingRec = { id, from, video, at: Number(body.at) || now, ticket, ctx };
      // Kept even with no app open: an app opened while it rings picks it up from the hello.
      await this.state.storage.put('ringing', [...(await this.ringing(now)).filter((r) => r.id !== id), rec].slice(-6));
      this.all({ t: 'dcall_ring', ring: rec });
      await this.ensureAlarm(RINGING_MS);
      // The push goes out behind the reply: waiting on it would make a ring
      // measurably slower than a silenced one, and give a block away.
      this.background(
        this.push(
          { title: ctx.label || from.name, body: `${video ? 'Video' : 'Audio'} call · ${ctxText(ctx)}`, kind: 'call', call: id, direct: true },
          Math.round(RING_MS / 1000),
          'high',
        ),
      );
    }
    const status = statusOf(how);
    // The name (as live_me has it) is for the call's room to show who's in the call.
    return json(status === 'ringing' ? { status, name: owner.name } : { status });
  }

  /** Picked up on one of this member's devices (or the call is over): the others stop ringing. */
  private async handleUpdate(body: Record<string, unknown>): Promise<Response> {
    const id = clip(body.id, 20);
    await this.stopRinging(id);
    return json({ ok: true });
  }

  private async stopRinging(id: string): Promise<RingingRec | null> {
    const all = await this.ringing();
    const hit = all.find((r) => r.id === id) ?? null;
    if (hit) await this.state.storage.put('ringing', all.filter((r) => r.id !== id));
    this.all({ t: 'dcall_update', id, stop: true });
    return hit;
  }

  /** A call this member was part of ended: its history line (missed calls pushed, unless blocked or silenced). */
  private async handleLog(body: Record<string, unknown>): Promise<Response> {
    const owner = await this.owner();
    const rec = body.rec as CallRecord | undefined;
    if (!owner || !rec || typeof rec.id !== 'string' || !rec.from?.uid) return json({ ok: false });
    await this.stopRinging(rec.id);
    const incoming = rec.from.uid !== owner.uid;
    const seen = ((await this.get<Record<string, Seen>>('seen')) ?? {})[rec.id];
    if (incoming) {
      // Nothing of a blocked caller (or of a call someone blocked added you to) — or of a refused one — ever reaches the member.
      const { blocked } = await this.lists();
      if (blocked.some((b) => b.uid === rec.from.uid) || seen?.blocked || seen?.how === 'restricted') return json({ ok: true });
      if (!seen && !rec.invited?.includes(owner.uid)) return json({ ok: false });
    }
    await this.state.storage.put('log', appendLog((await this.get<CallRecord[]>('log')) ?? [], rec));
    this.all({ t: 'call_log', rec });
    // A call this member placed: its usage is theirs (the call's room sends it to the caller only).
    if (!incoming && body.use) await this.meterAdd('call', body.use);
    if (incoming && body.missed === true && seen?.how !== 'silent') {
      const ctx = seen?.ctx ?? { family: false, label: null, where: null };
      // Behind the reply, like the ring's: the room's wrap-up must take as long whoever you block.
      this.background(this.push({ title: `Missed ${rec.video ? 'video' : 'audio'} call`, body: `${ctx.label || rec.from.name} · ${ctxText(ctx)}`, kind: 'call_missed', call: rec.id, direct: true }, 6 * 3600, 'normal'));
    }
    return json({ ok: true });
  }

  /** Work that carries on after the reply (an in-flight fetch keeps the object alive; waitUntil where the runtime has it). */
  private background(p: Promise<unknown>): void {
    const done = p.catch(() => undefined);
    try {
      (this.state as DurableObjectState & { waitUntil?: (p: Promise<unknown>) => void }).waitUntil?.(done);
    } catch { /* not supported */ }
  }

  /** Web Push to this member's devices that asked to be rung. */
  private async push(data: { title: string; body: string; kind: 'call' | 'call_missed'; call: string; direct: true }, ttlSec: number, urgency: 'high' | 'normal'): Promise<void> {
    const subs = (await this.get<PushRec[]>('push')) ?? [];
    if (!subs.length) return;
    const keys = await this.vapidKeys();
    if (!keys) return;
    const gone = new Set<string>();
    await Promise.all(
      subs.map(async (r) => {
        // Same topic: an undelivered ring is replaced by its "missed call".
        const out = await sendWebPush(r.sub, { ...data, tag: `call-${data.call}`, at: Date.now() }, keys, { subject: VAPID_SUBJECT, urgency, ttlSec, topic: `call${data.call.slice(0, 12)}` });
        if (out === 'gone') gone.add(r.sub.endpoint);
      }),
    );
    if (gone.size) await this.state.storage.put('push', subs.filter((r) => !gone.has(r.sub.endpoint)));
  }

  // ------------------------------------------------- the member's choices
  private async onDecline(msg: Record<string, unknown>): Promise<void> {
    const owner = await this.owner();
    const id = clip(msg.id, 20);
    if (!owner || !CALL_ID_RE.test(id)) return;
    const now = Date.now();
    const rec = await this.stopRinging(id);
    const seen = ((await this.get<Record<string, Seen>>('seen')) ?? {})[id];
    // Only someone who really rang this line, named as the server knows them.
    const caller = rec?.from ?? (seen ? { uid: seen.from, name: seen.name } : null);
    const ctx = rec?.ctx ?? seen?.ctx ?? null;
    const family = ctx?.family ?? false;
    // Whoever rang: the person who added you, else the caller.
    const ringer = ctx?.by ? { uid: ctx.by.uid, name: ctx.by.name } : caller;
    if (ringer && !family) await this.state.storage.put('hist', noteCaller((await this.get<Record<string, CallerHistory>>('hist')) ?? {}, ringer.uid, 'decline', now));
    // Decline & block: whoever added you if they're not your family, else the caller.
    if (msg.block === true && caller) {
      const lists = await this.lists();
      await this.state.storage.put('blocked', setPerson(lists.blocked, blockTarget(caller, ctx), true, BLOCKED_CAP, now));
      await this.sendLists();
    }
    await this.toRoom(id, '/x/decline', { id, uid: owner.uid });
  }

  private async onList(msg: Record<string, unknown>): Promise<void> {
    const owner = await this.owner();
    const p = cleanPerson(msg);
    if (!owner || !p || p.uid === owner.uid) return;
    const key = msg.t === 'fav' ? 'favs' : 'blocked';
    const lists = await this.lists();
    await this.state.storage.put(key, setPerson(lists[key], p, msg.on !== false, key === 'favs' ? FAVS_CAP : BLOCKED_CAP, Date.now()));
    await this.sendLists();
  }

  private async onPrefs(msg: Record<string, unknown>): Promise<void> {
    await this.state.storage.put('prefs', cleanPrefs(msg));
    await this.sendLists();
  }

  /** Favourites, blocked and "who can call me" — the same on every device. */
  private async sendLists(): Promise<void> {
    this.all({ t: 'dcall_state', ...(await this.lists()) });
  }

  private async onPush(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const sub = msg.sub as PushSubscriptionJSONLike | undefined;
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys?.p256dh || !sub.keys?.auth) return;
    if (!isAllowedPushEndpoint(sub.endpoint) || sub.endpoint.length > 1024) return this.send(ws, { t: 'call_err', error: 'push' });
    const rec: PushRec = { sub: { endpoint: sub.endpoint, keys: { p256dh: clip(sub.keys.p256dh, 200), auth: clip(sub.keys.auth, 64) } }, at: Date.now() };
    // `was`: this browser's old dreamstreamstudio.ai/live subscription (pushReplace.ts) — this line
    // is one account's, so every record here is theirs.
    const was = replacedEndpoint(sub, rec.sub.endpoint);
    const all = storeReplacing((await this.get<PushRec[]>('push')) ?? [], rec, was, () => true);
    await this.state.storage.put('push', all.slice(-PUSH_SUBS_CAP));
  }

  private async onPushOff(msg: Record<string, unknown>): Promise<void> {
    const endpoint = String(msg.endpoint ?? '');
    const all = (await this.get<PushRec[]>('push')) ?? [];
    if (all.some((r) => r.sub.endpoint === endpoint)) await this.state.storage.put('push', all.filter((r) => r.sub.endpoint !== endpoint));
  }

  // ---------------------------------------------------------------- usage
  /** Usage another room measured for this account (a family call it placed). Internal only. */
  private async handleUse(body: Record<string, unknown>): Promise<Response> {
    if (!isUsageKind(body.kind)) return json({ ok: false });
    await this.meterAdd(body.kind, body.use);
    return json({ ok: true });
  }

  private async meterAdd(kind: Parameters<UsageMeter['add']>[0], use: unknown): Promise<void> {
    this.usage.add(kind, sanitizeUsage(use));
    const uid = await this.get<string>('uid');
    const now = Date.now();
    const carriers = this.apps().map(({ ws, a }) => ({ a, save: () => ws.serializeAttachment(a) }));
    if ((await this.usage.flush(now, { scopeId: uid, account: uid, carriers })) === 'written') return;
    // Inside the hour: it rides an open app's attachment until the next write (hibernation-safe).
    const app = this.apps()[0];
    if (app && this.usage.stash(app.a)) app.ws.serializeAttachment(app.a);
  }

  /** The member's own month: written row + what is still owed. A read; prunes the row that aged out. */
  private async onUsageGet(ws: WebSocket): Promise<void> {
    const now = Date.now();
    const usage = await this.usage.month(now, this.apps().map(({ ws: w, a }) => ({ a, save: () => w.serializeAttachment(a) })));
    const reply: AccountUsageReply = { t: 'usage', usage, allowances: { relayDataGb: FAIR_USE.relayDataGbPerAccountMonth, cloudCopyGb: FAIR_USE.cloudCopyGbRolling } };
    this.send(ws, reply);
    await this.usage.prune(now);
  }

  // ---------------------------------------------------------------- alarm
  private async ensureAlarm(inMs: number): Promise<void> {
    const cur = await this.state.storage.getAlarm();
    const want = Date.now() + Math.max(1000, inMs);
    if (cur == null || cur > want) await this.state.storage.setAlarm(want);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let want: number | null = null;
    for (const { ws, a } of this.sockets()) {
      if (a.authed) continue;
      if (now - a.at > AUTH_TIMEOUT_MS) this.retire(ws, a, 4001, 'auth timeout');
      else want = Math.min(want ?? Infinity, a.at + AUTH_TIMEOUT_MS);
    }
    // Calls that stopped ringing without word (their room tells us when it can).
    const stored = (await this.get<RingingRec[]>('ringing')) ?? [];
    const live = stored.filter((r) => now - r.at < RINGING_MS);
    if (live.length !== stored.length) await this.state.storage.put('ringing', live);
    for (const r of live) want = Math.min(want ?? Infinity, r.at + RINGING_MS);
    if (want != null) await this.state.storage.setAlarm(Math.max(now + 1000, want));
  }
}
