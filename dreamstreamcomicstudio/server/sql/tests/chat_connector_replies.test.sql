-- chat_connector_replies.sql (connected-account privacy, finding C1a):
--   * the file applies twice (idempotent);
--   * clients (anon, authenticated) can neither read nor write the table nor run the function;
--   * record_chat_connector_reply inserts once per (user, hash), refreshes a known hash, rejects a
--     malformed hash, keeps only the newest p_keep rows per user and drops rows older than p_ttl_days —
--     for that user only.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

\ir ../chat_connector_replies.sql
\ir ../chat_connector_replies.sql

-- ------------------------------------------------------------------ fixtures (synthetic)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@example.com'),
  ('00000000-0000-0000-0000-0000000000b2', 'b@example.com');

-- ------------------------------------------------------------------ privileges
do $$
begin
  assert (select relrowsecurity from pg_class where oid = 'public.chat_connector_replies'::regclass), 'RLS is on';
  assert not exists (select 1 from pg_policies where tablename = 'chat_connector_replies'), 'no policy: service role only';
  assert not has_table_privilege('authenticated', 'public.chat_connector_replies', 'select'), 'signed-in users cannot read';
  assert not has_table_privilege('authenticated', 'public.chat_connector_replies', 'insert'), 'signed-in users cannot write';
  assert not has_table_privilege('anon', 'public.chat_connector_replies', 'select'), 'anon cannot read';
  assert not has_function_privilege('authenticated', 'public.record_chat_connector_reply(uuid,text,int,int)', 'execute'),
    'signed-in users cannot call the writer';
  assert not has_function_privilege('anon', 'public.record_chat_connector_reply(uuid,text,int,int)', 'execute'), 'anon cannot call the writer';
  assert has_function_privilege('service_role', 'public.record_chat_connector_reply(uuid,text,int,int)', 'execute'), 'the backend can';
end $$;

-- ------------------------------------------------------------------ behaviour
do $$
declare
  n int;
  t timestamptz;
  h text := repeat('a', 64);
begin
  perform public.record_chat_connector_reply('00000000-0000-0000-0000-0000000000a1', h);
  perform public.record_chat_connector_reply('00000000-0000-0000-0000-0000000000a1', h);
  select count(*) into n from public.chat_connector_replies where user_id = '00000000-0000-0000-0000-0000000000a1';
  assert n = 1, format('one row per (user, hash), got %s', n);

  update public.chat_connector_replies set created_at = now() - interval '3 days' where reply_hash = h;
  perform public.record_chat_connector_reply('00000000-0000-0000-0000-0000000000a1', h);
  select created_at into t from public.chat_connector_replies where reply_hash = h;
  assert t > now() - interval '1 minute', 'recording a known hash refreshes it';

  begin
    perform public.record_chat_connector_reply('00000000-0000-0000-0000-0000000000a1', 'not-a-hash');
    raise exception 'malformed hash accepted';
  exception when raise_exception then
    if sqlerrm = 'malformed hash accepted' then raise; end if;
  end;
  begin
    insert into public.chat_connector_replies (user_id, reply_hash) values ('00000000-0000-0000-0000-0000000000a1', 'XYZ');
    raise exception 'hash check missing';
  exception when check_violation then null;
  end;

  -- Bounded per user: 5 more hashes with p_keep = 3 leave the newest 3; user b is untouched.
  perform public.record_chat_connector_reply('00000000-0000-0000-0000-0000000000b2', repeat('f', 64));
  for i in 1..5 loop
    insert into public.chat_connector_replies (user_id, reply_hash, created_at)
    values ('00000000-0000-0000-0000-0000000000a1', lpad(to_hex(i), 64, '0'), now() - make_interval(mins => 10 - i))
    on conflict do nothing;
  end loop;
  perform public.record_chat_connector_reply('00000000-0000-0000-0000-0000000000a1', repeat('c', 64), 3);
  select count(*) into n from public.chat_connector_replies where user_id = '00000000-0000-0000-0000-0000000000a1';
  assert n = 3, format('the newest 3 rows remain, got %s', n);
  assert exists (select 1 from public.chat_connector_replies where reply_hash = repeat('c', 64)), 'the new hash is kept';
  assert exists (select 1 from public.chat_connector_replies where reply_hash = h), 'a refreshed hash counts as new';
  select count(*) into n from public.chat_connector_replies where user_id = '00000000-0000-0000-0000-0000000000b2';
  assert n = 1, 'another user''s rows are never pruned';

  -- Old rows: anything older than p_ttl_days goes on the next write.
  update public.chat_connector_replies set created_at = now() - interval '400 days' where reply_hash = repeat('c', 64);
  perform public.record_chat_connector_reply('00000000-0000-0000-0000-0000000000a1', repeat('d', 64));
  assert not exists (select 1 from public.chat_connector_replies where reply_hash = repeat('c', 64)), 'a row older than the TTL is dropped';

  -- Deleting the user removes their marks.
  delete from auth.users where id = '00000000-0000-0000-0000-0000000000b2';
  select count(*) into n from public.chat_connector_replies where user_id = '00000000-0000-0000-0000-0000000000b2';
  assert n = 0, 'marks follow the user (on delete cascade)';
end $$;

\echo CHAT_CONNECTOR_REPLIES_OK
