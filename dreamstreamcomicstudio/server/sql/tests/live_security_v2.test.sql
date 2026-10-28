\set ON_ERROR_STOP 1
-- fixtures
insert into auth.users (id, email, created_at) values
 ('aaaaaaaa-0000-0000-0000-00000000000a', 'ada@example.com', now() - interval '30 days'),
 ('bbbbbbbb-0000-0000-0000-00000000000b', 'bob@example.com', now() - interval '30 days');
insert into public.live_profiles (user_id, display_name, verified_via) values
 ('aaaaaaaa-0000-0000-0000-00000000000a', 'Ada', 'admin'),
 ('bbbbbbbb-0000-0000-0000-00000000000b', 'Bob', 'admin');
insert into auth.sessions (id, user_id, user_agent, ip) values
 ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Mozilla/5.0 (Macintosh) Chrome/130', '203.0.113.77'),
 ('22222222-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-00000000000b', 'Bob UA', '2001:db8:abcd:12::1');
insert into auth.refresh_tokens (session_id) values ('11111111-0000-0000-0000-000000000001');
insert into vault.secrets values ('SECURITY_HOOK_SECRET', 'test-secret');
insert into public.live_private_config (key, value) values ('security_hook_url', 'https://email.example.workers.dev/security');

create or replace function pg_temp.as_user(p_sub text, p_sid text, p_aal text default 'aal1') returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'session_id', p_sid, 'aal', p_aal, 'role', 'authenticated')::text, false);
$$;

do $$ begin
  assert public.live__mask_ip('203.0.113.77'::inet) = '203.0.113.x', public.live__mask_ip('203.0.113.77'::inet);
  assert public.live__mask_ip('2001:db8:abcd:12::1'::inet) = '2001:db8:abcd::/48', public.live__mask_ip('2001:db8:abcd:12::1'::inet);
  assert public.live__mask_ip(null) is null;
end $$;

-- 1. live_me: ok, then revoked
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001');
set role authenticated;
do $$ declare r jsonb; begin
  r := public.live_me();
  assert r->>'member' = 'true' and r->>'mfa' = 'false' and r->>'aal' = 'aal1', r::text;
  r := public.monitor_create('Nursery', 'Aria');
  assert r->>'ok' = 'true', r::text;
  perform set_config('t.nid', r->'nursery'->>'id', false);
end $$;
reset role;
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', '99999999-0000-0000-0000-000000000009');
set role authenticated;
do $$ declare r jsonb; begin
  r := public.live_me();
  assert r->>'error' = 'session_revoked' and r->>'member' = 'false', r::text;
  r := public.monitor_my_role(current_setting('t.nid')::uuid);
  assert r->>'ok' = 'false' and r->>'error' = 'session_revoked', r::text;
  r := public.monitor_set_member(current_setting('t.nid')::uuid, 'bbbbbbbb-0000-0000-0000-00000000000b', 'viewer');
  assert r->>'error' = 'session_revoked', r::text;
end $$;
reset role;
-- missing session_id claim = revoked too
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}', false);
do $$ begin assert public.live_me()->>'error' = 'session_revoked'; end $$;
-- not_after passed = revoked
update auth.sessions set not_after = now() - interval '1 minute' where id = '11111111-0000-0000-0000-000000000001';
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001');
do $$ begin assert public.live_me()->>'error' = 'session_revoked'; end $$;
update auth.sessions set not_after = null where id = '11111111-0000-0000-0000-000000000001';

-- 2. membership changes return ids
set role authenticated;
do $$ declare r jsonb; nid uuid := current_setting('t.nid')::uuid; begin
  r := public.monitor_set_member(nid, 'bbbbbbbb-0000-0000-0000-00000000000b', 'viewer', 'Grandpa');
  assert r->>'ok' = 'true' and r->'changed' = '["bbbbbbbb-0000-0000-0000-00000000000b"]'::jsonb and r->>'added' = 'true' and r->'previous_role' = 'null'::jsonb, r::text;
  r := public.monitor_set_member(nid, 'bbbbbbbb-0000-0000-0000-00000000000b', 'caregiver');
  assert r->>'added' = 'false' and r->>'previous_role' = 'viewer' and r->>'role' = 'caregiver', r::text;
  r := public.monitor_my_role(nid);
  assert r->>'role' = 'parent' and r->>'mfa' = 'false', r::text;
  r := public.monitor_remove_member(nid, 'bbbbbbbb-0000-0000-0000-00000000000b');
  assert r->'removed' = '["bbbbbbbb-0000-0000-0000-00000000000b"]'::jsonb and r->>'left' = 'false', r::text;
  r := public.monitor_remove_member(nid, 'bbbbbbbb-0000-0000-0000-00000000000b');
  assert r->'removed' = '[]'::jsonb, r::text;
  r := public.monitor_set_member(nid, 'bbbbbbbb-0000-0000-0000-00000000000b', 'viewer');
