-- Two-step sign-in, end to end (ADR 0006 WS-5 review): a parent must never be locked out of
-- their own account or lose their nursery camera because of it.
--   * switching it on needs a fresh sign-in (a stolen session can't), counts only authenticators
--     switched on here, and hands out recovery codes;
--   * sessions signed in BEFORE it was switched on keep watching (camera, bedside monitor) but
--     still need the code for anything that changes who can see the nursery;
--   * a recovery code gets a parent who lost their phone back in;
--   * "Not you?" removes authenticators an intruder switched on, keeps the parent's own;
--   * stray authenticators (never switched on here) are tidied away.
\set ON_ERROR_STOP 1

-- ------------------------------------------------------------------ fixtures
insert into auth.users (id, email, created_at) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'ada@example.com', now() - interval '30 days'),
  ('dddddddd-0000-0000-0000-00000000000d', 'dee@example.com', now() - interval '30 days');
insert into public.live_profiles (user_id, display_name, verified_via) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Ada', 'admin'),
  ('dddddddd-0000-0000-0000-00000000000d', 'Dee', 'admin');
-- Ada's nursery camera (signed in two days ago) and her phone (signed in ten minutes ago).
insert into auth.sessions (id, user_id, created_at, user_agent, ip) values
  ('ca11ca11-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', now() - interval '2 days', 'Camera phone', '203.0.113.5'),
  ('f0f0f0f0-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-00000000000a', now() - interval '10 minutes', 'Mozilla/5.0 (iPhone) Safari', '203.0.113.6'),
  ('dee00000-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-00000000000d', now() - interval '3 days', 'Dee UA', '198.51.100.7');
insert into vault.secrets values ('SECURITY_HOOK_SECRET', 'test-secret');
insert into public.live_private_config (key, value) values ('security_hook_url', 'https://email.example.workers.dev/security');

create function pg_temp.as_user(p_sub text, p_sid text, p_aal text default 'aal1', p_amr jsonb default null) returns void language sql as $$
  select set_config('request.jwt.claims',
    jsonb_strip_nulls(jsonb_build_object('sub', p_sub, 'session_id', p_sid, 'aal', p_aal, 'role', 'authenticated', 'amr', p_amr))::text, false);
$$;
create function pg_temp.camera(p_aal text default 'aal1') returns void language sql as $$
  select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', 'ca11ca11-0000-0000-0000-000000000001', p_aal,
    jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now() - interval '2 days')::bigint)));
$$;
create function pg_temp.phone(p_aal text default 'aal1') returns void language sql as $$
  select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', 'f0f0f0f0-0000-0000-0000-000000000002', p_aal,
    jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now() - interval '10 minutes')::bigint)));
$$;

-- Ada makes her nursery before any of this.
select pg_temp.phone();
set role authenticated;
do $$ declare r jsonb; begin
  r := public.monitor_create('Nursery', 'Aria');
  assert r->>'ok' = 'true', r::text;
  perform set_config('t.nid', r->'nursery'->>'id', false);
end $$;
reset role;

-- 1. A fresh sign-in, from the token's amr or the session's own age; never from a stale one.
select pg_temp.camera();
do $$ begin assert not public.live__recent_sign_in(30), 'a two-day-old camera session is not a fresh sign-in'; end $$;
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', 'ca11ca11-0000-0000-0000-000000000001', 'aal1',
  jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint),
                    jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now() - interval '5 minutes')::bigint)));
do $$ begin assert public.live__recent_sign_in(30), 'a password typed 5 minutes ago (amr) is fresh'; end $$;
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', 'ca11ca11-0000-0000-0000-000000000001', 'aal1',
  jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)));
do $$ begin assert not public.live__recent_sign_in(30), 'a fresh authenticator code alone is not a fresh sign-in'; end $$;
select pg_temp.phone();
do $$ begin assert public.live__recent_sign_in(30), 'a session signed in 10 minutes ago is fresh'; end $$;

