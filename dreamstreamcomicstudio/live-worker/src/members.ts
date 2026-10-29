/**
 * Membership changes go through the Worker (ADR 0006 D6.2 "Removed member or guest", F2/F6):
 *
 *   POST /api/monitor/:nid/members     Authorization: Bearer <Supabase access token>
 *     {op: 'add' | 'role' | 'remove', user, role?, label?}       (wire.ts MembersRequest)
 *   1. the body is checked before anything is asked (parseMembersRequest);
 *   2. the caller's token is verified; anyone with a second factor must present aal2 (403
 *      `mfa_required` — the app's step-up then retries);
 *   3. the membership RPC runs with the caller's OWN token, so Supabase decides who may do what
 *      exactly as before (parents add/remove/change roles; anyone may leave or relabel
 *      themselves; the owner stays a parent);
 *   4. the nursery's room hears it at once — `/x/members {ids, removed, by, op, role, at}` — and
 *      (ADR 0006 WS-9) closes a removed person's monitor, family-call line, admin and glance
 *      sockets, drops their push targets, asks for a new nursery key, re-checks anyone whose
 *      role changed, and tells every parent. TURN usernames it hands back are revoked here.
 *   → 200 `{ok: true, changed, removed, told: true}` when the room confirmed.
 *   → 202 `{ok: false, error: 'unconfirmed', committed: true, changed, removed, told: false}`
 *     when the change TAKES ACCESS AWAY (a removal, a lower role) and the room didn't confirm:
 *     the membership change is committed, but the person's open monitor may not be closed yet,
 *     so it isn't "done". The Worker keeps telling the room in the background (RETRY_DELAYS_MS,
 *     after re-checking with Supabase that a removed person hasn't been added back), and asking
 *     again is safe: a removal of someone already gone still tells the room. The app can also
 *     nudge the room the old way (`members_changed`); the room's 6-hour re-check catches up
 *     regardless.
 *   An addition (or a higher role) gives access rather than taking it: it is `ok` either way,
 *   with `told` saying whether the room confirmed — the room asks Supabase on the person's
 *   first socket anyway.
 *
 * Works before live_security_v2.sql is applied: the old RPCs answer just `{ok: true}`, so the
 * person named in the request is the one who changed. `role` without a `label` keeps the
 * person's label (the RPC alone would clear it).
 */

import { parseMembersRequest, type MembersRequest } from '../../packages/monitor-core/src/wire';
import { kickResult, methodNotAllowed, parseJson, readBody, reply, retryable, RETRY_DELAYS_MS, revokeTurnUsernames, rpcFailure, tellRoom, UUID_RE, verifyCaller, type KickEnv } from './kick';
import { callRpc, stepUpNeeded } from './supabaseAuth';

export interface MembersOptions {
  fetcher?: typeof fetch;
  now?: number;
  /** Background retries when the room didn't hear (tests shorten them). */
  retryDelaysMs?: readonly number[];
}

/** Worker → room `/x/members` (wire.ts XMembersBody, as the room reads it). */
interface MembersMessage {
  ids: string[];
  removed: string[];
  by: string;
  op: MembersRequest['op'];
  role: string | null;
  /** When the change was made (ms): a room applies a person's changes in this order, so a late retry never undoes a newer one. */
  at: number;
  previous?: string;
  added?: boolean;
  left?: true;
}

const RANK: Record<string, number> = { viewer: 0, caregiver: 1, parent: 2 };

/** Does this change take access away (so it isn't done until the room has closed what the person had open)? */
function takesAway(op: MembersRequest['op'], removed: readonly string[], role: string | null, previous: unknown, added: unknown): boolean {
  if (removed.length) return true;
  if (typeof previous === 'string' && previous in RANK && role != null && role in RANK) return RANK[role] < RANK[previous];
  // A new member: nothing to take away. Anything we can't tell: treat it as taking away.
  return !(op === 'add' && added === true);
}

type RpcAnswer = { ok?: boolean; error?: string; changed?: unknown; removed?: unknown; role?: unknown; previous_role?: unknown; added?: unknown; left?: unknown };

/** The membership RPCs' refusals → HTTP (codes the app already explains: client.ts monitorError). */
function refusal(error: string | undefined): Response {
  const e = typeof error === 'string' && /^[a-z_]{1,40}$/.test(error) ? error : 'unknown';
  if (e === 'session_revoked') return reply({ ok: false, error: 'auth' }, 401);
  if (e === 'forbidden' || e === 'mfa_required') return reply({ ok: false, error: e }, 403);
  if (e === 'not_member' || e === 'owner_is_parent' || e === 'limit_reached') return reply({ ok: false, error: e }, 409);
  return reply({ ok: false, error: e }, 400);
}

const uuids = (v: unknown): string[] | null =>
  Array.isArray(v) ? [...new Set(v.map((x) => String(x).toLowerCase()).filter((x) => UUID_RE.test(x)))].slice(0, 40) : null;

/** The nursery's people right now (user id → label), asked with the caller's token; null if Supabase couldn't say. */
async function nurseryPeople(env: KickEnv, token: string, nid: string, fetcher?: typeof fetch): Promise<Map<string, string | null> | null> {
  const r = await callRpc<{ ok?: boolean; people?: { user_id?: unknown; label?: unknown }[] }>(env, token, 'monitor_people', { p_nursery: nid }, fetcher);
  if (!r.ok || !r.data?.ok || !Array.isArray(r.data.people)) return null;
  return new Map(r.data.people.map((p) => [String(p?.user_id ?? '').toLowerCase(), typeof p?.label === 'string' ? p.label : null]));
}

