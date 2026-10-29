-- Every Stream Studio RPC a signed-in member can call — everything that reads or changes a
-- nursery, its people, the directory or the account's devices — refuses:
--   * a token whose session is gone ("Sign out everywhere", "Not you?", a password reset, an
--     admin revoke, or a session past its not_after) with `session_revoked`;
--   * an aal1 token of someone with a verified second factor with `mfa_required`;
-- and changes nothing when it refuses. A phished password (aal1) or a stolen token whose
-- session was ended must not be able to delete, rename or list a nursery.
--
-- The catalogue check at the end fails when a new live_* / monitor_* function is granted to
-- `authenticated` without calling live__session_problem() (or being listed as exempt here).
\set ON_ERROR_STOP 1

-- ------------------------------------------------------------------ fixtures
insert into auth.users (id, email, created_at) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'ada@example.com', now() - interval '30 days'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'bob@example.com', now() - interval '30 days');
insert into public.live_profiles (user_id, display_name, verified_via) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Ada', 'admin'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'Bob', 'admin');
insert into auth.sessions (id, user_id, user_agent, ip) values
  ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Ada UA', '203.0.113.77'),
  ('22222222-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-00000000000b', 'Bob UA', '198.51.100.9');

-- "Sign in" as someone: the claims PostgREST would set from their access token.
create function pg_temp.as_user(p_sub text, p_sid text, p_aal text default 'aal1') returns void language sql as $$
  select set_config('request.jwt.claims',
    jsonb_strip_nulls(jsonb_build_object('sub', p_sub, 'session_id', p_sid, 'aal', p_aal, 'role', 'authenticated'))::text, false);
$$;

-- Every member RPC, called the way a client would (as `authenticated`). The order matters only
-- for the success run: monitor_delete goes last, on a nursery made for it.
create function pg_temp.member_rpcs(p_nid uuid, p_other uuid, p_spare uuid) returns table (fn text, r jsonb)
language plpgsql as $$
declare
  v_dev uuid;
begin
  fn := 'live_me';               r := public.live_me();                                         return next;
  fn := 'live_join';             r := public.live_join();                                       return next;
  fn := 'live_update_profile';   r := public.live_update_profile('Intruder');                   return next;
  fn := 'live_search_people';    r := public.live_search_people('bo');                          return next;
  fn := 'monitor_list';          r := public.monitor_list();                                    return next;
  fn := 'monitor_create';        r := public.monitor_create('Intruder nursery');                return next;
  fn := 'monitor_update';        r := public.monitor_update(p_nid, 'Renamed by intruder', 'X'); return next;
  fn := 'monitor_people';        r := public.monitor_people(p_nid);                             return next;
  fn := 'monitor_member_ids';    r := public.monitor_member_ids(p_nid);                         return next;
  fn := 'monitor_my_role';       r := public.monitor_my_role(p_nid);                            return next;
  fn := 'monitor_set_member';    r := public.monitor_set_member(p_nid, p_other, 'parent');      return next;
  fn := 'monitor_remove_member'; r := public.monitor_remove_member(p_nid, p_other);             return next;
  fn := 'live_device_enroll';    r := public.live_device_enroll(repeat('D', 43), 'web', 'Intruder laptop');
  v_dev := coalesce((r->'device'->>'id')::uuid, 'dddddddd-0000-0000-0000-00000000000d');                return next;
  fn := 'live_device_list';      r := public.live_device_list();                                return next;
  fn := 'live_device_revoke';    r := public.live_device_revoke(v_dev);                         return next;
  fn := 'live_security_events';  r := public.live_security_events(5);                           return next;
  fn := 'live_mfa_status';       r := public.live_mfa_status();                                 return next;
  fn := 'live_mfa_activate';     r := public.live_mfa_activate(nullif(current_setting('t.factor', true), '')::uuid); return next;
  fn := 'live_mfa_codes_regenerate'; r := public.live_mfa_codes_regenerate();                   return next;
  fn := 'monitor_delete';        r := public.monitor_delete(p_spare);                           return next;
end $$;
grant execute on function pg_temp.member_rpcs(uuid, uuid, uuid) to authenticated;

-- Ada makes the nursery (and a spare one to delete) and adds Bob as a viewer.
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001');
set role authenticated;
do $$ declare r jsonb; begin
  r := public.monitor_create('Nursery', 'Aria');
  assert r->>'ok' = 'true', r::text;
  perform set_config('t.nid', r->'nursery'->>'id', false);
  r := public.monitor_create('Spare room');
  assert r->>'ok' = 'true', r::text;
  perform set_config('t.spare', r->'nursery'->>'id', false);
  r := public.monitor_set_member((current_setting('t.nid'))::uuid, 'bbbbbbbb-0000-0000-0000-00000000000b', 'viewer');
  assert r->>'ok' = 'true', r::text;
end $$;
reset role;