end $$;
reset role;
-- Bob relabels himself; then leaves
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-00000000000b', '22222222-0000-0000-0000-000000000002');
set role authenticated;
do $$ declare r jsonb; nid uuid := current_setting('t.nid')::uuid; begin
  r := public.monitor_set_member(nid, 'bbbbbbbb-0000-0000-0000-00000000000b', 'parent', 'Gramps');
  assert r->>'ok' = 'true' and r->'changed' = '["bbbbbbbb-0000-0000-0000-00000000000b"]'::jsonb, r::text;
  assert public.monitor_my_role(nid)->>'role' = 'viewer';
  r := public.monitor_remove_member(nid, 'bbbbbbbb-0000-0000-0000-00000000000b');
  assert r->>'left' = 'true', r::text;
end $$;
reset role;

-- 3. MFA: verified factor + aal1 = mfa_required; aal2 fine
insert into auth.mfa_factors (user_id, status) values ('aaaaaaaa-0000-0000-0000-00000000000a', 'unverified');
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001');
do $$ begin assert public.live_me()->>'member' = 'true', 'unverified factor must not count'; end $$;
update auth.mfa_factors set status = 'verified';
do $$ declare r jsonb; begin
  r := public.live_me();
  assert r->>'error' = 'mfa_required' and r->>'mfa_required' = 'true' and r->>'member' = 'false', r::text;
  r := public.monitor_my_role(current_setting('t.nid')::uuid);
  assert r->>'error' = 'mfa_required', r::text;
  r := public.live_device_enroll(repeat('A', 43), 'web', 'Laptop');
  assert r->>'error' = 'mfa_required', r::text;
end $$;
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001', 'aal2');
do $$ declare r jsonb; begin
  r := public.live_me();
  assert r->>'member' = 'true' and r->>'mfa' = 'true' and r->>'aal' = 'aal2', r::text;
  r := public.monitor_my_role(current_setting('t.nid')::uuid);
  assert r->>'ok' = 'true' and r->>'mfa' = 'true', r::text;
end $$;

-- 4. devices
set role authenticated;
do $$ declare r jsonb; d uuid; begin
  r := public.live_device_enroll('bad', 'web', 'x');
  assert r->>'error' = 'bad_key', r::text;
  r := public.live_device_enroll(repeat('A', 43), 'toaster', 'x');
  assert r->>'error' = 'bad_platform', r::text;
  r := public.live_device_enroll(repeat('A', 43), 'watchos', '  <b>Ada''s watch</b> ');
  assert r->>'ok' = 'true' and r->>'created' = 'true' and r->'device'->>'name' = 'bAda''s watch/b', r::text;
  d := (r->'device'->>'id')::uuid;
  r := public.live_device_enroll(repeat('A', 43), 'watchos', '');
  assert r->>'created' = 'false' and (r->'device'->>'id')::uuid = d and r->'device'->>'name' = 'Apple Watch', r::text;
  r := public.live_device_list();
  assert jsonb_array_length(r->'devices') = 1, r::text;
  perform set_config('t.dev', d::text, false);
end $$;
reset role;
set role anon;
do $$ declare r jsonb; begin
  r := public.live_device_active(current_setting('t.dev')::uuid, repeat('A', 43));
  assert r->>'active' = 'true', r::text;
  r := public.live_device_active(current_setting('t.dev')::uuid, repeat('B', 43));
  assert r->>'active' = 'false', r::text;
end $$;
reset role;
set role authenticated;
do $$ declare r jsonb; begin
  r := public.live_device_revoke(current_setting('t.dev')::uuid);
  assert r->>'ok' = 'true' and r->>'already' = 'false' and r->'device'->>'thumb' = repeat('A', 43), r::text;
  r := public.live_device_revoke(current_setting('t.dev')::uuid);
  assert r->>'already' = 'true', r::text;
  assert public.live_device_active(current_setting('t.dev')::uuid, repeat('A', 43))->>'active' = 'false';
  -- re-enrolling a revoked key makes a new row
  r := public.live_device_enroll(repeat('A', 43), 'watchos', 'Watch again');
  assert r->>'created' = 'true' and (r->'device'->>'id')::uuid <> current_setting('t.dev')::uuid, r::text;
  r := public.live_security_events(50);
  assert r->>'ok' = 'true' and jsonb_array_length(r->'events') = 3, r::text;