/** The person's current label in this nursery, so a role change doesn't wipe "Grandma". null if unknown. */
async function currentLabel(env: KickEnv, token: string, nid: string, user: string, fetcher?: typeof fetch): Promise<string | null> {
  return (await nurseryPeople(env, token, nid, fetcher))?.get(user) ?? null;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The room didn't hear a change: tell it again after each pause until it confirms or refuses
 * (a 4xx — a room without `/x/members` yet — is an answer). Before re-sending a removal, Supabase
 * is asked who is in the nursery now: someone a parent has added back since is re-checked, never
 * cut off.
 */
async function keepTelling(env: KickEnv, nid: string, msg: MembersMessage, token: string, delays: readonly number[], fetcher?: typeof fetch): Promise<void> {
  for (const delay of delays) {
    await pause(delay);
    let next = msg;
    if (msg.removed.length) {
      const people = await nurseryPeople(env, token, nid, fetcher);
      // Supabase can't say: send it as made — `at` lets the room order it against newer changes.
      if (people && msg.removed.some((u) => people.has(u))) {
        // Back in the nursery since: re-checked, not removed — and no stale "left" notice for the parents.
        const { left: _left, ...rest } = msg;
        next = { ...rest, removed: msg.removed.filter((u) => !people.has(u)) };
      }
    }
    const t = await tellRoom(env, nid, '/x/members', next);
    if (t.ok) {
      const { turn } = kickResult(t);
      if (turn.length) await revokeTurnUsernames(env, turn, fetcher).catch(() => 0);
      console.warn(JSON.stringify({ evt: 'members_told_late', op: msg.op }));
      return;
    }
    if (!retryable(t)) break;
  }
  console.warn(JSON.stringify({ evt: 'members_untold', op: msg.op, final: true }));
}

/** POST /api/monitor/:nid/members. `nid` has already been checked as a nursery id. */
export async function handleMembers(req: Request, env: KickEnv, ctx: Pick<ExecutionContext, 'waitUntil'>, nid: string, opts: MembersOptions = {}): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed('POST');
  if (!UUID_RE.test(nid)) return reply({ ok: false, error: 'not_found' }, 404);
  const raw = await readBody(req, 2048);
  if (raw == null) return reply({ ok: false, error: 'bad_request' }, 413);
  const body: MembersRequest | null = parseMembersRequest(parseJson(raw));
  if (!body) return reply({ ok: false, error: 'bad_request' }, 400);

  const caller = await verifyCaller(req, env, { fetcher: opts.fetcher, now: opts.now });
  if (!caller.ok) return caller.res;
  // Admin action: the second sign-in step, for anyone who has one (D6.2, acceptance criterion 5).
  if (caller.id && stepUpNeeded(caller.id)) return reply({ ok: false, error: 'mfa_required' }, 403);

  let res;
  if (body.op === 'remove') {
    res = await callRpc<RpcAnswer>(env, caller.token, 'monitor_remove_member', { p_nursery: nid, p_user: body.user }, opts.fetcher);
  } else {
    const label = body.label !== undefined ? body.label : body.op === 'role' ? await currentLabel(env, caller.token, nid, body.user, opts.fetcher) : null;
    res = await callRpc<RpcAnswer>(env, caller.token, 'monitor_set_member', { p_nursery: nid, p_user: body.user, p_role: body.role, p_label: label }, opts.fetcher);
  }
  if (!res.ok) {
    const f = rpcFailure(res.status);
    return reply({ ok: false, error: f.error }, f.status);
  }
  const d: RpcAnswer = res.data || {};
  if (d.ok !== true) return refusal(d.error);

  // live_security_v2.sql names who changed; before it, the person in the request did.
  const changed = uuids(d.changed) ?? [body.user];
  // A removal always names the person: after `ok` from the RPC they aren't a member, whether this
  // call removed them or an earlier one did whose room never heard (asking again must reach it).
  const removed = body.op === 'remove' ? [...new Set([...(uuids(d.removed) ?? []), body.user])] : [];
  const role = typeof d.role === 'string' ? d.role : (body.role ?? null);
  if (!changed.length && !removed.length) return reply({ ok: true, changed, removed, told: true });

  const msg: MembersMessage = {
    ids: [...new Set([...changed, ...removed])],
    removed,
    by: caller.uid,
    op: body.op,
    role,
    at: opts.now ?? Date.now(),
    ...(typeof d.previous_role === 'string' ? { previous: d.previous_role } : {}),
    ...(typeof d.added === 'boolean' ? { added: d.added } : {}),
    ...(d.left === true ? { left: true as const } : {}),
  };
  const told = await tellRoom(env, nid, '/x/members', msg, { keep: (p) => ctx.waitUntil(p) });
  const { turn } = kickResult(told);
  if (turn.length) ctx.waitUntil(revokeTurnUsernames(env, turn, opts.fetcher).catch(() => 0));
  if (told.ok) return reply({ ok: true, changed, removed, told: true });

  console.warn(JSON.stringify({ evt: 'members_untold', op: body.op, status: told.status }));
  if (retryable(told)) ctx.waitUntil(keepTelling(env, nid, msg, caller.token, opts.retryDelaysMs ?? RETRY_DELAYS_MS, opts.fetcher).catch(() => undefined));
  if (takesAway(body.op, removed, role, d.previous_role, d.added)) {
    return reply({ ok: false, error: 'unconfirmed', committed: true, changed, removed, told: false }, 202);
  }
  return reply({ ok: true, changed, removed, told: false });
}
