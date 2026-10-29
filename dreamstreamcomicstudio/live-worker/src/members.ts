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
 *   4. the nursery's room hears it at once — `/x/members {ids, removed, by, op, role}` — and
 *      (ADR 0006 WS-9) closes a removed person's monitor, family-call line, admin and glance
 *      sockets, drops their push targets, asks for a new nursery key, re-checks anyone whose
 *      role changed, and tells every parent. TURN usernames it hands back are revoked here.
 *   → 200 `{ok: true, changed, removed, told}`. `told` says whether the room confirmed. The
 *     change itself is committed either way (the RPC succeeded), so ok stays true; an app that
 *     sees `told: false` can still nudge the room the old way (`members_changed`), and the
 *     room's own 6-hour role re-check catches up regardless.
 *
 * Works before live_security_v2.sql is applied: the old RPCs answer just `{ok: true}`, so the
 * person named in the request is the one who changed. `role` without a `label` keeps the
 * person's label (the RPC alone would clear it).
 */

import { parseMembersRequest, type MembersRequest } from '../../packages/monitor-core/src/wire';
import { kickResult, methodNotAllowed, parseJson, readBody, reply, revokeTurnUsernames, rpcFailure, tellRoom, UUID_RE, verifyCaller, type KickEnv } from './kick';
import { callRpc, stepUpNeeded } from './supabaseAuth';

export interface MembersOptions {
  fetcher?: typeof fetch;
  now?: number;
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

/** The person's current label in this nursery, so a role change doesn't wipe "Grandma". null if unknown. */
async function currentLabel(env: KickEnv, token: string, nid: string, user: string, fetcher?: typeof fetch): Promise<string | null> {
  const r = await callRpc<{ ok?: boolean; people?: { user_id?: unknown; label?: unknown }[] }>(env, token, 'monitor_people', { p_nursery: nid }, fetcher);
  if (!r.ok || !r.data?.ok || !Array.isArray(r.data.people)) return null;
  const me = r.data.people.find((p) => String(p?.user_id ?? '').toLowerCase() === user);
  return typeof me?.label === 'string' ? me.label : null;
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
  const removed = body.op === 'remove' ? (uuids(d.removed) ?? [body.user]) : [];
  const role = typeof d.role === 'string' ? d.role : (body.role ?? null);
  const told =
    changed.length || removed.length
      ? await tellRoom(env, nid, '/x/members', {
          ids: [...new Set([...changed, ...removed])],
          removed,
          by: caller.uid,
          op: body.op,
          role,
          ...(typeof d.previous_role === 'string' ? { previous: d.previous_role } : {}),
          ...(typeof d.added === 'boolean' ? { added: d.added } : {}),
          ...(d.left === true ? { left: true } : {}),
        })
      : null;
  if (told) {
    const { turn } = kickResult(told);
    if (turn.length) ctx.waitUntil(revokeTurnUsernames(env, turn, opts.fetcher).catch(() => 0));
    if (!told.ok) console.warn(JSON.stringify({ evt: 'members_untold', op: body.op, status: told.status }));
  }
  return reply({ ok: true, changed, removed, told: told ? told.ok : true });
}