-- Nothing a refused call could have touched has moved.
create function pg_temp.assert_untouched(p_why text) returns void language plpgsql as $$
begin
  assert (select count(*) from public.monitor_nurseries) = 2, p_why || ': a nursery was created or deleted';
  assert (select name from public.monitor_nurseries where id = current_setting('t.nid')::uuid) = 'Nursery', p_why || ': nursery renamed';
  assert (select baby_name from public.monitor_nurseries where id = current_setting('t.nid')::uuid) = 'Aria', p_why || ': baby renamed';
  assert (select role from public.monitor_members where nursery_id = current_setting('t.nid')::uuid
            and user_id = 'bbbbbbbb-0000-0000-0000-00000000000b') = 'viewer', p_why || ': Bob''s role changed or he was removed';
  assert (select display_name from public.live_profiles where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a') = 'Ada', p_why || ': profile renamed';
  assert not exists (select 1 from public.live_devices), p_why || ': a device was enrolled';
  assert not exists (select 1 from public.live_mfa_recovery_codes), p_why || ': recovery codes were made';
end $$;

-- Run every member RPC as the current claims and expect each to refuse with p_error.
create function pg_temp.expect_all_refused(p_error text) returns void language plpgsql as $$
declare
  x record;
  n integer := 0;
begin
  for x in select * from pg_temp.member_rpcs(current_setting('t.nid')::uuid, 'bbbbbbbb-0000-0000-0000-00000000000b', current_setting('t.spare')::uuid) loop
    n := n + 1;
    assert x.r->>'error' = p_error, format('%s should refuse with %s, got %s', x.fn, p_error, x.r);
    assert coalesce(x.r->>'ok', 'false') = 'false', format('%s said ok while refusing: %s', x.fn, x.r);
    assert coalesce(x.r->>'member', 'false') = 'false', format('%s still says member: %s', x.fn, x.r);
  end loop;
  assert n = 20, n::text;
end $$;
grant execute on function pg_temp.expect_all_refused(text) to authenticated;

-- 1. A session that no longer exists (signed out everywhere / "Not you?").
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', '99999999-0000-0000-0000-000000000009');
set role authenticated;
select pg_temp.expect_all_refused('session_revoked');
reset role;
select pg_temp.assert_untouched('revoked session');

-- 2. A token with no session_id at all.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal1"}', false);
set role authenticated;
select pg_temp.expect_all_refused('session_revoked');
reset role;
select pg_temp.assert_untouched('no session id');

-- 3. A session past its not_after (time-boxed sessions).
update auth.sessions set not_after = now() - interval '1 minute' where id = '11111111-0000-0000-0000-000000000001';
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001');
set role authenticated;
select pg_temp.expect_all_refused('session_revoked');
reset role;
select pg_temp.assert_untouched('expired session');
update auth.sessions set not_after = null where id = '11111111-0000-0000-0000-000000000001';

-- 4. Someone else's session id in Ada's token.
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-000000000002');
set role authenticated;
select pg_temp.expect_all_refused('session_revoked');
reset role;
select pg_temp.assert_untouched('another person''s session');

-- 5. Ada turns on two-step sign-in (switched on here a day ago, so this session was signed in
-- after it). Her password alone (aal1) — e.g. phished — gets nothing.
insert into auth.mfa_factors (id, user_id, status) values ('fafafafa-0000-0000-0000-00000000000f', 'aaaaaaaa-0000-0000-0000-00000000000a', 'verified');
insert into public.live_mfa_factors (factor_id, user_id, activated_at) values ('fafafafa-0000-0000-0000-00000000000f', 'aaaaaaaa-0000-0000-0000-00000000000a', now() - interval '1 day');
insert into public.live_mfa_on (user_id, since) values ('aaaaaaaa-0000-0000-0000-00000000000a', now() - interval '1 day');
select set_config('t.factor', 'fafafafa-0000-0000-0000-00000000000f', false);
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001', 'aal1');
set role authenticated;
select pg_temp.expect_all_refused('mfa_required');
reset role;
select pg_temp.assert_untouched('aal1 with a verified factor');
-- A missing `aal` claim counts as aal1.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","session_id":"11111111-0000-0000-0000-000000000001","role":"authenticated"}', false);
set role authenticated;
select pg_temp.expect_all_refused('mfa_required');
reset role;
select pg_temp.assert_untouched('no aal claim with a verified factor');

-- 5b. The lost-phone path serves exactly the session that still owes the code — and nothing else
-- about a refused session: a dead one gets nothing, a wrong code changes nothing.
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001', 'aal1');
set role authenticated;
do $$ declare r jsonb; begin
  r := public.live_mfa_recover('wxyz-wxyz-wxyz');
  assert r->>'error' = 'invalid_code', r::text;
end $$;
reset role;
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', '99999999-0000-0000-0000-000000000009', 'aal1');
set role authenticated;
do $$ declare r jsonb; begin
  r := public.live_mfa_recover('wxyz-wxyz-wxyz');
  assert r->>'error' = 'session_revoked', r::text;
end $$;
reset role;
delete from public.live_mfa_attempts;
do $$ begin
  assert exists (select 1 from auth.mfa_factors where id = 'fafafafa-0000-0000-0000-00000000000f'), 'a refused recovery removed the authenticator';
end $$;

-- 6. The same calls with her second factor (aal2) all work.
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001', 'aal2');
set role authenticated;
do $$
declare
  x record;
begin
  for x in select * from pg_temp.member_rpcs(current_setting('t.nid')::uuid, 'bbbbbbbb-0000-0000-0000-00000000000b', current_setting('t.spare')::uuid) loop
    assert x.r->>'error' is null, format('%s refused an aal2 parent: %s', x.fn, x.r);
    assert coalesce(x.r->>'ok', x.r->>'member') = 'true', format('%s failed for an aal2 parent: %s', x.fn, x.r);
  end loop;
end $$;
reset role;
do $$ begin
  assert (select name from public.monitor_nurseries where id = current_setting('t.nid')::uuid) = 'Renamed by intruder';
  assert not exists (select 1 from public.monitor_nurseries where id = current_setting('t.spare')::uuid), 'spare deleted';
  assert not exists (select 1 from public.monitor_members where nursery_id = current_setting('t.nid')::uuid
                       and user_id = 'bbbbbbbb-0000-0000-0000-00000000000b'), 'Bob removed';
end $$;

-- 7. Someone without a second factor (Bob) is unaffected on aal1.
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-00000000000b', '22222222-0000-0000-0000-000000000002', 'aal1');
set role authenticated;
do $$ declare r jsonb; begin
  r := public.live_me();
  assert r->>'member' = 'true', r::text;
  r := public.monitor_list();
  assert r->>'ok' = 'true', r::text;
  r := public.live_search_people('intr'); -- Ada renamed herself in step 6
  assert r->>'ok' = 'true' and jsonb_array_length(r->'people') = 1, r::text;
  r := public.monitor_create('Bob''s nursery');
  assert r->>'ok' = 'true', r::text;
  r := public.monitor_people((r->'nursery'->>'id')::uuid);
  assert r->>'ok' = 'true', r::text;
  r := public.live_update_profile('Bobby');
  assert r->>'ok' = 'true', r::text;
end $$;
reset role;

-- 8. Signed out entirely: the old answers, no session check needed.
select set_config('request.jwt.claims', '', false);
do $$ begin
  assert public.monitor_list()->>'error' = 'not_member';
  assert public.monitor_delete(current_setting('t.nid')::uuid)->>'error' = 'forbidden';
  assert public.monitor_people(current_setting('t.nid')::uuid)->>'error' = 'forbidden';
  assert public.live_join()->>'error' = 'not_signed_in';
end $$;

-- 9. The catalogue: every live_*/monitor_* function a signed-in client may execute checks the
-- session — except the three that exist to work without one.
do $$
declare
  exempt text[] := array[
    'live_welcome_check',  -- before an account exists (anon)
    'live_device_active',  -- a watch trading its device grant; no Supabase session by design
    'live_secure_account'  -- "Not you?": the person may be locked out
  ];
  covered text[];
  f record;
  e text;
begin
  -- The functions pg_temp.member_rpcs() calls (keep the two in step).
  covered := array['live_me', 'live_join', 'live_update_profile', 'live_search_people', 'monitor_list', 'monitor_create',
                   'monitor_update', 'monitor_people', 'monitor_member_ids', 'monitor_my_role', 'monitor_set_member',
                   'monitor_remove_member', 'live_device_enroll', 'live_device_list', 'live_device_revoke',
                   'live_security_events', 'live_mfa_status', 'live_mfa_activate', 'live_mfa_codes_regenerate',
                   'monitor_delete',
                   -- serves a session that still owes the code (step 5b), refuses an ended one
                   'live_mfa_recover'];
  for f in
    select p.proname, p.prosrc
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and (p.proname like 'live%' or p.proname like 'monitor%')
      and has_function_privilege('authenticated', p.oid, 'execute')
  loop
    if f.proname = any (exempt) then
      continue;
    end if;
    assert f.prosrc like '%live__session_problem()%', f.proname || ' is callable by signed-in clients but never checks the session (add the guard, or list it as exempt with a reason)';
    assert f.proname = any (covered), f.proname || ' checks the session but has no behaviour test in member_rpc_guards.test.sql';
  end loop;
  -- The exempt ones really are reachable without a session, and nothing exempt went stale.
  foreach e in array exempt loop
    assert exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = e
                     and has_function_privilege('anon', p.oid, 'execute')), e || ' is listed as exempt but anon can''t call it';
  end loop;
end $$;

\echo MEMBER_RPC_GUARDS_OK
