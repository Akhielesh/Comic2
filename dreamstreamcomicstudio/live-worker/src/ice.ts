// ICE servers for every WebRTC path the live Worker brokers — baby monitor, family and direct
// calls, Stream Studio guests. STUN always; Cloudflare Realtime TURN when the owner has set
// TURN_KEY_ID + TURN_KEY_API_TOKEN (without TURN, devices behind carrier NAT or strict
// firewalls can't reach each other at all).
//
// TURN is the stack's only per-byte cost: $0.05/GB after the account's free 1 TB, billed on
// what Cloudflare sends to the TURN client. So credentials are guarded (ADR 0007 D6;
// docs/features/stream-studio-costs.md §5 P2, §7 C6):
//  - Minted per room + person + payer. Never shared across rooms or people: a credential
//    that leaks takes one person's relay with it, not everyone's. Reused only for a few
//    minutes, so a reconnect storm costs one API call, not one per socket.
//  - Short-lived: members ≤ 4 h, guests ≤ 2 h and never past their pass. Every delivery
//    says when to ask again (`iceMs`, ahead of expiry); clients then move a relayed
//    connection onto the fresh ones with an ICE restart, so an all-night picture keeps its relay.
//  - Attributable: each credential carries Cloudflare's `customIdentifier`, an HMAC of what
//    its bytes count against — the nursery (monitor), the caller's account (calls) or the
//    event (Stream Studio). Readable by nobody; recomputable by the Worker (`turnTag`).
//  - Revocable: a removed guest or member, a kicked studio guest, an ended direct call.
// A failed mint falls back to STUN only (clients ask again in a couple of minutes) and holds
// further mints for 30 s, so an API outage never turns into a request storm.
//
// Who gets TURN at all is the callers' decision and unchanged by this file: members and
// guests with a valid pass on the monitor, people in a call, the studio host and on-air
// guests — never broadcast viewers.

export const STUN: RTCIceServerLike[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

export interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceEnv {
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** Optional secret for the attribution HMAC; without it the TURN API token keys it. */
  TURN_TAG_SALT?: string;
}

/** Members (and studio hosts): a credential lives at most this long. */
export const TURN_TTL_S = 4 * 3600;
/** Guests — a share-link pass, a studio guest: at most this long, and never past their pass. */
export const GUEST_TURN_TTL_S = 2 * 3600;
/** Shortest credential we ask for (a pass about to end). */
export const MIN_TURN_TTL_S = 60;
/** Same room, person and payer within this long: the same credential (bounds API calls). */
export const REUSE_MS = 5 * 60_000;
/** Clients ask again this long before a credential lapses (a quarter of a short one). */
export const REFRESH_LEAD_MS = 20 * 60_000;
/** After a failed mint: STUN only, and the client asks again in this long. */
export const RETRY_MS = 2 * 60_000;
/** After a failed mint, nobody mints for this long. */
const FAIL_HOLD_MS = 30_000;
/** Never tell a client to ask again sooner than this. */
const MIN_ASK_MS = 60_000;
/** Credentials remembered for reuse and revocation (memory bound per isolate). */
const MAX_TRACKED = 2000;

const API = 'https://rtc.live.cloudflare.com/v1/turn/keys';

export type TurnScope = 'nursery' | 'account' | 'event';

/** What a credential's relay bytes count against (owner decisions: monitor → nursery, call → caller). */
export interface TurnBill {
  scope: TurnScope;
  id: string;
}

export interface IceRequest {
  /** The minting room — the cache and revocation namespace: `n:<nursery>`, `c:<call>`, `e:<event>`. */
  room: string;
  /** Who is asking in that room: a member's uid, `g:<guest id>`, a studio socket id, `host`. */
  who: string;
  /** Whose relay allowance these bytes count against. */
  bill: TurnBill;
  /** A guest: the shorter lifetime. */
  guest?: boolean;
  /** Epoch ms the person's access ends (a guest pass): the credential never outlives it. */
  until?: number | null;
}

export interface IceGrant {
  servers: RTCIceServerLike[];
  /** Ask again in this many ms (ahead of expiry, or soon after a failed mint). null: STUN only, nothing to refresh. */
  iceMs: number | null;
}

interface Minted {
  keyId: string;
  tag: string;
  servers: RTCIceServerLike[];
  usernames: string[];
  at: number;
  exp: number;
  reuseUntil: number;
}

/** room → who → credentials handed out (newest last). */
let rooms = new Map<string, Map<string, Minted[]>>();
let tracked = 0;
let failUntil = 0;
let tagKey: { secret: string; key: Promise<CryptoKey> } | null = null;
const tagMemo = new Map<string, string>();

export const hasTurnConfig = (env: IceEnv): boolean => !!(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN);

/** Cloudflare lists a port-53 alternative that browsers time out on — drop those URLs. */
export function dropPort53(servers: RTCIceServerLike[]): RTCIceServerLike[] {
  const out: RTCIceServerLike[] = [];
  for (const s of servers) {
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => typeof u === 'string' && !/:53(\?|$)/.test(u));
    if (urls.length) out.push({ ...s, urls });
  }
  return out;
}

