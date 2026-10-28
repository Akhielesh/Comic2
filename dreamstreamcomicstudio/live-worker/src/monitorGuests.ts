/**
 * Guest access to a nursery: a share link plus a passcode the parent sets.
 *
 * For family and sitters who don't have (or can't make) a Stream Studio
 * account. The nursery's own MonitorRoom is the authority — nothing about a
 * guest lives in Supabase.
 *
 *   link      /live#/monitor/join/<nursery>/<code> — 128 random bits, kept by
 *             the room so a parent can copy it again; it rides in the URL
 *             fragment, which browsers never send to a server.
 *   passcode  ≥ 8 characters, stored only as PBKDF2-SHA256 (100 000 rounds,
 *             the Workers maximum, per-link salt). The link alone gets no one in.
 *   guessing  5 wrong passcodes lock the link for 15 minutes; 20 since the last
 *             success turn it off and tell the parents. Per-address limits too.
 *             With `lockout: 'guest'` (ADR 0006 D6.2) the 5-in-a-row lock is per
 *             joiner (their address, hashed) instead, so one person with the link
 *             can't lock everyone else out; 20 wrong in all locks the link for an
 *             hour (and tells the parents) rather than turning it off. Optional
 *             Rate Limiting bindings (`limits`) sit in front of all of it.
 *   sessions  a successful join gets a 256-bit token, stored only as SHA-256.
 *             Guests expire with the link (or after 90 days), and a parent can
 *             remove one, or turn the link off to remove them all at once.
 *   removal   removing a guest also replaces the link's secret code (F3: the
 *             removed person can't rejoin with the link they have); everyone
 *             else stays signed in. Pass a prepared passcode to change that too —
 *             `preparePasscode('auto')` makes a new one to show the parent once.
 *   changes   a parent can set a new passcode on the same link (guests stay
 *             signed in unless they choose otherwise) and extend the link —
 *             existing passes are extended with it, never past 90 days.
 *   requests  a guest who also has a Stream Studio account (the room verifies
 *             their own token with Supabase — never an id from the request) is
 *             listed for parents to make a member; Supabase stays the authority.
 */

import type { SqlExec } from './monitorStore';

export type GuestRole = 'viewer' | 'caregiver';

export interface ShareRow {
  id: string;
  code: string;
  role: GuestRole;
  created_at: number;
  created_by: string;
  expires_at: number | null;
  revoked_at: number | null;
  /** Wrong passcodes in a row (resets on success and after a lock). */
  fails: number;
  /** Wrong passcodes since the last success — too many turns the link off. */
  total_fails: number;
  locked_until: number;
  /** When the passcode was last set (the link's creation, or a new passcode). */
  pass_at: number;
}

export interface GuestRow {
  id: string;
  share_id: string;
  name: string;
  role: GuestRole;
  created_at: number;
  last_seen: number;
  expires_at: number;
  revoked_at: number | null;
}

/** A guest with a Stream Studio account, waiting for a parent to make them a member. */
export interface RequestRow {
  id: string;
  /** Their Supabase user id — from their verified token, never from the request body. */
  uid: string;
  /** Their account's display name. */
  account: string;
  /** The name they typed when joining. */
  name: string;
  guest_id: string;
  at: number;
}

/** What parents see about the link (never the passcode). */
export interface ShareInfo {
  on: boolean;
  code: string | null;
  role: GuestRole;
  created_at: number | null;
  created_by: string | null;
  expires_at: number | null;
  locked_until: number | null;
  /** When the passcode was last set (changes when a parent sets a new one). */
  pass_at: number | null;
  /** Most guests one link admits. */
  max_guests: number;
  /** Present with `guest` lockout: wrong passcodes lock one joiner, not the link. */
  lockout?: 'guest';
  /** With `guest` lockout: joiners locked out right now. */
  locked_out?: number;
  guests: { id: string; name: string; role: GuestRole; created_at: number; last_seen: number; expires_at: number }[];
  /** Guests who have a Stream Studio account — parents can make them members. */
  requests: (RequestRow & { role: GuestRole })[];
}

export type JoinFail = {
  ok: false;
  reason: 'bad_link' | 'expired' | 'off' | 'locked' | 'wrong' | 'full' | 'slow_down' | 'name';
  retryAt?: number;
  left?: number;
  disabled?: boolean;
  /** For `locked`: just this joiner (`guest` lockout) or the whole link. */
  scope?: 'guest' | 'link';
};
export type JoinResult = { ok: true; token: string; guest: GuestRow } | JoinFail;
/**
 * The link and passcode were right (nothing issued yet). `seal` is the
 * passcode version that was accepted: `issue` refuses if it changed meanwhile.
 */
export type CheckResult = { ok: true; share: ShareRow; name: string; seal: string } | JoinFail;

