/**
 * Who may hold a monitor socket, decided cheaply and re-decided often (ADR 0006 D5.4, D9 #17,
 * WS-9's `onAuth`/`reauth`):
 *
 *   1. The access token is verified locally (supabaseAuth.verifyAccessToken: JWKS, no RPC).
 *   2. The nursery role comes from a per-room cache {uid → role, label, name, mfa}, asked of
 *      Supabase (monitor_my_role, with the person's own token) on first sight, when the room is
 *      told membership changed (`drop`), and every 6 hours.
 *   3. Two-step sign-in is enforced for anyone with a verified factor: an aal1 token is refused
 *      with 4003 (`mfa_required`), from the token's `ds_mfa` claim or, without the hook, from the
 *      role check's `mfa` answer (live_security_v2.sql). The cache never refuses on its own: a
 *      fresh claim beats it, and a cached "has a factor" against an aal1 token only sends the
 *      question back to Supabase — so someone who turned two-step sign-in off isn't locked out
 *      for up to 6 hours by the room's memory.
 *   4. A socket may stay open until its token's `exp + 120 s` (`closeAt`); a `reauth` with a
 *      fresh token — same person — moves that on.
 *
 * Outage rule (a baby monitor must keep working): if Supabase can't be reached, a member the
 * room already knows keeps their cached role ("stale"); someone the room has never seen waits
 * (1013, try again). Removal never waits on Supabase: /x/members and /x/kick `drop` entries.
 */

import type { SqlExec } from '../monitorStore';
import { EXPIRY_GRACE_MS, callRpc, mfaProblem, verifyAccessToken, type AccessIdentity, type SupabaseEnv } from '../supabaseAuth';

export type MonRole = 'parent' | 'caregiver' | 'viewer';

/** Close codes (the shared contract — ADR 0006 checklist §1). */
export const CLOSE = {
  /** Token expired (and not renewed within the grace), or not a token at all: sign in again. */
  EXPIRED: 4001,
  /** Has a second factor; this token is only aal1. */
  MFA_REQUIRED: 4003,
  /** Removed from the nursery, signed out everywhere, or a different person. */
  REMOVED: 4004,
  /** Couldn't check right now (Supabase unreachable) — try again shortly. Standard WebSocket code. */
  TRY_AGAIN: 1013,
} as const;
export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE];

/** Re-ask Supabase about a cached member at least this often. */
export const ROLE_TTL_MS = 6 * 3600_000;

export interface RoleEntry {
  uid: string;
  role: MonRole;
  label: string | null;
  name: string;
  /** Has a verified second factor (Supabase's answer at `at`). */
  mfa: boolean;
  /** When Supabase last vouched for this, epoch ms. */
  at: number;
}

export interface RoleStore {
  get(uid: string): RoleEntry | null;
  put(entry: RoleEntry): void;
  /** Forget these people (or everyone): their next admission asks Supabase. */
  drop(uids?: Iterable<string>): void;
}

const asRole = (v: unknown): MonRole | null => (v === 'parent' || v === 'caregiver' || v === 'viewer' ? v : null);