-- 2. Switching it on. Ada's phone adds authenticator F1 (verified in Supabase: aal2).
insert into auth.mfa_factors (id, user_id, status, friendly_name, created_at)
values ('f1f1f1f1-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'verified', 'Authenticator 1', now() - interval '2 minutes');
-- Until it's switched on here it changes nothing: the camera is a member as before.
select pg_temp.camera();
set role authenticated;
do $$ declare r jsonb; begin
  r := public.live_me();
  assert r->>'member' = 'true' and r->>'mfa' = 'false', r::text;
  -- Without its code on this session: refused.
  r := public.live_mfa_activate('f1f1f1f1-0000-0000-0000-000000000001');
  assert r->>'error' = 'mfa_required', r::text;
end $$;
reset role;
-- A stolen, stale session that somehow reached aal2 still can't switch it on: no fresh sign-in.
select pg_temp.camera('aal2');
set role authenticated;
do $$ declare r jsonb; begin
  r := public.live_mfa_activate('f1f1f1f1-0000-0000-0000-000000000001');
  assert r->>'error' = 'reauth_required', r::text;
  r := public.live_mfa_activate('99999999-0000-0000-0000-000000000009');
  assert r->>'error' = 'not_found', r::text;
end $$;
reset role;
do $$ begin
  assert not exists (select 1 from public.live_mfa_factors), 'refused activation changed nothing';
  assert not exists (select 1 from public.live_mfa_recovery_codes);
end $$;
-- Ada's phone, fresh sign-in, code given: on, with ten recovery codes, emailed.
select pg_temp.phone('aal2');
set role authenticated;
do $$ declare r jsonb; c text; begin
  r := public.live_mfa_activate('f1f1f1f1-0000-0000-0000-000000000001');
  assert r->>'ok' = 'true' and r->>'first' = 'true', r::text;
  assert jsonb_array_length(r->'codes') = 10, r::text;
  for c in select jsonb_array_elements_text(r->'codes') loop
    assert c ~ '^[2-9a-hjkmnp-z]{4}-[2-9a-hjkmnp-z]{4}-[2-9a-hjkmnp-z]{4}$', c;
  end loop;
  perform set_config('t.code', r->'codes'->>0, false);
  perform set_config('t.code2', r->'codes'->>1, false);
  -- The same again: already on, no new codes.
  r := public.live_mfa_activate('f1f1f1f1-0000-0000-0000-000000000001');
  assert r->>'ok' = 'true' and r->>'already' = 'true' and jsonb_array_length(r->'codes') = 0, r::text;
  r := public.live_mfa_status();
  assert r->>'on' = 'true' and (r->>'codes_left')::int = 10 and jsonb_array_length(r->'factors') = 1
     and r->'factors'->0->>'name' = 'Authenticator 1' and r->>'grace' = 'false', r::text;
end $$;
reset role;
do $$ declare c record; p jsonb; begin
  assert not exists (select 1 from public.live_mfa_recovery_codes where code_hash = current_setting('t.code')), 'codes are stored hashed';
  assert (select count(*) from public.security_events where kind = 'mfa_on' and secure_hash is not null and notified) = 1;
  select * into c from net.calls order by id desc limit 1;
  p := (c.body->>'p')::jsonb;
  assert p->>'kind' = 'mfa_on' and p->>'email' = 'ada@example.com' and p->>'ua' = 'Mozilla/5.0 (iPhone) Safari' and p->>'token' ~ '^[A-Za-z0-9_-]{32}$', p::text;
  perform set_config('t.mfa_on_token', p->>'token', false);
end $$;

-- 3. The nursery camera was signed in BEFORE: it keeps watching without the code — but nothing
-- that changes who can see the nursery works from it until someone types the code there.
select pg_temp.camera();
set role authenticated;
do $$ declare r jsonb; nid uuid := current_setting('t.nid')::uuid; begin
  r := public.live_me();
  assert r->>'member' = 'true' and r->>'mfa' = 'true' and r->>'mfa_grace' = 'true' and r->>'aal' = 'aal1', r::text;
  r := public.monitor_my_role(nid);
  assert r->>'ok' = 'true' and r->>'role' = 'parent' and r->>'mfa' = 'true' and r->>'mfa_grace' = 'true', r::text;
  r := public.monitor_list();
  assert r->>'ok' = 'true', r::text;
  r := public.monitor_people(nid);
  assert r->>'ok' = 'true', r::text;
  r := public.live_mfa_status();
  assert r->>'ok' = 'true' and r->>'grace' = 'true', r::text;
  -- admin actions: the code first
  r := public.monitor_set_member(nid, 'dddddddd-0000-0000-0000-00000000000d', 'viewer');
  assert r->>'error' = 'mfa_required', r::text;
  r := public.monitor_remove_member(nid, 'aaaaaaaa-0000-0000-0000-00000000000a');
  assert r->>'error' = 'mfa_required', r::text;
  r := public.monitor_delete(nid);
  assert r->>'error' = 'mfa_required', r::text;
  r := public.live_device_enroll(repeat('C', 43), 'web', 'Camera');
  assert r->>'error' = 'mfa_required', r::text;
  r := public.live_mfa_codes_regenerate();
  assert r->>'error' = 'mfa_required', r::text;
end $$;
reset role;
do $$ begin
  assert exists (select 1 from public.monitor_nurseries where id = current_setting('t.nid')::uuid), 'nursery still there';
  assert not exists (select 1 from public.monitor_members where user_id = 'dddddddd-0000-0000-0000-00000000000d'), 'nobody added';
end $$;
-- A session signed in AFTER it was switched on (a phished password) gets nothing at aal1.
insert into auth.sessions (id, user_id, created_at, user_agent, ip)
values ('0e0e0e0e-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-00000000000a', now() + interval '1 second', 'Intruder', '192.0.2.9');
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', '0e0e0e0e-0000-0000-0000-000000000004', 'aal1');
set role authenticated;
do $$ declare r jsonb; begin
  r := public.live_me();
  assert r->>'error' = 'mfa_required' and r->>'member' = 'false', r::text;
  r := public.monitor_my_role(current_setting('t.nid')::uuid);
  assert r->>'error' = 'mfa_required', r::text;
end $$;
reset role;
-- The access token hook tells the Worker the same: ds_mfa for both, ds_mfa_grace for the camera only.
do $$ declare r jsonb; begin
  r := public.live_access_token_hook(jsonb_build_object('user_id', 'aaaaaaaa-0000-0000-0000-00000000000a', 'authentication_method', 'token_refresh',
        'claims', jsonb_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000000a', 'session_id', 'ca11ca11-0000-0000-0000-000000000001', 'aal', 'aal1')));
  assert r->'claims'->>'ds_mfa' = 'true' and r->'claims'->>'ds_mfa_grace' = 'true', r::text;
  r := public.live_access_token_hook(jsonb_build_object('user_id', 'aaaaaaaa-0000-0000-0000-00000000000a', 'authentication_method', 'token_refresh',
        'claims', jsonb_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000000a', 'session_id', '0e0e0e0e-0000-0000-0000-000000000004', 'aal', 'aal1')));
  assert r->'claims'->>'ds_mfa' = 'true' and r->'claims'->>'ds_mfa_grace' = 'false', r::text;
  r := public.live_access_token_hook(jsonb_build_object('user_id', 'dddddddd-0000-0000-0000-00000000000d', 'authentication_method', 'token_refresh',
        'claims', jsonb_build_object('sub', 'dddddddd-0000-0000-0000-00000000000d', 'session_id', 'dee00000-0000-0000-0000-000000000003', 'aal', 'aal1')));
  assert r->'claims'->>'ds_mfa' = 'false' and r->'claims'->>'ds_mfa_grace' = 'false', r::text;
end $$;

-- 4. A second authenticator needs only the code (aal2), even on an older session; no new codes.
insert into auth.mfa_factors (id, user_id, status, friendly_name, created_at)
values ('f2f2f2f2-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-00000000000a', 'verified', 'Authenticator 2', now());
select pg_temp.camera('aal2');
set role authenticated;
do $$ declare r jsonb; begin
  r := public.live_mfa_activate('f2f2f2f2-0000-0000-0000-000000000002');
  assert r->>'ok' = 'true' and r->>'first' = 'false' and jsonb_array_length(r->'codes') = 0, r::text;
  r := public.live_mfa_status();
  assert jsonb_array_length(r->'factors') = 2 and (r->>'codes_left')::int = 10, r::text;
end $$;
reset role;
do $$ begin
  assert exists (select 1 from public.security_events where kind = 'mfa_added');
  assert ((select body->>'p' from net.calls order by id desc limit 1)::jsonb)->>'kind' = 'mfa_added';
end $$;

-- 5. Lost phone: the recovery code, from the session that still owes the code.
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', '0e0e0e0e-0000-0000-0000-000000000004', 'aal1');
set role authenticated;
do $$ declare r jsonb; i int; begin
  for i in 1..5 loop
    r := public.live_mfa_recover('2222-3333-4444');
    assert r->>'error' = 'invalid_code', r::text;
  end loop;
  -- Five wrong codes in 15 minutes: even the right one waits (guessing stays hopeless).
  r := public.live_mfa_recover(current_setting('t.code'));
  assert r->>'error' = 'too_many', r::text;
end $$;
reset role;
do $$ begin
  assert (select count(*) from auth.mfa_factors where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a') = 2, 'nothing removed while limited';
  update public.live_mfa_attempts set at = now() - interval '16 minutes';
end $$;
set role authenticated;
do $$ declare r jsonb; begin
  -- typed loosely: upper case, spaces instead of dashes
  r := public.live_mfa_recover(upper(replace(current_setting('t.code'), '-', ' ')));
  assert r->>'ok' = 'true' and (r->>'removed')::int = 2, r::text;
  -- back in, password only, and told to set it up again
  r := public.live_me();
  assert r->>'member' = 'true' and r->>'mfa' = 'false', r::text;
  -- a second code has nothing left to do
  r := public.live_mfa_recover(current_setting('t.code2'));
  assert r->>'ok' = 'true' and r->>'already_off' = 'true', r::text;
end $$;
reset role;
do $$ begin
  assert not exists (select 1 from auth.mfa_factors where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a');
  assert not exists (select 1 from public.live_mfa_factors where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a');
  assert not exists (select 1 from public.live_mfa_on where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a');
  assert not exists (select 1 from public.live_mfa_recovery_codes where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a');
  assert exists (select 1 from public.security_events where kind = 'mfa_recovered' and secure_hash is not null);
  assert ((select body->>'p' from net.calls order by id desc limit 1)::jsonb)->>'kind' = 'mfa_recovered';
end $$;

-- 6. Stray authenticators: one verified in Supabase but never switched on here goes after an
-- hour (a stolen session can't leave one behind to block the parent); a younger one stays.
insert into auth.mfa_factors (id, user_id, status, created_at) values
  ('5a5a5a5a-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'verified', now() - interval '2 hours'),
  ('5a5a5a5a-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-00000000000a', 'verified', now() - interval '10 minutes');
select pg_temp.phone();
set role authenticated;
do $$ declare r jsonb; begin
  r := public.live_mfa_status();
  assert r->>'ok' = 'true' and r->>'on' = 'false' and jsonb_array_length(r->'factors') = 0, r::text;
end $$;
reset role;
do $$ begin
  assert not exists (select 1 from auth.mfa_factors where id = '5a5a5a5a-0000-0000-0000-000000000001'), 'stray removed';
  assert exists (select 1 from auth.mfa_factors where id = '5a5a5a5a-0000-0000-0000-000000000002'), 'a set-up in progress stays';
  delete from auth.mfa_factors where id = '5a5a5a5a-0000-0000-0000-000000000002';
end $$;

-- 7. Removed in Supabase (turned off on another device): noted, and the codes go with it.
insert into auth.mfa_factors (id, user_id, status, created_at)
values ('f3f3f3f3-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-00000000000a', 'verified', now());
select pg_temp.phone('aal2');
set role authenticated;
do $$ declare r jsonb; begin
  r := public.live_mfa_activate('f3f3f3f3-0000-0000-0000-000000000003');
  assert r->>'first' = 'true' and jsonb_array_length(r->'codes') = 10, r::text;
end $$;
reset role;
delete from auth.mfa_factors where id = 'f3f3f3f3-0000-0000-0000-000000000003';
set role authenticated;
do $$ declare r jsonb; begin
  r := public.live_mfa_status();
  assert r->>'on' = 'false' and (r->>'codes_left')::int = 0, r::text;
end $$;
reset role;
do $$ begin
  assert exists (select 1 from public.security_events where kind = 'mfa_removed' and detail->>'factor_id' = 'f3f3f3f3-0000-0000-0000-000000000003');
  assert not exists (select 1 from public.live_mfa_on where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a');
end $$;

-- 8. "Not you?" — an intruder with the password signs in and turns two-step sign-in on before
-- the parent notices. The parent's own authenticator (from last week) stays; theirs goes.
-- (a) Dee had two-step sign-in on already.
insert into auth.mfa_factors (id, user_id, status, created_at)
values ('d1d1d1d1-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000d', 'verified', now() - interval '7 days');
insert into public.live_mfa_factors (factor_id, user_id, session_id, activated_at)
values ('d1d1d1d1-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000d', 'dee00000-0000-0000-0000-000000000003', now() - interval '7 days');
insert into public.live_mfa_on (user_id, since) values ('dddddddd-0000-0000-0000-00000000000d', now() - interval '7 days');
-- the intruder's sign-in, five minutes ago, with the email's one-time token
insert into auth.sessions (id, user_id, created_at, user_agent, ip)
values ('baadbaad-0000-0000-0000-000000000005', 'dddddddd-0000-0000-0000-00000000000d', now() - interval '5 minutes', 'Intruder', '192.0.2.66');
insert into public.security_events (user_id, session_id, kind, at, secure_hash)
values ('dddddddd-0000-0000-0000-00000000000d', 'baadbaad-0000-0000-0000-000000000005', 'sign_in', now() - interval '5 minutes',
        encode(extensions.digest('intruder-sign-in-token-0123456789', 'sha256'), 'hex'));
-- … who then added their own authenticator (they had Dee's code? no — say it was before Dee had
-- one; here it shows the window rule) and made new recovery codes.
insert into auth.mfa_factors (id, user_id, status, created_at)
values ('baadf00d-0000-0000-0000-000000000006', 'dddddddd-0000-0000-0000-00000000000d', 'verified', now() - interval '4 minutes');
insert into public.live_mfa_factors (factor_id, user_id, session_id, activated_at)
values ('baadf00d-0000-0000-0000-000000000006', 'dddddddd-0000-0000-0000-00000000000d', 'baadbaad-0000-0000-0000-000000000005', now() - interval '3 minutes');
insert into public.live_mfa_recovery_codes (user_id, code_hash) values ('dddddddd-0000-0000-0000-00000000000d', 'x');
insert into public.security_events (user_id, session_id, kind, at) values ('dddddddd-0000-0000-0000-00000000000d', 'baadbaad-0000-0000-0000-000000000005', 'mfa_codes', now() - interval '2 minutes');
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
do $$ declare r jsonb; begin
  r := public.live_secure_account('intruder-sign-in-token-0123456789');
  assert r->>'ok' = 'true' and (r->>'factors_removed')::int = 1, r::text;
  assert r->>'user_id' = 'dddddddd-0000-0000-0000-00000000000d' and r->'nurseries' = '[]'::jsonb, r::text;
end $$;
do $$ begin
  assert exists (select 1 from auth.mfa_factors where id = 'd1d1d1d1-0000-0000-0000-000000000001'), 'the parent''s own authenticator stays';
  assert not exists (select 1 from auth.mfa_factors where id = 'baadf00d-0000-0000-0000-000000000006'), 'the intruder''s goes';
  assert not exists (select 1 from public.live_mfa_factors where factor_id = 'baadf00d-0000-0000-0000-000000000006');
  assert exists (select 1 from public.live_mfa_on where user_id = 'dddddddd-0000-0000-0000-00000000000d'), 'still on (the parent''s)';
  assert not exists (select 1 from public.live_mfa_recovery_codes where user_id = 'dddddddd-0000-0000-0000-00000000000d'), 'codes the intruder made are gone';
  assert (select (detail->>'factors')::int from public.security_events where kind = 'secured' and user_id = 'dddddddd-0000-0000-0000-00000000000d') = 1;
end $$;
-- (b) Ada had none; the intruder (signed in with her password) switched it on from their session.
-- The "two-step sign-in was turned on" email's own Not-you link removes it — and the codes —
-- and the service role learns her nurseries, for the server-side kick.
insert into auth.sessions (id, user_id, created_at, user_agent, ip)
values ('baadbaad-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-00000000000a', now() - interval '1 minute', 'Intruder', '192.0.2.66');
insert into auth.mfa_factors (id, user_id, status, created_at)
values ('baadf00d-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-00000000000a', 'verified', now() - interval '20 minutes');
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', 'baadbaad-0000-0000-0000-000000000007', 'aal2');
set role authenticated;
do $$ declare r jsonb; begin
  r := public.live_mfa_activate('baadf00d-0000-0000-0000-000000000008');
  assert r->>'ok' = 'true' and r->>'first' = 'true', r::text;
end $$;
reset role;
do $$ declare p jsonb; r jsonb; begin
  p := ((select body->>'p' from net.calls order by id desc limit 1))::jsonb;
  assert p->>'kind' = 'mfa_on', p::text;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', false);
  r := public.live_secure_account(p->>'token');
  assert r->>'ok' = 'true' and (r->>'factors_removed')::int = 1, r::text;
  assert r->'nurseries' = jsonb_build_array(current_setting('t.nid')::uuid), r::text;
  assert not exists (select 1 from auth.mfa_factors where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a');
  assert not exists (select 1 from public.live_mfa_on where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a');
  assert not exists (select 1 from public.live_mfa_recovery_codes where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a');
  assert not exists (select 1 from auth.sessions where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a');
end $$;
-- anon callers get no account id or nursery list
do $$ declare r jsonb; begin
  insert into public.security_events (user_id, session_id, kind, secure_hash)
  values ('dddddddd-0000-0000-0000-00000000000d', gen_random_uuid(), 'sign_in', encode(extensions.digest('anon-caller-token-0123456789abcdef', 'sha256'), 'hex'));
  perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  r := public.live_secure_account('anon-caller-token-0123456789abcdef');
  assert r->>'ok' = 'true' and r->'user_id' is null and r->'nurseries' is null and r->'email' is null, r::text;
end $$;

-- 9. grants
do $$ begin
  assert has_function_privilege('authenticated', 'public.live_mfa_status()', 'execute');
  assert has_function_privilege('authenticated', 'public.live_mfa_activate(uuid)', 'execute');
  assert has_function_privilege('authenticated', 'public.live_mfa_recover(text)', 'execute');
  assert has_function_privilege('authenticated', 'public.live_mfa_codes_regenerate()', 'execute');
  assert not has_function_privilege('anon', 'public.live_mfa_recover(text)', 'execute');
  assert not has_function_privilege('authenticated', 'public.live__new_recovery_codes(uuid)', 'execute');
  assert not has_function_privilege('authenticated', 'public.live__mfa_tidy(uuid)', 'execute');
  assert not has_function_privilege('authenticated', 'public.live__notify_mfa(uuid, bigint, text)', 'execute');
  assert not has_function_privilege('authenticated', 'public.live__send_security_alert(uuid, bigint, text, text, text, text)', 'execute');
  assert not has_table_privilege('authenticated', 'public.live_mfa_recovery_codes', 'select');
  assert not has_table_privilege('authenticated', 'public.live_mfa_factors', 'select');
  assert not has_table_privilege('anon', 'public.live_mfa_on', 'select');
end $$;
\echo MFA_LIFECYCLE_OK