export const PBKDF2_ROUNDS = 100_000;
export const MAX_FAILS_IN_A_ROW = 5;
export const LOCK_MS = 15 * 60_000;
export const MAX_FAILS_TOTAL = 20;
/** `guest` lockout: what 20 wrong passcodes in all do to the link — a lock, not "off". */
export const LINK_LOCK_MS = 60 * 60_000;
export const MAX_GUESTS = 10;
export const GUEST_TTL_MS = 90 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const IP_WINDOW_MS = 15 * 60_000;
const IP_MAX = 12;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mon_shares (
    id TEXT PRIMARY KEY, code TEXT NOT NULL, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, rounds INTEGER NOT NULL,
    role TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL, expires_at INTEGER, revoked_at INTEGER,
    fails INTEGER NOT NULL DEFAULT 0, total_fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS mon_guests (
    id TEXT PRIMARY KEY, share_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
    dev TEXT, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS mon_guests_share ON mon_guests(share_id)`,
  `CREATE TABLE IF NOT EXISTS mon_requests (
    id TEXT PRIMARY KEY, uid TEXT NOT NULL, account TEXT NOT NULL, name TEXT NOT NULL, guest_id TEXT NOT NULL,
    at INTEGER NOT NULL, resolved_at INTEGER)`,
  // Per-joiner wrong-passcode counts (`guest` lockout). `who` is a hash, never an address.
  `CREATE TABLE IF NOT EXISTS mon_guest_tries (
    share_id TEXT NOT NULL, who TEXT NOT NULL, fails INTEGER NOT NULL, locked_until INTEGER NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (share_id, who)) WITHOUT ROWID`,
];

/* --------------------------------------------- least privilege for guests */

/**
 * What a share-link guest may do (ADR 0006 D6.2, F12). Viewer guests: watch, listen, live
 * alerts — nothing else. Caregiver guests (a sitter) also talk, soothe, answer alerts and log
 * feeds and changes. History, the tracker's records and reports stay with members (opt-in per
 * guest arrives with per-guest invites in Phase 1). Guests never get a watch or a device grant.
 */
export type GuestCap = 'live' | 'listen' | 'alerts' | 'talk' | 'soothe' | 'ack' | 'log' | 'history' | 'tracker' | 'reports';

export const GUEST_CAPS: Readonly<Record<GuestRole, readonly GuestCap[]>> = {
  viewer: ['live', 'listen', 'alerts'],
  caregiver: ['live', 'listen', 'alerts', 'talk', 'soothe', 'ack', 'log'],
};

export function guestCaps(role: GuestRole): ReadonlySet<GuestCap> {
  return new Set(GUEST_CAPS[role === 'caregiver' ? 'caregiver' : 'viewer']);
}

export const guestCan = (role: GuestRole, cap: GuestCap): boolean => guestCaps(role).has(cap);

/**
 * May a guest's "I'm on it" end this alert? Never for hazards that page everyone (smoke or CO
 * alarm, breaking glass): those keep escalating until a member answers.
 */
export const guestAckEnds = (role: GuestRole, audience: 'everyone' | 'duty' | string): boolean => guestCan(role, 'ack') && audience !== 'everyone';

/** The Glance `can` bits (ADR 0006 D2: 1 ack · 2 soothe · 4 listen · 8 talk · 16 peek · 32 duty · 64 log) for a guest. */
export function guestCanBits(role: GuestRole): number {
  const c = guestCaps(role);
  return (c.has('ack') ? 1 : 0) | (c.has('soothe') ? 2 : 0) | (c.has('listen') ? 4 : 0) | (c.has('talk') ? 8 : 0) | (c.has('log') ? 64 : 0);
}

/* ------------------------------------------------------ rate-limit hook */

/** The shape of a Workers Rate Limiting binding (`env.RL_GUEST.limit({ key })`). */
export interface RateLimiterLike {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Optional limiters in front of passcode checks (ADR 0006 D6.2: guest join 10/60 s per address,
 * 30/60 s per nursery). A limiter that throws is ignored — the lockouts below still hold.
 */
export interface GuestLimits {
  perAddress?: RateLimiterLike;
  perNursery?: RateLimiterLike;
  /** The key for `perNursery` (the nursery id). */
  nursery?: string;
}

export interface GuestAccessOptions {
  rounds?: number;
  /** `link` (default, today's behaviour) or `guest` (per-joiner locks; ADR 0006). */
  lockout?: 'link' | 'guest';
  limits?: GuestLimits;
}

/** A passcode hashed ahead of time, so a removal can change it in one synchronous step. */
export interface PreparedPass {
  /** The passcode itself — show it to the parent once; it is never stored. */
  pass: string;
  hash: string;
  salt: string;
  rounds: number;
}

/** What removing a guest changed: the link's new code, and the new passcode if one was set. */
export interface RemovedGuest {
  id: string;
  name: string;
  newLink: { code: string; pass: string | null };
}

/* ------------------------------------------------------------- crypto */

const b64url = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export const newCode = () => b64url(random(16));
const newToken = () => b64url(random(32));
const newGuestId = () => b64url(random(9));

async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

/** Who is guessing, for `guest` lockout: their address (or, without one, their device id), hashed per link. */
async function joinerKey(shareId: string, ip?: string, dev?: string): Promise<string> {
  const who = ip ? `ip:${ip}` : dev ? `dev:${dev.slice(0, 40)}` : 'unknown';
  return (await sha256(`${shareId}|${who}`)).slice(0, 32);
}

async function pbkdf2(pass: string, salt: string, rounds: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: rounds }, key, 256);
  return hex(bits);
}

/** Same-length strings compared without an early exit. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ------------------------------------------------------- passcode rules */

/** Why a passcode isn't good enough, or null. Shared with the app. */
export function passcodeProblem(pass: string, avoid: (string | null | undefined)[] = []): string | null {
  const p = pass.normalize('NFKC');
  if (p.length < 8) return 'Use at least 8 characters.';
  if (p.length > 128) return 'Use 128 characters or fewer.';
  if (/^(.)\1+$/.test(p)) return 'Don’t repeat one character.';
  const lower = p.toLowerCase();
  const alnum = lower.replace(/[^a-z0-9]/g, '');
  const runs = ['01234567890', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm'];
  const isRun = alnum.length >= 6 && runs.some((r) => r.includes(alnum) || [...r].reverse().join('').includes(alnum));
  if (isRun || /^(password|passcode|passw0rd|babymonitor|letmein|iloveyou|welcome|monitor|qwerty)/.test(alnum)) return 'That one is too easy to guess.';
  for (const w of avoid) {
    const n = (w || '').trim().toLowerCase();
    if (n.length >= 3 && lower.replace(/[^a-z]/g, '').includes(n.replace(/[^a-z]/g, '')) && lower.replace(/[^a-z]/g, '').length - n.replace(/[^a-z]/g, '').length < 4) {
      return 'Don’t build it from the baby’s or nursery’s name.';
    }
  }
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  if (p.length < 12 && kinds < 2) return 'Mix letters and numbers, or use 12+ characters (a short phrase works well).';
  return null;
}

/** 128 plain words (7 bits each): 4 of them plus two digits ≈ 35 bits, PBKDF2-hashed and lock-guarded. */
const PASS_WORDS: readonly string[] = [
  'amber', 'anchor', 'apple', 'aspen', 'autumn', 'badger', 'bamboo', 'basil', 'beacon', 'birch', 'bison',
  'blossom', 'breeze', 'brook', 'cactus', 'canyon', 'cedar', 'cherry', 'cider', 'cloud', 'clover', 'cobalt',
  'comet', 'coral', 'cotton', 'crane', 'creek', 'cricket', 'crystal', 'daisy', 'delta', 'dune', 'eagle',
  'ember', 'falcon', 'fern', 'field', 'finch', 'fjord', 'flint', 'forest', 'fossil', 'garden', 'ginger',
  'glacier', 'granite', 'harbor', 'hazel', 'heron', 'hollow', 'honey', 'island', 'ivory', 'jade', 'juniper',
  'kayak', 'kettle', 'kiwi', 'lagoon', 'lantern', 'lark', 'lemon', 'lilac', 'linen', 'lotus', 'lunar',
  'magnet', 'mango', 'maple', 'marble', 'meadow', 'melon', 'mesa', 'mint', 'moss', 'nectar', 'nutmeg',
  'ocean', 'olive', 'orbit', 'orchid', 'otter', 'panda', 'pebble', 'pepper', 'pine', 'planet', 'plum',
  'poppy', 'prairie', 'quartz', 'quill', 'raven', 'reef', 'ridge', 'river', 'robin', 'saffron', 'sage',
  'sail', 'sequoia', 'shell', 'sierra', 'slate', 'spruce', 'summit', 'swan', 'thistle', 'thunder', 'tide',
  'tulip', 'tundra', 'valley', 'velvet', 'walnut', 'willow', 'wren', 'yarrow', 'zephyr', 'zinnia', 'acorn',
  'bramble', 'cinder', 'dove', 'lichen', 'marsh', 'pumpkin', 'violet',
];

/** A uniformly random integer in [0, n) (rejection sampling — no modulo bias). */
function randomBelow(n: number): number {
  const limit = 256 - (256 % n);
  for (;;) {
    const b = random(1)[0];
    if (b < limit) return b % n;
  }
}

/**
 * A new passcode a person can read aloud and type on a phone: "maple-otter-cedar-heron-42".
 * Words that contain (or are contained in) anything in `avoid` — the baby's or nursery's name —
 * are never used.
 */
export function generatePasscode(avoid: (string | null | undefined)[] = []): string {
  const bad = avoid.map((a) => (a || '').trim().toLowerCase().replace(/[^a-z]/g, '')).filter((a) => a.length >= 3);
  const ok = PASS_WORDS.filter((w) => !bad.some((a) => w.includes(a) || a.includes(w)));
  const pool = ok.length >= 32 ? ok : PASS_WORDS;
  for (;;) {
    const picks = Array.from({ length: 4 }, () => pool[randomBelow(pool.length)]);
    const pass = `${picks.join('-')}-${String(randomBelow(100)).padStart(2, '0')}`;
    if (new Set(picks).size === 4 && !passcodeProblem(pass, avoid)) return pass;
  }
}

/* --------------------------------------------------------------- store */

const toShare = (r: Record<string, unknown>): ShareRow => ({
  id: String(r.id),
  code: String(r.code),
  role: r.role === 'caregiver' ? 'caregiver' : 'viewer',
  created_at: Number(r.created_at),
  created_by: String(r.created_by),
  expires_at: r.expires_at == null ? null : Number(r.expires_at),
  revoked_at: r.revoked_at == null ? null : Number(r.revoked_at),
  fails: Number(r.fails),
  total_fails: Number(r.total_fails),
  locked_until: Number(r.locked_until),
  pass_at: r.pass_at == null ? Number(r.created_at) : Number(r.pass_at),
});
const toGuest = (r: Record<string, unknown>): GuestRow => ({
  id: String(r.id),
  share_id: String(r.share_id),
  name: String(r.name),
  role: r.role === 'caregiver' ? 'caregiver' : 'viewer',
  created_at: Number(r.created_at),
  last_seen: Number(r.last_seen),
  expires_at: Number(r.expires_at),
  revoked_at: r.revoked_at == null ? null : Number(r.revoked_at),
});

export class GuestAccess {
  private ipTries = new Map<string, { n: number; since: number }>();
  private rounds: number;
  /** `link`: today's link-wide lock. `guest`: per-joiner locks (ADR 0006 D6.2). */
  readonly lockout: 'link' | 'guest';
  private limits: GuestLimits;

  /** `opts` may be just the PBKDF2 rounds (tests use few). */
  constructor(private sql: SqlExec, opts: number | GuestAccessOptions = PBKDF2_ROUNDS) {
    const o = typeof opts === 'number' ? { rounds: opts } : opts;
    this.rounds = o.rounds ?? PBKDF2_ROUNDS;
    this.lockout = o.lockout === 'guest' ? 'guest' : 'link';
    this.limits = o.limits ?? {};
    for (const q of SCHEMA) sql.exec(q);
    // Added after the first release: rooms created before it gain the column once.
    try {
      sql.exec('ALTER TABLE mon_shares ADD COLUMN pass_at INTEGER');
    } catch { /* already there */ }
  }

  /** Attach Rate Limiting bindings after construction (the room has its env by then too). */
  setLimits(limits: GuestLimits): void {
    this.limits = limits;
  }

  /** The link that works right now, if any. */
  activeShare(now: number): ShareRow | null {
    const r = this.sql.exec('SELECT * FROM mon_shares WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1').toArray()[0];
    if (!r) return null;
    const s = toShare(r);
    return s.expires_at != null && s.expires_at <= now ? null : s;
  }

  info(now: number): ShareInfo {
    const s = this.activeShare(now);
    return {
      on: !!s,
      code: s?.code ?? null,
      role: s?.role ?? 'viewer',
      created_at: s?.created_at ?? null,
      created_by: s?.created_by ?? null,
      expires_at: s?.expires_at ?? null,
      locked_until: s && s.locked_until > now ? s.locked_until : null,
      pass_at: s?.pass_at ?? null,
      max_guests: MAX_GUESTS,
      guests: this.guests(now).map(({ id, name, role, created_at, last_seen, expires_at }) => ({ id, name, role, created_at, last_seen, expires_at })),
      requests: s ? this.requests(now) : [],
      ...(this.lockout === 'guest'
        ? {
            lockout: 'guest' as const,
            locked_out: s ? Number(this.sql.exec('SELECT COUNT(*) AS n FROM mon_guest_tries WHERE share_id = ? AND locked_until > ?', s.id, now).toArray()[0]?.n ?? 0) : 0,
          }
        : {}),
    };
  }

  /** A new link and passcode. The old link stops working and its guests are signed out. */
  async createShare(o: { pass: string; role: GuestRole; days: number | null; by: string }, now: number): Promise<{ share: ShareRow; removed: string[] }> {
    const removed = this.revokeShare(now);
    const salt = b64url(random(16));
    const share: ShareRow = {
      id: newGuestId(),
      code: newCode(),
      role: o.role,
      created_at: now,
      created_by: o.by,
      expires_at: o.days ? now + o.days * 24 * 60 * 60_000 : null,
      revoked_at: null,
      fails: 0,
      total_fails: 0,
      locked_until: 0,
      pass_at: now,
    };
    const hash = await pbkdf2(o.pass, salt, this.rounds);
    this.sql.exec(
      'INSERT INTO mon_shares (id, code, pass_hash, salt, rounds, role, created_at, created_by, expires_at, revoked_at, fails, total_fails, locked_until, pass_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,0,0,0,?)',
      share.id, share.code, hash, salt, this.rounds, share.role, share.created_at, share.created_by, share.expires_at, now,
    );
    return { share, removed };
  }

  /**
   * A new passcode on the link that works now — same link, so nothing needs
   * re-sending but the passcode. Guests stay signed in unless `signOut`.
   * Clears any lock and wrong-guess counts. Null when there's no active link.
   */
  async setPasscode(pass: string, signOut: boolean, now: number): Promise<{ removed: string[] } | null> {
    const salt = b64url(random(16));
    const hash = await pbkdf2(pass, salt, this.rounds);
    // Look the link up after the slow hash, so a link replaced meanwhile isn't touched.
    const s = this.activeShare(now);
    if (!s) return null;
    this.sql.exec(
      'UPDATE mon_shares SET pass_hash = ?, salt = ?, rounds = ?, fails = 0, total_fails = 0, locked_until = 0, pass_at = ? WHERE id = ?',
      hash, salt, this.rounds, now, s.id,
    );
    let removed: string[] = [];
    if (signOut) {
      removed = this.guests(now).filter((g) => g.share_id === s.id).map((g) => g.id);
      this.sql.exec('UPDATE mon_guests SET revoked_at = ? WHERE share_id = ? AND revoked_at IS NULL', now, s.id);
    }
    return { removed };
  }

  /**
   * Let the link work longer: `days` more from its current end (or from now,
   * whichever is later), or until a parent turns it off (null). Guests who
   * joined with it keep watching as long — never past 90 days from their join.
   */
  extend(days: number | null, now: number): ShareRow | null {
    const s = this.activeShare(now);
    if (!s) return null;
    const end = days == null ? null : Math.min(Math.max(s.expires_at ?? now, now) + days * DAY_MS, now + GUEST_TTL_MS);
    this.sql.exec('UPDATE mon_shares SET expires_at = ? WHERE id = ?', end, s.id);
    this.sql.exec(
      'UPDATE mon_guests SET expires_at = MIN(?, created_at + ?) WHERE share_id = ? AND revoked_at IS NULL AND expires_at > ?',
      end ?? Number.MAX_SAFE_INTEGER, GUEST_TTL_MS, s.id, now,
    );
    return { ...s, expires_at: end };
  }

  /** Turn the link off; returns the guests that were signed out. */
  revokeShare(now: number): string[] {
    const ids = this.sql
      .exec('SELECT g.id FROM mon_guests g JOIN mon_shares s ON s.id = g.share_id WHERE s.revoked_at IS NULL AND g.revoked_at IS NULL')
      .toArray()
      .map((r) => String(r.id));
    this.sql.exec('UPDATE mon_guests SET revoked_at = ? WHERE revoked_at IS NULL AND share_id IN (SELECT id FROM mon_shares WHERE revoked_at IS NULL)', now);
    this.sql.exec('UPDATE mon_shares SET revoked_at = ? WHERE revoked_at IS NULL', now);
    return ids;
  }

  /** Check the link + passcode and start a guest session. */
  async join(o: { code: string; pass: string; name: string; dev?: string; ip?: string }, now: number): Promise<JoinResult> {
    const c = await this.check(o, now);
    if (c.ok === false) return c as JoinFail;
    return this.issue(c, { name: c.name, dev: o.dev }, now);
  }

  /**
   * Check the link + passcode (counting wrong guesses, locking the link)
   * without starting a session — the room may find the person is already a
   * member. `issue` starts the session.
   */
  async check(o: { code: string; pass: string; name: string; ip?: string; dev?: string }, now: number): Promise<CheckResult> {
    if (o.ip) {
      const t = this.ipTries.get(o.ip);
      const cur = t && now - t.since < IP_WINDOW_MS ? t : { n: 0, since: now };
      cur.n++;
      this.ipTries.set(o.ip, cur);
      if (this.ipTries.size > 2000) this.ipTries.clear();
      if (cur.n > IP_MAX) return { ok: false, reason: 'slow_down', retryAt: cur.since + IP_WINDOW_MS };
    }
    if (!(await this.withinLimits(o.ip))) return { ok: false, reason: 'slow_down', retryAt: now + 60_000 };
    const name = o.name.normalize('NFKC').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 30);
    // Look the link up before anything else, and say nothing about the nursery if it's wrong.
    const row = this.sql.exec('SELECT * FROM mon_shares ORDER BY created_at DESC').toArray().map(toShare).find((s) => sameString(s.code, o.code));
    if (!row) return { ok: false, reason: 'bad_link' };
    if (row.revoked_at != null) return { ok: false, reason: 'off' };
    if (row.expires_at != null && row.expires_at <= now) return { ok: false, reason: 'expired' };
    if (row.locked_until > now) return { ok: false, reason: 'locked', retryAt: row.locked_until, ...(this.lockout === 'guest' ? { scope: 'link' as const } : {}) };
    if (!name) return { ok: false, reason: 'name' };
    let who: string | null = null;
    if (this.lockout === 'guest') {
      who = await joinerKey(row.id, o.ip, o.dev);
      const t = this.tries(row.id, who);
      if (t && t.locked_until > now) return { ok: false, reason: 'locked', retryAt: t.locked_until, scope: 'guest' };
    }

    const full = this.sql.exec('SELECT pass_hash, salt, rounds FROM mon_shares WHERE id = ?', row.id).toArray()[0];
    const hash = await pbkdf2(o.pass, String(full.salt), Number(full.rounds));
    if (!sameString(hash, String(full.pass_hash))) {
      if (who != null) return this.wrongForGuest(row.id, who, now);
      const fails = row.fails + 1;
      const total = row.total_fails + 1;
      if (total >= MAX_FAILS_TOTAL) {
        this.revokeShare(now);
        this.sql.exec('UPDATE mon_shares SET total_fails = ? WHERE id = ?', total, row.id);
        return { ok: false, reason: 'off', disabled: true };
      }
      const lock = fails >= MAX_FAILS_IN_A_ROW;
      this.sql.exec('UPDATE mon_shares SET fails = ?, total_fails = ?, locked_until = ? WHERE id = ?', lock ? 0 : fails, total, lock ? now + LOCK_MS : row.locked_until, row.id);
      return lock ? { ok: false, reason: 'locked', retryAt: now + LOCK_MS } : { ok: false, reason: 'wrong', left: MAX_FAILS_IN_A_ROW - fails };
    }
    this.sql.exec('UPDATE mon_shares SET fails = 0, total_fails = 0 WHERE id = ?', row.id);
    if (who != null) this.sql.exec('DELETE FROM mon_guest_tries WHERE share_id = ? AND who = ?', row.id, who);
    return { ok: true, share: row, name, seal: String(full.pass_hash) };
  }

  /** Rate Limiting bindings, when attached. Fails open: the lockouts still stand behind them. */
  private async withinLimits(ip?: string): Promise<boolean> {
    const { perAddress, perNursery, nursery } = this.limits;
    if (!perAddress && !perNursery) return true;
    try {
      const checks: Promise<{ success: boolean }>[] = [];
      if (perAddress && ip) checks.push(perAddress.limit({ key: `ip:${ip}` }));
      if (perNursery && nursery) checks.push(perNursery.limit({ key: `n:${nursery}` }));
      return (await Promise.all(checks)).every((r) => r?.success !== false);
    } catch {
      return true;
    }
  }

  private tries(shareId: string, who: string): { fails: number; locked_until: number } | null {
    const r = this.sql.exec('SELECT fails, locked_until FROM mon_guest_tries WHERE share_id = ? AND who = ?', shareId, who).toArray()[0];
    return r ? { fails: Number(r.fails), locked_until: Number(r.locked_until) } : null;
  }

  /**
   * A wrong passcode under `guest` lockout. Read and written in one synchronous step (after the
   * slow hash), so two joiners guessing at once can't lose a count.
   */
  private wrongForGuest(shareId: string, who: string, now: number): JoinFail {
    const t = this.tries(shareId, who) ?? { fails: 0, locked_until: 0 };
    const fails = t.fails + 1;
    const lock = fails >= MAX_FAILS_IN_A_ROW;
    this.sql.exec(
      `INSERT INTO mon_guest_tries (share_id, who, fails, locked_until, at) VALUES (?,?,?,?,?)
       ON CONFLICT(share_id, who) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until, at = excluded.at`,
      shareId, who, lock ? 0 : fails, lock ? now + LOCK_MS : t.locked_until, now,
    );
    const total = Number(this.sql.exec('SELECT total_fails FROM mon_shares WHERE id = ?', shareId).toArray()[0]?.total_fails ?? 0) + 1;
    if (total >= MAX_FAILS_TOTAL) {
      // Many people (or one with many addresses) guessing: hold the whole link for an hour.
      // Guests already watching are not affected; parents are told by the room.
      this.sql.exec('UPDATE mon_shares SET fails = 0, total_fails = 0, locked_until = ? WHERE id = ?', now + LINK_LOCK_MS, shareId);
      return { ok: false, reason: 'locked', retryAt: now + LINK_LOCK_MS, scope: 'link' };
    }
    this.sql.exec('UPDATE mon_shares SET total_fails = ? WHERE id = ?', total, shareId);
    return lock ? { ok: false, reason: 'locked', retryAt: now + LOCK_MS, scope: 'guest' } : { ok: false, reason: 'wrong', left: MAX_FAILS_IN_A_ROW - fails };
  }

  /**
   * Start a guest session on a link whose passcode was just accepted. The
   * caller may have waited on Supabase since `check`, and the room handles
   * other messages meanwhile — so the link is read again here, in the same
   * synchronous step as the insert: turned off, replaced, expired or given a
   * new passcode since (a parent's "set a new passcode and sign out guests")
   * and nobody gets in with the old one.
   */
  async issue(c: { share: ShareRow; seal: string }, o: { name: string; dev?: string }, now: number): Promise<JoinResult> {
    const token = newToken();
    const tokenHash = await sha256(token);
    // Nothing below awaits: no other message can run between this check and the insert.
    const cur = this.sql.exec('SELECT * FROM mon_shares WHERE id = ?', c.share.id).toArray()[0];
    if (!cur || cur.revoked_at != null) return { ok: false, reason: 'off' };
    const share = toShare(cur);
    if (share.expires_at != null && share.expires_at <= now) return { ok: false, reason: 'expired' };
    if (!sameString(String(cur.pass_hash), c.seal)) return { ok: false, reason: 'wrong' };
    const active = Number(this.sql.exec('SELECT COUNT(*) AS n FROM mon_guests WHERE share_id = ? AND revoked_at IS NULL AND expires_at > ?', share.id, now).toArray()[0]?.n ?? 0);
    if (active >= MAX_GUESTS) return { ok: false, reason: 'full' };
    const guest: GuestRow = {
      id: newGuestId(),
      share_id: share.id,
      name: o.name,
      role: share.role,
      created_at: now,
      last_seen: now,
      expires_at: Math.min(share.expires_at ?? Infinity, now + GUEST_TTL_MS),
      revoked_at: null,
    };
    this.sql.exec(
      'INSERT INTO mon_guests (id, share_id, token_hash, name, role, dev, created_at, last_seen, expires_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?,NULL)',
      guest.id, guest.share_id, tokenHash, guest.name, guest.role, (o.dev || '').slice(0, 40) || null, now, now, guest.expires_at,
    );
    return { ok: true, token, guest };
  }

  /** A guest's socket token → their session, if it's still good. */
  async verify(token: string, now: number): Promise<GuestRow | null> {
    if (!token || token.length > 100) return null;
    const r = this.sql
      .exec(
        `SELECT g.* FROM mon_guests g JOIN mon_shares s ON s.id = g.share_id
         WHERE g.token_hash = ? AND g.revoked_at IS NULL AND g.expires_at > ? AND s.revoked_at IS NULL`,
        await sha256(token),
        now,
      )
      .toArray()[0];
    if (!r) return null;
    this.sql.exec('UPDATE mon_guests SET last_seen = ? WHERE id = ?', now, String(r.id));
    return { ...toGuest(r), last_seen: now };
  }

  guests(now: number): GuestRow[] {
    return this.sql
      .exec(
        `SELECT g.* FROM mon_guests g JOIN mon_shares s ON s.id = g.share_id
         WHERE g.revoked_at IS NULL AND g.expires_at > ? AND s.revoked_at IS NULL ORDER BY g.created_at`,
        now,
      )
      .toArray()
      .map(toGuest);
  }

  /**
   * Hash a passcode ahead of a removal (`'auto'`: make a new one — see generatePasscode). The
   * caller checks a parent-chosen one with passcodeProblem first.
   */
  async preparePasscode(pass: string | 'auto', avoid: (string | null | undefined)[] = []): Promise<PreparedPass> {
    const p = pass === 'auto' ? generatePasscode(avoid) : pass;
    const salt = b64url(random(16));
    return { pass: p, hash: await pbkdf2(p, salt, this.rounds), salt, rounds: this.rounds };
  }

  /**
   * Give the working link a new secret code — and, with `pass`, a new passcode — keeping its
   * role, end date and the guests who are watching (their passes move to the new link). The
   * old link answers "turned off" from now on. Synchronous, so nothing can slip in between.
   * Null when there's no working link.
   */
  rotateLink(now: number, o: { pass?: PreparedPass } = {}): { share: ShareRow; code: string; pass: string | null } | null {
    const s = this.activeShare(now);
    if (!s) return null;
    const cur = this.sql.exec('SELECT pass_hash, salt, rounds FROM mon_shares WHERE id = ?', s.id).toArray()[0];
    const next: ShareRow = { ...s, id: newGuestId(), code: newCode(), created_at: now, revoked_at: null, fails: 0, total_fails: 0, locked_until: 0, pass_at: o.pass ? now : s.pass_at };
    this.sql.exec(
      'INSERT INTO mon_shares (id, code, pass_hash, salt, rounds, role, created_at, created_by, expires_at, revoked_at, fails, total_fails, locked_until, pass_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,0,0,0,?)',
      next.id, next.code, o.pass ? o.pass.hash : String(cur.pass_hash), o.pass ? o.pass.salt : String(cur.salt), o.pass ? o.pass.rounds : Number(cur.rounds),
      next.role, now, next.created_by, next.expires_at, next.pass_at,
    );
    this.sql.exec('UPDATE mon_guests SET share_id = ? WHERE share_id = ? AND revoked_at IS NULL', next.id, s.id);
    this.sql.exec('UPDATE mon_shares SET revoked_at = ? WHERE id = ?', now, s.id);
    this.sql.exec('DELETE FROM mon_guest_tries WHERE share_id = ?', s.id);
    return { share: next, code: next.code, pass: o.pass ? o.pass.pass : null };
  }

  /**
   * Remove one guest: their pass ends now, and the link gets a new code so they can't simply
   * rejoin with the link and passcode they have (F3). Pass `pass` (from preparePasscode) to
   * change the passcode too — the removed person knows the old one. Everyone else keeps
   * watching. Null when there's no such guest.
   */
  removeGuest(id: string, now: number, o: { pass?: PreparedPass } = {}): RemovedGuest | null {
    const g = this.guests(now).find((x) => x.id === id);
    if (!g) return null;
    this.sql.exec('UPDATE mon_guests SET revoked_at = ? WHERE id = ?', now, id);
    const r = this.rotateLink(now, o);
    return { id: g.id, name: g.name, newLink: { code: r?.code ?? '', pass: r?.pass ?? null } };
  }

  /* --------------------------------------------- guests with an account */

  /** A guest who has a Stream Studio account (uid from their verified token). One open request per person. */
  addRequest(o: { uid: string; account: string; name: string; guest_id: string }, now: number): RequestRow {
    this.sql.exec('UPDATE mon_requests SET resolved_at = ? WHERE uid = ? AND resolved_at IS NULL', now, o.uid);
    const row: RequestRow = { id: newGuestId(), uid: o.uid.slice(0, 64), account: o.account.slice(0, 40), name: o.name.slice(0, 30), guest_id: o.guest_id, at: now };
    this.sql.exec('INSERT INTO mon_requests (id, uid, account, name, guest_id, at, resolved_at) VALUES (?,?,?,?,?,?,NULL)', row.id, row.uid, row.account, row.name, row.guest_id, row.at);
    return row;
  }

  /** Open requests whose guest pass still works (a removed guest's request goes with them). */
  requests(now: number): ShareInfo['requests'] {
    return this.sql
      .exec(
        `SELECT r.id, r.uid, r.account, r.name, r.guest_id, r.at, g.role FROM mon_requests r
         JOIN mon_guests g ON g.id = r.guest_id JOIN mon_shares s ON s.id = g.share_id
         WHERE r.resolved_at IS NULL AND g.revoked_at IS NULL AND g.expires_at > ? AND s.revoked_at IS NULL ORDER BY r.at`,
        now,
      )
      .toArray()
      .map((r) => ({
        id: String(r.id),
        uid: String(r.uid),
        account: String(r.account),
        name: String(r.name),
        guest_id: String(r.guest_id),
        role: r.role === 'caregiver' ? 'caregiver' : 'viewer',
        at: Number(r.at),
      }));
  }

  /** People Supabase now lists as members: their requests are done. Returns those requests. */
  resolveRequests(memberIds: Set<string>, now: number): ShareInfo['requests'] {
    const done = this.requests(now).filter((r) => memberIds.has(r.uid));
    for (const r of done) this.sql.exec('UPDATE mon_requests SET resolved_at = ? WHERE id = ?', now, r.id);
    return done;
  }

  /** A parent chose to keep someone a guest. */
  dismissRequest(id: string, now: number): boolean {
    const open = this.requests(now).some((r) => r.id === id);
    if (open) this.sql.exec('UPDATE mon_requests SET resolved_at = ? WHERE id = ?', now, id);
    return open;
  }

  /** Drop long-dead rows (called from the room's retention janitor). */
  purge(now: number): void {
    const cutoff = now - GUEST_TTL_MS;
    this.sql.exec('DELETE FROM mon_requests WHERE (resolved_at IS NOT NULL AND resolved_at < ?) OR at < ?', cutoff, cutoff);
    this.sql.exec('DELETE FROM mon_guests WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?', cutoff, cutoff);
    this.sql.exec('DELETE FROM mon_shares WHERE revoked_at IS NOT NULL AND revoked_at < ? AND id NOT IN (SELECT share_id FROM mon_guests)', cutoff);
    this.sql.exec('DELETE FROM mon_guest_tries WHERE at < ? AND locked_until < ?', now - DAY_MS, now);
  }
}