end $$;
reset role;
-- Bob can't revoke Ada's device
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-00000000000b', '22222222-0000-0000-0000-000000000002');
set role authenticated;
do $$ begin assert public.live_device_revoke(current_setting('t.dev')::uuid)->>'error' = 'not_found'; end $$;
reset role;

-- 5. the hook
do $$ declare r jsonb; ev jsonb; begin
  -- a session alive before the hook was switched on: a refresh — recorded, never emailed
  ev := jsonb_build_object('user_id', 'aaaaaaaa-0000-0000-0000-00000000000a', 'authentication_method', 'token_refresh',
        'claims', jsonb_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000000a', 'session_id', '11111111-0000-0000-0000-000000000001', 'aal', 'aal2', 'role', 'authenticated'));
  r := public.live_access_token_hook(ev);
  assert r->'claims'->>'ds_mfa' = 'true' and r->'claims'->>'session_id' = '11111111-0000-0000-0000-000000000001', r::text;
  assert (select count(*) from net.calls) = 0;
  assert (select count(*) from public.security_events where kind = 'sign_in') = 1;
  -- the same again: nothing new
  r := public.live_access_token_hook(ev);
  assert (select count(*) from public.security_events where kind = 'sign_in') = 1;
  -- Bob's very first session (sign-up): baseline, no email
  insert into auth.users (id, email) values ('cccccccc-0000-0000-0000-00000000000c', 'cy@example.com');
  insert into auth.sessions (id, user_id, user_agent, ip) values ('33333333-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-00000000000c', 'UA', '198.51.100.4');
  r := public.live_access_token_hook(jsonb_build_object('user_id', 'cccccccc-0000-0000-0000-00000000000c', 'authentication_method', 'email/signup',
        'claims', jsonb_build_object('sub', 'cccccccc-0000-0000-0000-00000000000c', 'session_id', '33333333-0000-0000-0000-000000000003')));
  assert r->'claims'->>'ds_mfa' = 'false', r::text;
  assert (select count(*) from net.calls) = 0, 'first session is the baseline';
  -- Ada signs in on a new browser: emailed
  insert into auth.sessions (id, user_id, user_agent, ip) values ('44444444-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Mozilla/5.0 (iPhone) Safari', '192.0.2.200');
  r := public.live_access_token_hook(jsonb_build_object('user_id', 'aaaaaaaa-0000-0000-0000-00000000000a', 'authentication_method', 'password',
        'claims', jsonb_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000000a', 'session_id', '44444444-0000-0000-0000-000000000004', 'aal', 'aal1')));
  assert (select count(*) from net.calls) = 1, 'new sign-in emails';
  -- MFA step-up on that same session: no second email
  r := public.live_access_token_hook(jsonb_build_object('user_id', 'aaaaaaaa-0000-0000-0000-00000000000a', 'authentication_method', 'totp',
        'claims', jsonb_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000000a', 'session_id', '44444444-0000-0000-0000-000000000004', 'aal', 'aal2')));
  assert (select count(*) from net.calls) = 1;
  -- garbage never blocks a sign-in
  r := public.live_access_token_hook('{"user_id":"not-a-uuid","claims":{"a":1}}');
  assert r = '{"claims":{"a":1}}'::jsonb, r::text;
  r := public.live_access_token_hook(jsonb_build_object('user_id', 'aaaaaaaa-0000-0000-0000-00000000000a', 'claims', jsonb_build_object('session_id', 'nope')));
  assert r->'claims'->>'ds_mfa' = 'true', r::text;
end $$;

-- the signature checks out and the payload is as documented
do $$ declare c record; p jsonb; t text; sig text; begin
  select * into c from net.calls order by id desc limit 1;
  assert c.url = 'https://email.example.workers.dev/security';
  p := (c.body->>'p')::jsonb;
  assert p->>'email' = 'ada@example.com' and p->>'ip' = '192.0.2.x' and p->>'ua' = 'Mozilla/5.0 (iPhone) Safari' and p->>'kind' = 'sign_in' and p->>'method' = 'password' and p->>'name' = 'Ada', p::text;
  assert p->>'token' ~ '^[A-Za-z0-9_-]{32}$', p->>'token';
  t := substring(c.headers->>'x-ds-signature' from 't=([0-9]+)');
  sig := substring(c.headers->>'x-ds-signature' from 'v1=([0-9a-f]{64})');
  assert sig = encode(extensions.hmac(t || '.' || (c.body->>'p'), 'test-secret', 'sha256'), 'hex'), c.headers::text;
  assert not exists (select 1 from public.security_events where secure_hash = p->>'token'), 'raw token never stored';
  perform set_config('t.token', p->>'token', false);
end $$;

-- 6. "Not you?"
-- an intruder's watch enrolled after that sign-in goes too
insert into public.live_devices (user_id, thumb, platform, name, created_at) values ('aaaaaaaa-0000-0000-0000-00000000000a', repeat('Z', 43), 'watchos', 'Intruder', now());
update public.live_devices set created_at = now() - interval '1 day' where name = 'Watch again';
set role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', false);
do $$ declare r jsonb; begin
  r := public.live_secure_account('short');
  assert r->>'error' = 'invalid', r::text;
  r := public.live_secure_account(repeat('x', 32));
  assert r->>'error' = 'invalid', r::text;
  r := public.live_secure_account(current_setting('t.token'));
  assert r->>'ok' = 'true' and (r->>'sessions_ended')::int = 2 and r->>'email_hint' = 'a•••@example.com' and r->'email' is null, r::text;
  assert jsonb_array_length(r->'devices_revoked') = 1 and r->'devices_revoked'->0->>'thumb' = repeat('Z', 43), r::text;
  r := public.live_secure_account(current_setting('t.token'));
  assert r->>'error' = 'used', r::text;
end $$;
reset role;
do $$ begin
  assert (select count(*) from auth.sessions where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a') = 0;
  assert (select count(*) from auth.refresh_tokens) = 0;
  assert (select count(*) from public.live_devices where name = 'Watch again' and revoked_at is null) = 1, 'older devices stay';
  assert exists (select 1 from public.security_events where kind = 'secured');
end $$;
-- service role gets the address back (for the reset email)
do $$ declare r jsonb; tok text := 'svc' || repeat('q', 29); begin
  update public.security_events set secure_hash = encode(extensions.digest(tok, 'sha256'), 'hex'), secure_used_at = null, at = now() where id = (select min(id) from public.security_events where kind = 'sign_in' and user_id = 'bbbbbbbb-0000-0000-0000-00000000000b');
  if not found then
    insert into public.security_events (user_id, session_id, kind, secure_hash) values ('bbbbbbbb-0000-0000-0000-00000000000b', gen_random_uuid(), 'sign_in', encode(extensions.digest(tok, 'sha256'), 'hex'));
  end if;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', false);
  r := public.live_secure_account(tok);
  assert r->>'ok' = 'true' and r->>'email' = 'bob@example.com' and r->>'user_id' = 'bbbbbbbb-0000-0000-0000-00000000000b', r::text;
  -- expired token
  update public.security_events set secure_hash = encode(extensions.digest(tok || 'e', 'sha256'), 'hex'), secure_used_at = null, at = now() - interval '8 days' where id = (select max(id) from public.security_events where kind = 'sign_in');
  r := public.live_secure_account(tok || 'e');
  assert r->>'error' = 'expired', r::text;
end $$;

-- 7. grants
do $$ begin
  assert not has_function_privilege('anon', 'public.live_me()', 'execute');
  assert has_function_privilege('authenticated', 'public.live_me()', 'execute');
  assert has_function_privilege('anon', 'public.live_secure_account(text)', 'execute');
  assert has_function_privilege('anon', 'public.live_device_active(uuid, text)', 'execute');
  assert not has_function_privilege('anon', 'public.live_device_enroll(text, text, text)', 'execute');
  assert not has_function_privilege('authenticated', 'public.live_access_token_hook(jsonb)', 'execute');
  assert not has_function_privilege('anon', 'public.live_access_token_hook(jsonb)', 'execute');
  assert has_function_privilege('supabase_auth_admin', 'public.live_access_token_hook(jsonb)', 'execute');
  assert not has_function_privilege('authenticated', 'public.live__session_problem()', 'execute');
  assert not has_function_privilege('authenticated', 'public.live__send_signin_alert(uuid, bigint, text, text, text)', 'execute');
  assert not has_table_privilege('authenticated', 'public.security_events', 'select');
  assert not has_table_privilege('anon', 'public.live_devices', 'select');
end $$;
\echo BEHAVIOUR_OK
