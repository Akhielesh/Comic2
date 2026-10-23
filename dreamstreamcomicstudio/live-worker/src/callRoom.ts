/**
 * CallRoom — one Durable Object per direct call (named by the call's id).
 *
 * A direct call (Calls → search → call anyone on Stream Studio) has no
 * nursery to be its switchboard, so it gets a room of its own. The room
 * speaks exactly the nursery line protocol (hello / call / call_rtc /
 * call_err …), so the app's call mesh and call screen are the same for both.
 *
 *  - Made by the caller's line (userLine.ts → POST /x/init): the call starts
 *    with the caller "pending" (familyCalls.ts) until their app arrives, and
 *    each person asked is rung through their own line (POST /x/ring).
 *  - Sockets authenticate with a ticket: 24 random bytes per person, handed
 *    out only through that person's authenticated line; the room keeps only
 *    the ticket's hash. No Supabase round trip when someone answers.
 *  - Relays the WebRTC handshake only between two devices in the call
 *    (CallBook.canRelay), never stores media.
 *  - When the call ends, each person's line gets the history line (and the
 *    missed-call push where it's due); the room wipes itself 2 minutes later.
 *  - Someone in the call adding a person (/x/invite) rings them as the call
 *    it is (from the caller) *and* as the person who added them, with who's
 *    already in it — their line judges all of those (blocks, family, limits).
 *    A line's family vouch speaks only for its own owner.
 *  - The caller hanging up before their app reached the room (/x/cancel,
 *    from their line) cancels the call there and then.
 *  - Only sockets that hold a valid ticket count towards the device limit;
 *    sockets still waiting to authenticate have a small pool of their own.
 *  - Relay (TURN) credentials are this call's own, per person, counted against
 *    the caller's account (./ice), refreshed on request during a long call
 *    (`call_ice`), and revoked when the call ends.
 *
 * The worker routes only /ws here; /x/* is for other Durable Objects.
 */

import { CALL_ID_RE, cleanPerson, hashTicket, MAX_DIRECT_TO, mintTicket, overallStatus, userLineName, UUID_RE, type RingStatus } from './directCalls';
import { CallBook, missedBy, toRecord, type Call, type CallStat } from './familyCalls';
import { iceFields, iceFor, revokeIce, type IceEnv } from './ice';

export interface CallRoomEnv extends IceEnv {
  USER_LINE: DurableObjectNamespace;
}

interface Attach {
  sid: string;
  at: number;
  authed: boolean;
  /** Its auth frame arrived and is being checked. */
  authing?: boolean;
  /** Closed by us (the runtime can still list a closing socket): no longer counted. */
  gone?: boolean;
  uid?: string;
  name?: string;
  dev?: string;
}

interface Invitee {
  uid: string;
  family: boolean;
  where: string | null;
}

interface Meta {
  id: string;
  from: { uid: string; name: string };
  video: boolean;
  /** The caller's family when the call was placed (from their line), and when that map was read — vouches for the caller when someone else adds people. */
  fromFam?: { at: number; uids: string[] };
}

/** Most people a caller's family vouch is kept for. */
const FROM_FAM_CAP = 200;

/** The caller's place in the call until their app reaches the room. */
export const PENDING_SID = 'pending';
const AUTH_TIMEOUT_MS = 10_000;
const LINE_CHECK_MS = 30_000;
const LINE_STALE_MS = 60_000;
/** A finished call's room is wiped this long after it ended. */
export const CLEANUP_MS = 2 * 60_000;
/** Devices in one call's room (every person's pre-connected phones and computers) — authenticated ones only. */
export const MAX_SOCKETS = 16;
/** Sockets still waiting for their ticket; past this the oldest is let go. */
export const MAX_PENDING = 8;
const FRAME_MAX = 8 * 1024;
const RTC_FRAME_MAX = 64 * 1024;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const clip = (s: unknown, n: number) => String(s ?? '').trim().slice(0, n);

function cleanInvitees(v: unknown, not: string): Invitee[] {
  if (!Array.isArray(v)) return [];
  const out: Invitee[] = [];
  for (const x of v.slice(0, MAX_DIRECT_TO * 2)) {
    const o = (x ?? {}) as Record<string, unknown>;
    const uid = clip(o.uid, 40);
    if (!UUID_RE.test(uid) || uid === not || out.some((i) => i.uid === uid)) continue;
    out.push({ uid, family: o.family === true, where: o.where ? clip(o.where, 60) : null });
  }
  return out.slice(0, MAX_DIRECT_TO);
}