/** The room's cache in its own SQLite (one small row per member, rewritten at most every 6 h). */
export class SqlRoleStore implements RoleStore {
  constructor(private sql: SqlExec) {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS mon_roles (
        uid TEXT PRIMARY KEY, role TEXT NOT NULL, label TEXT, name TEXT NOT NULL, mfa INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL
      ) WITHOUT ROWID`,
    );
  }

  get(uid: string): RoleEntry | null {
    const r = this.sql.exec('SELECT * FROM mon_roles WHERE uid = ?', uid).toArray()[0];
    const role = r ? asRole(r.role) : null;
    if (!r || !role) return null;
    return { uid: String(r.uid), role, label: r.label == null ? null : String(r.label), name: String(r.name), mfa: Number(r.mfa) === 1, at: Number(r.at) };
  }

  put(e: RoleEntry): void {
    this.sql.exec(
      `INSERT INTO mon_roles (uid, role, label, name, mfa, at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(uid) DO UPDATE SET role = excluded.role, label = excluded.label, name = excluded.name, mfa = excluded.mfa, at = excluded.at`,
      e.uid, e.role, e.label, e.name.slice(0, 40), e.mfa ? 1 : 0, e.at,
    );
  }

  drop(uids?: Iterable<string>): void {
    if (!uids) {
      this.sql.exec('DELETE FROM mon_roles');
      return;
    }
    for (const u of uids) this.sql.exec('DELETE FROM mon_roles WHERE uid = ?', u);
  }
}

/** In-memory store (tests, or rooms that don't persist the cache). */
export class MemoryRoleStore implements RoleStore {
  private m = new Map<string, RoleEntry>();
  get(uid: string): RoleEntry | null {
    return this.m.get(uid) ?? null;
  }
  put(e: RoleEntry): void {
    this.m.set(e.uid, { ...e });
  }
  drop(uids?: Iterable<string>): void {
    if (!uids) this.m.clear();
    else for (const u of uids) this.m.delete(u);
  }
}

export type AdmitFailure = 'expired' | 'invalid' | 'mfa_required' | 'revoked' | 'removed' | 'mismatch' | 'unavailable';

export type Admission =
  | {
      ok: true;
      id: AccessIdentity;
      role: MonRole;
      label: string | null;
      name: string;
      mfa: boolean;
      /** Where the role came from: the cache, Supabase just now, or a stale cache during an outage. */
      checked: 'cache' | 'rpc' | 'stale';
      /** Close the socket at this time (epoch ms) unless it re-authenticates first. */
      closeAt: number;
    }
  | { ok: false; code: CloseCode; reason: AdmitFailure };

const fail = (reason: AdmitFailure): Admission => ({
  ok: false,
  reason,
  code:
    reason === 'mfa_required'
      ? CLOSE.MFA_REQUIRED
      : reason === 'unavailable'
        ? CLOSE.TRY_AGAIN
        : reason === 'expired' || reason === 'invalid'
          ? CLOSE.EXPIRED
          : CLOSE.REMOVED,
});

/** When a socket admitted with a token expiring at `exp` (epoch s) must close unless renewed. */
export const closeAtFor = (exp: number): number => exp * 1000 + EXPIRY_GRACE_MS;

export interface AdmitOptions {
  token: string;
  /** The nursery this room serves. */
  nid: string;
  env: SupabaseEnv;
  store: RoleStore;
  now?: number;
  fetcher?: typeof fetch;
  /** A `reauth`: the token must belong to this same person. */
  expectUid?: string;
  /** Ask Supabase even if the cache is fresh (e.g. a membership-changed nudge for this uid). */
  recheck?: boolean;
}

/**
 * Admit (or re-admit) a member's socket. First frame and `reauth` both call this; only a cache
 * miss, a 6-hour-old entry, or `recheck` costs a Supabase round trip.
 */
export async function admitMember(o: AdmitOptions): Promise<Admission> {
  const now = o.now ?? Date.now();
  const v = await verifyAccessToken(o.token, o.env, { now, fetcher: o.fetcher });
  if (v.ok === false) return fail(v.reason === 'malformed' ? 'invalid' : v.reason);
  const id = v.id;
  if (o.expectUid && id.uid !== o.expectUid.toLowerCase()) return fail('mismatch');
  if (mfaProblem(id)) return fail('mfa_required');

  const cached = o.store.get(id.uid);
  const ok = (e: RoleEntry, checked: 'cache' | 'rpc' | 'stale'): Admission => {
    // Supabase's answer just now is the truth; otherwise the token's signed claim beats our
    // memory of it (they may have turned two-step sign-in off since), and the cache only fills
    // in when the hook is off.
    const mfa = checked === 'rpc' ? e.mfa : (id.mfa ?? e.mfa);
    // Without the token claim (hook off), Supabase's own answer still demands aal2.
    if (mfa && id.aal !== 'aal2') return fail('mfa_required');
    return { ok: true, id: { ...id, mfa }, role: e.role, label: e.label, name: e.name, mfa, checked, closeAt: closeAtFor(id.exp) };
  };
  // A cached "has a second factor" against an aal1 token is never a reason to refuse on its own
  // (the claim already said no, or there is none): it only means "ask Supabase", which knows.
  // So a stale cache can cost a round trip, never lock someone out.
  const doubt = (e: RoleEntry): boolean => e.mfa && id.aal !== 'aal2';
  if (cached && !o.recheck && now - cached.at < ROLE_TTL_MS && !doubt(cached)) return ok(cached, 'cache');

  const res = await callRpc<{ ok?: boolean; error?: string; user_id?: string; role?: string; label?: string | null; display_name?: string | null; mfa?: boolean }>(
    o.env,
    o.token,
    'monitor_my_role',
    { p_nursery: o.nid },
    o.fetcher,
  );
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return fail('invalid');
    if (!cached) return fail('unavailable');
    // Outage: a known member keeps their cached role. If the cache doubts an aal1 token, the
    // token's own claim settles it (ok() prefers it); with no claim to go on, "try again
    // shortly" — neither a 4003 from memory nor letting a possibly-phished password in.
    if (doubt(cached) && id.mfa == null) return fail('unavailable');
    return ok(cached, 'stale');
  }
  const d = res.data || {};
  if (d.error === 'session_revoked') return fail('revoked');
  if (d.error === 'mfa_required') return fail('mfa_required');
  const role = asRole(d.role);
  if (!d.ok || !role) {
    o.store.drop([id.uid]);
    return fail('removed');
  }
  if (typeof d.user_id !== 'string' || d.user_id.toLowerCase() !== id.uid) return fail('invalid');
  const entry: RoleEntry = {
    uid: id.uid,
    role,
    label: typeof d.label === 'string' ? d.label.slice(0, 30) : null,
    name: String(d.display_name || 'Member').slice(0, 40),
    mfa: d.mfa === true,
    at: now,
  };
  o.store.put(entry);
  return ok(entry, 'rpc');
}