/** True when the list includes a relay (turn:/turns:) server. */
export const includesTurn = (servers: RTCIceServerLike[]): boolean =>
  servers.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/.test(u)));

/**
 * Cloudflare's `customIdentifier` for a payer: `n-`/`a-`/`e-` and 32 hex characters of an
 * HMAC-SHA256 keyed by a Worker secret. Not reversible, stable while the secret is, and the
 * same for every credential that counts against the same nursery, account or event — so TURN
 * analytics (`callsTurnUsageAdaptiveGroups` by `customIdentifier`) attribute every byte.
 */
export async function turnTag(env: IceEnv, bill: TurnBill): Promise<string> {
  const secret = env.TURN_TAG_SALT || env.TURN_KEY_API_TOKEN || '';
  if (!tagKey || tagKey.secret !== secret) {
    tagMemo.clear();
    const raw = new TextEncoder().encode(secret || 'dreamstream-turn');
    tagKey = { secret, key: crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) };
  }
  const memo = `${bill.scope}:${bill.id}`;
  const hit = tagMemo.get(memo);
  if (hit) return hit;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await tagKey.key, new TextEncoder().encode(memo)));
  const tag = `${bill.scope[0]}-${[...sig.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  if (tagMemo.size > MAX_TRACKED) tagMemo.clear();
  tagMemo.set(memo, tag);
  return tag;
}

/** The message fields a room sends with an ICE list (`iceMs` only when there is something to refresh). */
export const iceFields = (g: IceGrant): { ice: RTCIceServerLike[]; iceMs?: number } => ({ ice: g.servers, ...(g.iceMs != null ? { iceMs: g.iceMs } : {}) });

const ttlFor = (req: IceRequest, now: number): number => {
  const base = req.guest ? GUEST_TURN_TTL_S : TURN_TTL_S;
  if (req.until == null) return base;
  return Math.min(base, Math.max(MIN_TURN_TTL_S, Math.floor((req.until - now) / 1000)));
};

/** Ask again a little before the credential lapses (a quarter of its life at most). */
const askIn = (m: Minted, now: number): number => Math.max(MIN_ASK_MS, m.exp - Math.min(REFRESH_LEAD_MS, (m.exp - m.at) / 4) - now);

function prune(now: number): void {
  tracked = 0;
  for (const [room, people] of rooms) {
    for (const [who, list] of people) {
      const live = list.filter((m) => m.exp > now);
      if (live.length) {
        people.set(who, live);
        tracked += live.length;
      } else people.delete(who);
    }
    if (!people.size) rooms.delete(room);
  }
  // Still too many: forget the oldest rooms (their credentials still lapse on their own).
  for (const room of rooms.keys()) {
    if (tracked <= MAX_TRACKED) break;
    for (const list of rooms.get(room)!.values()) tracked -= list.length;
    rooms.delete(room);
  }
}

async function mint(env: IceEnv, ttl: number, tag: string, fetcher: typeof fetch): Promise<{ servers: RTCIceServerLike[]; usernames: string[] } | null> {
  const body = JSON.stringify({ ttl, customIdentifier: tag });
  const init = { method: 'POST', headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'content-type': 'application/json' }, body };
  // `generate` is where Cloudflare documents customIdentifier; `generate-ice-servers` (same
  // credential, a ready-made list) is the fallback, so attribution never costs us the relay.
  for (const path of ['generate', 'generate-ice-servers']) {
    try {
      const res = await fetcher(`${API}/${env.TURN_KEY_ID}/credentials/${path}`, init);
      if (!res.ok) continue;
      const json = (await res.json()) as { iceServers?: RTCIceServerLike | RTCIceServerLike[] };
      const turn = dropPort53(Array.isArray(json.iceServers) ? json.iceServers : json.iceServers ? [json.iceServers] : []);
      if (!includesTurn(turn)) continue;
      const usernames = [...new Set(turn.map((s) => s.username).filter((u): u is string => typeof u === 'string' && !!u))];
      return { servers: [...STUN, ...turn], usernames };
    } catch {
      /* try the other endpoint, then STUN only */
    }
  }
  return null;
}

/**
 * STUN plus a TURN credential of this room's own for this person and payer (see the top of
 * the file). STUN only when TURN isn't configured, when a guest's pass is over, or while the
 * TURN API is failing.
 */
export async function iceFor(env: IceEnv, req: IceRequest, now = Date.now(), fetcher: typeof fetch = fetch): Promise<IceGrant> {
  if (!hasTurnConfig(env)) return { servers: STUN, iceMs: null };
  if (req.until != null && req.until <= now) return { servers: STUN, iceMs: null };
  const keyId = env.TURN_KEY_ID!;
  const tag = await turnTag(env, req.bill);
  const mine = rooms.get(req.room)?.get(req.who) ?? [];
  for (let i = mine.length - 1; i >= 0; i--) {
    const m = mine[i];
    if (m.keyId === keyId && m.tag === tag && now < m.reuseUntil && now < m.exp) return { servers: m.servers, iceMs: askIn(m, now) };
  }
  if (now < failUntil) return { servers: STUN, iceMs: RETRY_MS };

  const ttl = ttlFor(req, now);
  const got = await mint(env, ttl, tag, fetcher);
  if (!got) {
    failUntil = now + FAIL_HOLD_MS;
    return { servers: STUN, iceMs: RETRY_MS };
  }
  const m: Minted = { keyId, tag, ...got, at: now, exp: now + ttl * 1000, reuseUntil: now + Math.min(REUSE_MS, (ttl * 1000) / 4) };
  prune(now);
  const room = rooms.get(req.room) ?? new Map<string, Minted[]>();
  rooms.set(req.room, room);
  room.set(req.who, [...(room.get(req.who) ?? []), m]);
  tracked += 1;
  // One line per credential for `wrangler tail`: the payer's tag and kind — no ids, names or addresses.
  console.log(JSON.stringify({ evt: 'turn_mint', tag, scope: req.bill.scope, ttl, guest: !!req.guest }));
  return { servers: m.servers, iceMs: askIn(m, now) };
}

/**
 * Revoke the credentials this room handed to the people `match` picks (everyone by default),
 * so they stop working before their TTL — and forget them. Best effort: credentials minted
 * by an isolate that has since been evicted can't be found here, and still lapse on their own.
 * Returns how many were revoked.
 */
export async function revokeIce(env: IceEnv, room: string, match: (who: string) => boolean = () => true, now = Date.now(), fetcher: typeof fetch = fetch): Promise<number> {
  const people = rooms.get(room);
  if (!people || !hasTurnConfig(env)) return 0;
  const names = new Set<string>();
  for (const [who, list] of [...people]) {
    if (!match(who)) continue;
    people.delete(who);
    tracked -= list.length;
    for (const m of list) if (m.exp > now && m.keyId === env.TURN_KEY_ID) for (const u of m.usernames) names.add(u);
  }
  if (!people.size) rooms.delete(room);
  const init = { method: 'POST', headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}` } };
  const out = await Promise.allSettled([...names].map((u) => fetcher(`${API}/${env.TURN_KEY_ID}/credentials/${encodeURIComponent(u)}/revoke`, init)));
  return out.filter((r) => r.status === 'fulfilled' && (r.value.ok || r.value.status === 404)).length;
}

/** Tests only. */
export function resetIceCache(): void {
  rooms = new Map();
  tracked = 0;
  failUntil = 0;
  tagKey = null;
  tagMemo.clear();
}