/** When the asking line's family map was read (its vouches are that fresh). */
const famAtOf = (body: Record<string, unknown>): number | null => (typeof body.famAt === 'number' && Number.isFinite(body.famAt) ? body.famAt : null);

export class CallRoom {
  /** When each socket last sent anything (pings are answered by the runtime). */
  private seen = new Map<string, number>();

  constructor(private state: DurableObjectState, private env: CallRoomEnv) {
    try {
      state.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    } catch { /* older runtime: answered below */ }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/ws') return this.handleUpgrade(req, url);
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (url.pathname === '/x/init') return this.handleInit(body);
      if (url.pathname === '/x/invite') return this.handleInvite(body);
      if (url.pathname === '/x/decline') return this.handleDecline(body);
      if (url.pathname === '/x/cancel') return this.handleCancel(body);
    }
    return json({ error: 'not found' }, 404);
  }

  private meta(): Promise<Meta | undefined> {
    return this.state.storage.get<Meta>('meta');
  }

  private async book(): Promise<CallBook> {
    return new CallBook((await this.state.storage.get<Call[]>('calls')) ?? []);
  }

  private line(uid: string): DurableObjectStub {
    return this.env.USER_LINE.get(this.env.USER_LINE.idFromName(userLineName(uid)));
  }

  /** STUN + this call's own relay credential for one person, counted against the caller's account (./ice). */
  private ice(meta: Meta, uid: string) {
    return iceFor(this.env, { room: `c:${meta.id}`, who: uid, bill: { scope: 'account', id: meta.from.uid } });
  }

  /** Tell someone's line something (another Durable Object). Never throws. */
  private async post<T>(uid: string, path: string, body: unknown): Promise<T | null> {
    try {
      const res = await this.line(uid).fetch(new Request(`https://line.internal${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
      return res.ok ? ((await res.json().catch(() => null)) as T | null) : null;
    } catch {
      return null;
    }
  }

  /** Tickets for these people: the room keeps the hashes, the people get the tickets (through their lines). */
  private async mint(uids: string[]): Promise<Map<string, string>> {
    const tickets = (await this.state.storage.get<Record<string, string>>('tickets')) ?? {};
    const out = new Map<string, string>();
    for (const uid of uids) {
      const t = mintTicket();
      tickets[await hashTicket(t)] = uid;
      out.set(uid, t);
    }
    await this.state.storage.put('tickets', tickets);
    return out;
  }

  /**
   * Ring one person through their line. Their name comes back from it (verified
   * there). `by`: who added them, when it isn't the caller — their line then
   * also judges the ring by that person, and by everyone already in the call.
   */
  private async ring(meta: Meta, call: Call, who: Invitee, ticket: string, famAt: number | null, by: { uid: string; name: string } | null = null): Promise<RingStatus> {
    const inCall = [...new Set(call.parts.map((p) => p.uid))].filter((u) => u !== meta.from.uid && u !== by?.uid && u !== who.uid);
    // Added by someone else: the caller's own line still speaks for the caller.
    const fromFam = by && meta.fromFam ? { fromFamily: meta.fromFam.uids.includes(who.uid), fromFamAt: meta.fromFam.at } : {};
    const r = await this.post<{ status?: RingStatus; name?: string }>(who.uid, '/x/ring', {
      id: meta.id,
      from: meta.from,
      video: meta.video,
      at: call.at,
      ticket,
      family: who.family,
      where: who.where,
      // When the ringing side's family map was read (the callee's line trusts the newer map).
      ...(famAt != null ? { famAt } : {}),
      ...(by ? { by } : {}),
      ...fromFam,
      ...(inCall.length ? { with: inCall } : {}),
    });
    if (r?.name) {
      const names = (await this.state.storage.get<Record<string, string>>('names')) ?? {};
      names[who.uid] = clip(r.name, 40);
      await this.state.storage.put('names', names);
    }
    return r?.status === 'ringing' || r?.status === 'restricted' ? r.status : 'unavailable';
  }

  // ------------------------------------------------------------- internal
  /** The caller's line makes the call: book it with the caller pending, ring everyone asked. */
  private async handleInit(body: Record<string, unknown>): Promise<Response> {
    const id = clip(body.id, 20);
    const from = cleanPerson(body.from);
    if (!CALL_ID_RE.test(id) || !from) return json({ error: 'bad call' }, 400);
    if (await this.meta()) return json({ error: 'exists' }, 409);
    const to = cleanInvitees(body.to, from.uid);
    if (!to.length) return json({ error: 'nobody' }, 400);
    const now = Date.now();
    const famAt = famAtOf(body);
    const fam = Array.isArray(body.fam) ? [...new Set(body.fam.map((u) => clip(u, 40)).filter((u) => UUID_RE.test(u) && u !== from.uid))].slice(0, FROM_FAM_CAP) : null;
    const meta: Meta = { id, from, video: body.video !== false, ...(fam && famAt != null ? { fromFam: { at: Math.min(famAt, now), uids: fam } } : {}) };
    const book = new CallBook();
    const call = book.start({ ...from, label: null, sid: PENDING_SID }, to.map((t) => t.uid), meta.video, id, now, { pending: true });
    if ('error' in call) return json({ error: call.error }, 400);
    // Saved before anyone is rung: a callee's phone can reach the room the moment it rings.
    await this.state.storage.put({ meta, calls: book.toJSON(), names: { [from.uid]: from.name } });
    const tickets = await this.mint([from.uid, ...to.map((t) => t.uid)]);
    await this.armDeadlines();
    const statuses = await Promise.all(to.map((t) => this.ring(meta, call, t, tickets.get(t.uid)!, famAtOf(body))));
    const status = overallStatus(statuses);
    if (status !== 'ringing') {
      // Nobody it was for can be rung: over at once (the caller hears why; the unreachable get a missed call).
      const fresh = await this.book();
      const ended = fresh.endCall(id, 'no_answer', Date.now());
      if (ended) await this.commit(fresh, [ended]);
    } else {
      await this.armDeadlines();
    }
    return json({ status, ticket: tickets.get(from.uid) });
  }

  /** Someone in the call asked (through their line) to ring more people. */
  private async handleInvite(body: Record<string, unknown>): Promise<Response> {
    const meta = await this.meta();
    const by = clip(body.by, 40);
    if (!meta || clip(body.id, 20) !== meta.id) return json({ error: 'ended' }, 404);
    const book = await this.book();
    const call = book.get(meta.id);
    const me = call?.parts.find((p) => p.uid === by && p.gone == null);
    if (!call || !me) return json({ error: 'not_in_call' }, 403);
    const want = cleanInvitees(body.to, meta.from.uid);
    const r = book.invite(meta.id, me.sid, want.map((w) => w.uid));
    if (!r || !r.added.length) return json({ status: 'ringing', added: [] });
    await this.commit(book, [r.call]);
    const tickets = await this.mint(r.added);
    // Someone other than the caller is adding people: they're rung as the call (from the caller)
    // *and* as the person adding them. The inviter's line vouches only for the inviter.
    const names = (await this.state.storage.get<Record<string, string>>('names')) ?? {};
    const inviter = by === meta.from.uid ? null : { uid: by, name: names[by] || r.call.ever[by] || me.name || 'Member' };
    const statuses = await Promise.all(want.filter((w) => r.added.includes(w.uid)).map((w) => this.ring(meta, r.call, w, tickets.get(w.uid)!, famAtOf(body), inviter)));
    await this.armDeadlines();
    return json({ status: overallStatus(statuses), added: r.added });
  }

  /** Declined from the person's line (works from an app a push notification opened). */
  private async handleDecline(body: Record<string, unknown>): Promise<Response> {
    const meta = await this.meta();
    if (!meta || clip(body.id, 20) !== meta.id) return json({ ok: false });
    const book = await this.book();
    const call = book.decline(meta.id, clip(body.uid, 40), Date.now());
    if (call) await this.commit(book, [call]);
    return json({ ok: !!call });
  }

  /**
   * The caller hung up before their app reached the room (from their line):
   * their not-yet-arrived place goes, so a call nobody answered is cancelled
   * at once — the people being rung stop ringing — instead of after the grace.
   * (Once their app is in the room, hanging up is an ordinary call_leave.)
   */
  private async handleCancel(body: Record<string, unknown>): Promise<Response> {
    const meta = await this.meta();
    if (!meta || clip(body.id, 20) !== meta.id || clip(body.by, 40) !== meta.from.uid) return json({ ok: false });
    const book = await this.book();
    const changed = book.leave(PENDING_SID, Date.now(), meta.id);
    if (changed.length) {
      await this.commit(book, changed);
      await this.armDeadlines();
    }
    return json({ ok: changed.length > 0 });
  }

  // -------------------------------------------------------------- sockets
  private async handleUpgrade(req: Request, url: URL): Promise<Response> {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'expected websocket' }, 426);
    const id = url.searchParams.get('id') || '';
    if (!CALL_ID_RE.test(id)) return json({ error: 'bad call' }, 400);
    const meta = await this.meta();
    const pair = new WebSocketPair();
    const server = pair[1];
    // A call that's over (or never was): say so and close for good — nothing is stored for it.
    const refuse = (code: string, msg: string, close: number) => {
      server.accept();
      try {
        server.send(JSON.stringify({ t: 'error', code, msg }));
        server.close(close, code);
      } catch { /* closing */ }
      return new Response(null, { status: 101, webSocket: pair[0] });
    };
    if (!meta || meta.id !== id) return refuse('ended', 'That call has ended.', 4006);
    this.admit(server);
    await this.ensureAlarm(AUTH_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * A new socket waits for its ticket. Only sockets with a valid ticket count
   * towards the room's device limit (checked at auth); the rest share a small
   * pool of their own, the oldest let go first (one that never sent a frame
   * before one being checked), so nobody can fill the room with idle sockets.
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

  private send(ws: WebSocket, obj: unknown): void {
    try {
      ws.send(JSON.stringify(obj));
    } catch { /* closing */ }
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
    if (!a || a.gone || typeof raw !== 'string' || raw.length > RTC_FRAME_MAX) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t !== 'call_rtc' && msg.t !== 'auth' && raw.length > FRAME_MAX) return;
    if (!a.authed) {
      if (msg.t === 'auth' && !a.authing) await this.onAuth(ws, a, msg);
      return;
    }
    this.seen.set(a.sid, Date.now());
    if (msg.t === 'ping') return this.send(ws, { t: 'pong', at: Date.now() });
    return this.onCallMsg(ws, a, msg);
  }

  /** Finish the closing handshake and stop counting the socket; a device in the call gets the usual grace. */
  async webSocketClose(ws: WebSocket): Promise<void> {
    const a = ws.deserializeAttachment() as Attach | null;
    if (!a || a.gone) return;
    this.retire(ws, a, 1000, 'bye');
    if (!a.authed) return;
    this.seen.delete(a.sid);
    await this.onGone(a);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const a = ws.deserializeAttachment() as Attach | null;
    if (!a || a.gone) return;
    this.retire(ws, a, 1011, 'error');
    if (!a.authed) return;
    this.seen.delete(a.sid);
    await this.onGone(a);
  }

  private async onAuth(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    a.authing = true;
    ws.serializeAttachment(a);
    const ticket = clip(msg.ticket, 100);
    const tickets = (await this.state.storage.get<Record<string, string>>('tickets')) ?? {};
    const uid = ticket ? tickets[await hashTicket(ticket)] : undefined;
    // Let go while it was being checked (crowded out, or closed).
    if ((ws.deserializeAttachment() as Attach | null)?.gone) return;
    a.authing = false;
    if (!uid) return this.reject(ws, 'forbidden', 'That call isn’t for you.', 4003);
    const meta = await this.meta();
    const book = await this.book();
    const call = meta ? book.get(meta.id) : null;
    if (!meta || !call || call.ended || (await this.state.storage.get<number>('endedAt')) != null) return this.reject(ws, 'ended', 'That call has ended.', 4006);
    if (this.sockets().filter((s) => s.a.authed).length >= MAX_SOCKETS) return this.reject(ws, 'full', 'Too many devices are in this call right now.', 4003);
    const names = (await this.state.storage.get<Record<string, string>>('names')) ?? {};
    a.authed = true;
    a.uid = uid;
    a.name = names[uid] || call.ever[uid] || 'Member';
    a.dev = clip(msg.dev, 40) || a.sid;
    ws.serializeAttachment(a);
    this.send(ws, {
      t: 'hello',
      you: { sid: a.sid, uid, name: a.name, role: 'member', label: null, mode: 'line', dev: a.dev },
      nursery: { id: 'direct', name: 'Stream Studio', baby: null },
      ...iceFields(await this.ice(meta, uid)),
      vapid: null,
      calls: book.forUser(uid),
      callLog: [],
    });
  }

  private async onCallMsg(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    const meta = await this.meta();
    if (!meta || !a.uid) return;
    const now = Date.now();
    const id = clip(msg.id, 24);
    if (id !== meta.id) return;
    const me = { uid: a.uid, name: a.name || 'Member', label: null, sid: a.sid };
    const uuids = (v: unknown) => (Array.isArray(v) ? v.slice(0, 8).map((u) => clip(u, 40)).filter((u) => UUID_RE.test(u)) : []);
    switch (msg.t) {
      case 'call_rtc': {
        const to = clip(msg.to, 20);
        if (msg.d == null || typeof msg.d !== 'object') return;
        if (!(await this.book()).canRelay(id, a.sid, to)) return;
        for (const s of this.sockets()) {
          if (s.a.authed && s.a.sid === to) return this.send(s.ws, { t: 'call_rtc', id, from: a.sid, d: msg.d });
        }
        return;
      }
      case 'call_join': {
        const book = await this.book();
        const answered = !!book.get(id)?.parts.some((p) => p.uid === a.uid && p.uid !== meta.from.uid);
        const call = book.join(id, me, msg.video !== false, now, msg.mic !== false);
        if ('error' in call) return this.send(ws, { t: 'call_err', error: call.error, id });
        // Saved before anything else is awaited: the joiner's offer is right behind this message.
        await this.commit(book, [call]);
        await this.armDeadlines();
        this.send(ws, { t: 'call_joined', id, ...iceFields(await this.ice(meta, a.uid)) });
        // Picked up: the person's other devices stop ringing.
        if (a.uid !== meta.from.uid && !answered) await this.post(a.uid, '/x/update', { id, stop: true });
        return;
      }
      case 'call_up': {
        const book = await this.book();
        if (book.vouch(id, a.sid, uuids(msg.uids), now)) await this.state.storage.put('calls', book.toJSON());
        return;
      }
      case 'call_ice': {
        // A long call's relay credentials are due: fresh ones for someone still in it.
        const call = (await this.book()).get(id);
        if (!call || call.ended || !call.parts.some((p) => p.sid === a.sid && p.gone == null)) return;
        return this.send(ws, { t: 'call_ice', id, ...iceFields(await this.ice(meta, a.uid)) });
      }
      case 'call_stats': {
        const book = await this.book();
        const s = { ttc: msg.ttc as number | null, path: msg.path as CallStat['path'], fail: msg.fail as string | null, turn: msg.turn === true };
        if (!book.stat(id, a.uid, s, now)) return;
        await this.state.storage.put('calls', book.toJSON());
        const st = book.get(id)?.stats?.[a.uid];
        // One line per outcome for `wrangler tail` — no names, ids or addresses.
        console.log(JSON.stringify({ evt: 'call_stats', direct: true, ttc: st?.ttc ?? null, path: st?.path ?? null, fail: st?.fail ?? null, turn: st?.turn ?? false }));
        return;
      }
      case 'call_decline': {
        const book = await this.book();
        const call = book.decline(id, a.uid, now);
        if (!call) return;
        await this.commit(book, [call]);
        await this.post(a.uid, '/x/update', { id, stop: true });
        return;
      }
      case 'call_leave': {
        const book = await this.book();
        const changed = book.leave(a.sid, now, id);
        if (changed.length) await this.commit(book, changed);
        return;
      }
      case 'call_media': {
        const book = await this.book();
        const call = book.setMedia(id, a.sid, msg.mic !== false, msg.cam !== false);
        if (call) await this.commit(book, [call]);
        return;
      }
    }
  }

  /** A device's connection to the room dropped: it has the usual grace to come back. */
  private async onGone(a: Attach): Promise<void> {
    const book = await this.book();
    const changed = book.drop(a.sid, Date.now());
    if (!changed.length) return;
    await this.commit(book, changed);
    await this.armDeadlines();
  }

  /** Save the book, tell everyone in the room, and wrap up a call that ended. */
  private async commit(book: CallBook, changed: Call[]): Promise<void> {
    const payloads = changed.map((c) => JSON.stringify({ t: 'call', call: c }));
    for (const { ws, a } of this.sockets()) {
      if (!a.authed) continue;
      for (const p of payloads) {
        try {
          ws.send(p);
        } catch { /* closing */ }
      }
    }
    const done = book.sweep();
    await this.state.storage.put('calls', book.toJSON());
    for (const c of done) await this.wrapUp(c);
  }

  /** The call is over: every line it concerned gets the history line (missed calls marked), then the room winds down. */
  private async wrapUp(call: Call): Promise<void> {
    if ((await this.state.storage.get<number>('endedAt')) != null) return;
    const now = Date.now();
    await this.state.storage.put('endedAt', now);
    const rec = toRecord(call);
    const missed = new Set(missedBy(call));
    await Promise.all([call.from.uid, ...call.invited].map((uid) => this.post(uid, '/x/log', { rec, missed: missed.has(uid) })));
    // Nobody needs this call's relay any more: its credentials stop working now, not hours later.
    await revokeIce(this.env, `c:${call.id}`).catch(() => 0);
    await this.ensureAlarm(CLEANUP_MS);
  }

  /** Lines in an answered call that went silent (a phone that died mid-call). True while the call is up. */
  private async dropStaleLines(now: number): Promise<boolean> {
    const book = await this.book();
    const up = book.toJSON().filter((c) => !c.ended && c.answeredAt != null);
    if (!up.length) return false;
    const inCall = new Set(up.flatMap((c) => c.parts.filter((p) => p.gone == null).map((p) => p.sid)));
    for (const { ws, a } of this.sockets()) {
      if (!a.authed || !inCall.has(a.sid)) continue;
      let pinged = 0;
      try {
        pinged = this.state.getWebSocketAutoResponseTimestamp?.(ws)?.getTime() ?? 0;
      } catch { /* not supported */ }
      if (now - Math.max(a.at, pinged, this.seen.get(a.sid) ?? 0) < LINE_STALE_MS) continue;
      this.retire(ws, a, 4008, 'stale');
      this.seen.delete(a.sid);
      await this.onGone(a);
    }
    return true;
  }

  private async ensureAlarm(inMs: number): Promise<void> {
    const cur = await this.state.storage.getAlarm();
    const want = Date.now() + Math.max(1000, inMs);
    if (cur == null || cur > want) await this.state.storage.setAlarm(want);
  }

  /** The next ring timeout / grace expiry, and a stale-line check while the call is up. */
  private async armDeadlines(): Promise<void> {
    const book = await this.book();
    const now = Date.now();
    const next = book.nextDeadline();
    if (next != null) await this.ensureAlarm(Math.max(1000, next - now + 500));
    if (book.toJSON().some((c) => c.answeredAt != null && !c.ended)) await this.ensureAlarm(LINE_CHECK_MS);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let want: number | null = null;
    const soon = (t: number) => (want = Math.min(want ?? Infinity, Math.max(now + 1000, t)));

    for (const { ws, a } of this.sockets()) {
      if (a.authed) continue;
      if (now - a.at > AUTH_TIMEOUT_MS) this.retire(ws, a, 4001, 'auth timeout');
      else soon(a.at + AUTH_TIMEOUT_MS);
    }

    if ((await this.state.storage.get<number>('endedAt')) == null) {
      const up = await this.dropStaleLines(now);
      const book = await this.book();
      const out = book.expire(now);
      if (out.length) await this.commit(book, out);
      const next = book.nextDeadline();
      if (next != null) soon(next + 500);
      if (up) soon(now + LINE_CHECK_MS);
    }

    const endedAt = await this.state.storage.get<number>('endedAt');
    if (endedAt != null) {
      if (now - endedAt >= CLEANUP_MS) {
        // Nothing of the call stays behind.
        for (const { ws } of this.sockets()) this.reject(ws, 'ended', 'That call has ended.', 4006);
        await this.state.storage.deleteAlarm();
        await this.state.storage.deleteAll();
        return;
      }
      soon(endedAt + CLEANUP_MS);
    }
    if (want != null) await this.state.storage.setAlarm(want);
  }
}
