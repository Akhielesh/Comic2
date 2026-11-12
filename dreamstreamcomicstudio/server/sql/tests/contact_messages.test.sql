-- contact_messages.sql (CONTACT-1): Settings › Contact messages are service-role only.
--   * the file applies twice (idempotent);
--   * RLS is on with no policy; anon and authenticated hold no privilege at all, even though Supabase's default
--     ACL (imitated below) grants them everything on new public tables;
--   * a signed-in user can neither insert their own row nor read anyone's; the service role can do both;
--   * the email and message length checks hold; deleting the auth user deletes their messages.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- Supabase's default ACL for tables created in public: every API role gets every privilege. The file must
-- take that back itself (the N4 rule in docs/infrastructure/SECURITY_FINDINGS.md).
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

\ir ../contact_messages.sql
\ir ../contact_messages.sql

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'c1@example.com'),
  ('00000000-0000-0000-0000-0000000000c2', 'c2@example.com');

do $$
declare
  n int;
  priv text;
begin
  assert (select relrowsecurity from pg_class where oid = 'public.contact_messages'::regclass), 'RLS is on';
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'contact_messages';
  assert n = 0, 'no policy exists on contact_messages';
  foreach priv in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
    assert not has_table_privilege('anon', 'public.contact_messages', priv), format('anon has no %s', priv);
    assert not has_table_privilege('authenticated', 'public.contact_messages', priv), format('authenticated has no %s', priv);
  end loop;
  foreach priv in array array['select', 'insert', 'update', 'delete'] loop
    assert has_table_privilege('service_role', 'public.contact_messages', priv), format('service_role keeps %s', priv);
  end loop;
  assert exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'contact_messages' and indexname = 'contact_messages_created_idx'),
    'the admin reader has a created_at index';
  assert exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'contact_messages' and indexname = 'contact_messages_user_created_idx'),
    'per-user history has a (user_id, created_at) index';
end $$;

-- A signed-in user cannot write their own row or read any row.
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', false);
do $$
begin
  begin
    insert into public.contact_messages (user_id, email, message) values ('00000000-0000-0000-0000-0000000000c1', 'c1@example.com', 'hi');
    raise exception 'a signed-in user could insert a contact message';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.contact_messages;
    raise exception 'a signed-in user could read contact messages';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set role anon;
do $$
begin
  begin
    perform 1 from public.contact_messages;
    raise exception 'anon could read contact messages';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- The service role writes and reads; the checks hold.
set role service_role;
insert into public.contact_messages (user_id, email, message) values ('00000000-0000-0000-0000-0000000000c1', 'c1@example.com', 'The reader skips page 2.');
insert into public.contact_messages (user_id, email, message) values ('00000000-0000-0000-0000-0000000000c2', 'c2@example.com', repeat('x', 5000));
do $$
declare
  r record;
begin
  select * into r from public.contact_messages where user_id = '00000000-0000-0000-0000-0000000000c1';
  assert r.id is not null and r.created_at is not null and r.handled_at is null, 'id, created_at defaults; open by default';
  begin
    insert into public.contact_messages (user_id, email, message) values ('00000000-0000-0000-0000-0000000000c1', 'c1@example.com', repeat('x', 5001));
    raise exception 'a 5,001-character message was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.contact_messages (user_id, email, message) values ('00000000-0000-0000-0000-0000000000c1', 'c1@example.com', '');
    raise exception 'an empty message was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.contact_messages (user_id, email, message) values ('00000000-0000-0000-0000-0000000000c1', 'ab', 'hi');
    raise exception 'a 2-character email was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.contact_messages (user_id, email, message) values ('00000000-0000-0000-0000-0000000000c1', repeat('a', 309) || '@example.com', 'hi');
    raise exception 'a 321-character email was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.contact_messages (user_id, email, message) values (null, 'c1@example.com', 'hi');
    raise exception 'a message without a user was accepted';
  exception when not_null_violation then null;
  end;
  update public.contact_messages set handled_at = now() where user_id = '00000000-0000-0000-0000-0000000000c1';
  assert (select count(*) from public.contact_messages where handled_at is not null) = 1, 'the service role marks a message handled';
end $$;
reset role;

-- Deleting the account deletes its messages.
delete from auth.users where id = '00000000-0000-0000-0000-0000000000c1';
do $$
begin
  assert (select count(*) from public.contact_messages) = 1, 'the deleted user''s message went with them';
end $$;

\echo CONTACT_MESSAGES_OK
