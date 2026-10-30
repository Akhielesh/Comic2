-- comic_history.sql (versions plan §3.2, §10, §12; package H1), on a throwaway Postgres with stand-ins for the
-- production tables it touches (projects, comic_docs, artifacts, storage.objects). Synthetic data only.
--   * the file applies twice (idempotent) on top of comic_publications.sql, and a third time to restore the guard;
--   * anon and authenticated have no privilege on the tables or functions; the service role reads and calls the
--     RPCs but never writes the tables directly; RLS is on with no policies;
--   * a wrong-hash chunk is rejected; chunk content never changes; `paths` may shrink but never grow;
--     a saved moment is immutable except its label/name/note/pin columns;
--   * a put with a missing chunk rolls back fully (its chunks too); an equal root dedupes (and pins/names/marks);
--   * thinning keeps pinned rows, line heads, the newest row and keep_until, thins by hour / day / week, caps the
--     unpinned rows and reports the budget; a thinned parent leaves a null parent_id;
--   * GC never deletes a referenced chunk or one younger than 10 minutes;
--   * label / delete / forget_path / set_head / alternatives behave and refuse what they must;
--   * collect_active_image_paths() returns a path present only in a chunk; the guard fails without that branch and
--     on a narrower copy;
--   * the public RPCs (comic_public_payload, comic_share_card) and every client-executable function never
--     reference the history tables.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- Like Supabase: new tables in public are granted to the API roles unless revoked (the stub already does this for
-- functions), so a table this file forgets to lock down shows up below.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

-- ── Stand-ins for the production tables (only the columns these files read) ─────────────────────────────────────
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  name text,
  state jsonb,
  is_public boolean default false,
  is_forced_private boolean default false,
  cover_image_url text,
  updated_at timestamptz default now()
);
create table public.comic_docs (
  project_id uuid primary key references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  doc jsonb not null,
  rev integer not null default 0
);
create table public.artifacts (id uuid primary key default gen_random_uuid(), project_id uuid, data jsonb);
-- PostgREST's role claim (comic_publications.sql's projects guard reads it; migrations and tests carry none).
create or replace function auth.role() returns text language sql stable as $$ select nullif(auth.jwt() ->> 'role', '') $$;
create schema if not exists storage;
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, created_at timestamptz default now());

\ir ../comic_publications.sql
\ir ../comic_history.sql
\ir ../comic_history.sql

-- ── Fixtures and helpers (pg_temp: never part of the catalogue checks) ──────────────────────────────────────────
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'a@example.com'),
  ('00000000-0000-4000-8000-0000000000b2', 'b@example.com');
insert into public.projects (id, user_id, name, state) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'P1', '{}'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000b2', 'P2', '{}'),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000a1', 'P3 thinning', '{}'),
  ('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000a1', 'P4 cap', '{}'),
  ('10000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-0000000000a1', 'P5 budget', '{}'),
  ('10000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-0000000000a1', 'P6 gc', '{}'),
  ('10000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-0000000000a1', 'P7 lines', '{}');

create function pg_temp.h(p_content text) returns text language sql immutable as $$
  select left(encode(extensions.digest(p_content, 'sha256'), 'hex'), 32)
$$;
create function pg_temp.chunk(p_content text, p_paths text[] default '{}') returns jsonb language sql immutable as $$
  select jsonb_build_object('hash', pg_temp.h(p_content), 'kind', 'page', 'content', p_content, 'paths', to_jsonb(p_paths))
$$;
-- A v5 manifest whose every section is chunk p_h (enough for the RPC's manifest walk).
create function pg_temp.manifest(p_h text) returns jsonb language sql immutable as $$
  select jsonb_build_object('v', 1, 'meta', p_h, 'source', p_h, 'style', p_h, 'cover', p_h, 'places', p_h, 'glossary', p_h,
                            'options', '[]'::jsonb, 'cast', '[]'::jsonb, 'pages', jsonb_build_array(jsonb_build_array('pg_1', p_h, p_h)),
                            'editions', '{}'::jsonb, 'archive', '[]'::jsonb, 'trash', '[]'::jsonb)
$$;
create function pg_temp.ver(p_kind text, p_root text, p_h text, p_extra jsonb default '{}') returns jsonb language sql stable as $$
  select jsonb_build_object('kind', p_kind, 'actor', 'you', 'label', 'You edited page 1', 'rev', 1,
                            'contentAt', floor(extract(epoch from now()) * 1000)::bigint,
                            'manifest', pg_temp.manifest(p_h), 'rootHash', p_root, 'chunks', jsonb_build_array(p_h)) || p_extra
$$;
-- A row written straight into the table (thinning fixtures): one shared chunk, chosen times.
create function pg_temp.row(p_project uuid, p_label text, p_at timestamptz, p_h text, p_alt uuid default null,
                            p_pinned boolean default false, p_keep timestamptz default null, p_bytes integer default 0,
                            p_kind text default 'edits', p_created timestamptz default null, p_parent uuid default null)
returns uuid language sql as $$
  insert into public.comic_versions (project_id, user_id, alternative_id, parent_id, kind, actor, label, pinned, keep_until,
                                     rev, content_at, manifest, root_hash, chunks, bytes_new, created_at)
  values (p_project, '00000000-0000-4000-8000-0000000000a1', p_alt, p_parent, p_kind, 'you', p_label, p_pinned, p_keep,
          1, p_at, pg_temp.manifest(p_h), md5(p_label || p_at::text), array[p_h], p_bytes, coalesce(p_created, p_at))
  returning id
$$;
create function pg_temp.alive(p_label text) returns boolean language sql stable as $$
  select exists (select 1 from public.comic_versions where label = p_label)
$$;

-- ── 1. Idempotent, server-only, RLS on, no policies ─────────────────────────────────────────────────────────────
do $$
declare
  t text;
  r text;
  f regprocedure;
  n int;
begin
  foreach t in array array['public.comic_alternatives', 'public.comic_versions', 'public.comic_version_chunks'] loop
    assert (select relrowsecurity from pg_class where oid = t::regclass), t || ': RLS on';
    assert (select count(*) from pg_policies where schemaname = 'public' and format('public.%I', tablename) = t) = 0, t || ': no policies';
    foreach r in array array['anon', 'authenticated'] loop
      assert not has_table_privilege(r, t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'), r || ' has a privilege on ' || t;
      assert not has_any_column_privilege(r, t, 'SELECT, INSERT, UPDATE, REFERENCES'), r || ' has a column privilege on ' || t;
    end loop;
    assert has_table_privilege('service_role', t, 'SELECT'), 'the server reads ' || t;
    assert not has_table_privilege('service_role', t, 'INSERT, UPDATE, DELETE, TRUNCATE'), 'the server writes ' || t || ' only through the RPCs';
  end loop;
  -- Every function the file defines: no client execute; the RPCs (and only they) for the service role.
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and (p.proname like 'comic_history%' or p.proname like 'comic_version%' or p.proname = 'collect_active_image_paths') loop
    assert not has_function_privilege('anon', f, 'EXECUTE'), 'anon executes ' || f::text;
    assert not has_function_privilege('authenticated', f, 'EXECUTE'), 'authenticated executes ' || f::text;
  end loop;
  assert has_function_privilege('service_role', 'public.comic_history_put(uuid, uuid, jsonb, jsonb, jsonb)', 'EXECUTE'), 'service_role runs put';
  assert has_function_privilege('service_role', 'public.comic_history_set_head(uuid, uuid, uuid, uuid)', 'EXECUTE'), 'service_role runs set_head';
  assert not has_function_privilege('service_role', 'public.comic_history_thin(uuid, integer, bigint, integer)', 'EXECUTE'), 'thin is internal';
  assert not has_function_privilege('service_role', 'public.comic_history_gc(uuid, integer)', 'EXECUTE'), 'gc is internal';
  -- Every SECURITY DEFINER function here pins its search_path.
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname like 'comic_history%' and p.prosecdef
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  assert n = 0, 'a definer function without a pinned search_path';
  -- Applying twice made one of each.
  select count(*) into n from pg_trigger where tgname in ('comic_version_chunks_verify', 'comic_version_chunks_immutable', 'comic_versions_guard');
  assert n = 3, 'one of each trigger';
  select count(*) into n from pg_constraint where conname in ('comic_alternatives_from_version_fk', 'comic_alternatives_head_version_fk');
  assert n = 2, 'one of each line pointer';
  -- lz4 where the server has it (guarded: a server without it keeps the default).
  if exists (select 1 from pg_settings where name = 'default_toast_compression' and 'lz4' = any (enumvals)) then
    assert (select attcompression from pg_attribute where attrelid = 'public.comic_version_chunks'::regclass and attname = 'content') = 'l',
      'chunk content is lz4-compressed';
  end if;
end $$;

-- A client cannot reach the tables or the RPCs at all.
set role anon;
do $$
declare
  denied boolean := false;
begin
  begin
    perform 1 from public.comic_versions;
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'anon read comic_versions';
  denied := false;
  begin
    perform public.comic_history_forget_path('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'x/y');
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'anon ran an RPC';
end $$;
reset role;
set role authenticated;
do $$
declare
  denied boolean := false;
begin
  begin
    insert into public.comic_version_chunks (project_id, hash, user_id, codec, kind, content, bytes)
    values ('10000000-0000-4000-8000-000000000001', pg_temp.h('x'), '00000000-0000-4000-8000-0000000000a1', 'v5', 'page', 'x', 1);
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'a signed-in client wrote a chunk';
end $$;
reset role;
set role service_role;
do $$
declare
  denied boolean := false;
begin
  perform count(*) from public.comic_versions;   -- reads are fine
  begin
    update public.comic_versions set label = 'x';
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'the service role wrote comic_versions directly';
end $$;
reset role;

-- ── 2. Chunk integrity ──────────────────────────────────────────────────────────────────────────────────────────
do $$
declare
  p uuid := '10000000-0000-4000-8000-000000000001';
  u uuid := '00000000-0000-4000-8000-0000000000a1';
  rejected boolean := false;
  c record;
begin
  begin
    insert into public.comic_version_chunks (project_id, hash, user_id, codec, kind, content, bytes)
    values (p, pg_temp.h('the real content'), u, 'v5', 'page', 'other content', 0);
  exception when data_exception then rejected := true;
  end;
  assert rejected, 'a wrong-hash chunk was accepted';

  insert into public.comic_version_chunks (project_id, hash, user_id, codec, kind, content, bytes, paths)
  values (p, pg_temp.h('{"page":"één"}'), u, 'v5', 'page', '{"page":"één"}', 999,
          array[' u/a/p/b/img/1.webp ', 'u/a/p/b/img/1.webp', 'data:image/png;base64,AAAA/BBBB', 'https://x.example/a.png',
                'blob:https://x/y', 'no-slash', '', repeat('a/', 300)]);
  select * into c from public.comic_version_chunks where project_id = p and hash = pg_temp.h('{"page":"één"}');
  assert c.bytes = octet_length('{"page":"één"}'), 'bytes is the stored size, never the caller''s number';
  assert c.paths = array['u/a/p/b/img/1.webp'], 'paths keep only trimmed GC-root strings: ' || c.paths::text;

  rejected := false;
  begin
    update public.comic_version_chunks set content = 'changed' where project_id = p and hash = c.hash;
  exception when insufficient_privilege then rejected := true;
  end;
  assert rejected, 'chunk content changed';
  rejected := false;
  begin
    update public.comic_version_chunks set created_at = now() - interval '1 day' where project_id = p and hash = c.hash;
  exception when insufficient_privilege then rejected := true;
  end;
  assert rejected, 'a chunk''s created_at changed (it would dodge the GC grace)';
  rejected := false;
  begin
    update public.comic_version_chunks set paths = paths || array['u/a/p/b/img/2.webp'] where project_id = p and hash = c.hash;
  exception when insufficient_privilege then rejected := true;
  end;
  assert rejected, 'paths grew';
  update public.comic_version_chunks set paths = '{}' where project_id = p and hash = c.hash;
  assert (select paths from public.comic_version_chunks where project_id = p and hash = c.hash) = '{}', 'paths may shrink';
end $$;

-- ── 3. Put: ownership, missing chunk rollback, presence, dedupe ─────────────────────────────────────────────────
do $$
declare
  p uuid := '10000000-0000-4000-8000-000000000001';
  u uuid := '00000000-0000-4000-8000-0000000000a1';
  other uuid := '00000000-0000-4000-8000-0000000000b2';
  a text := pg_temp.h('A');
  b text := pg_temp.h('B');
  m text := pg_temp.h('M');
  res jsonb;
  res2 jsonb;
  failed boolean := false;
  msg text;
  v record;
  n int;
begin
  -- Not the owner: refused, nothing written.
  begin
    perform public.comic_history_put(p, other, pg_temp.ver('edits', md5('r0'), a), jsonb_build_array(pg_temp.chunk('A')));
  exception when insufficient_privilege then failed := true; msg := sqlerrm;
  end;
  assert failed and msg like 'COMIC_HISTORY_FORBIDDEN%', 'a foreign comic was written: ' || coalesce(msg, '');
  assert not exists (select 1 from public.comic_version_chunks where hash = a), 'a refused put left a chunk';

  -- A version that references a chunk nobody stored: the whole call rolls back, the chunk it did send too.
  failed := false;
  begin
    perform public.comic_history_put(p, u, pg_temp.ver('edits', md5('r1'), a) || jsonb_build_object('chunks', jsonb_build_array(a, b)),
                                     jsonb_build_array(pg_temp.chunk('A')));
  exception when foreign_key_violation then failed := true; msg := sqlerrm;
  end;
  assert failed and msg like 'COMIC_HISTORY_MISSING_CHUNKS%', 'a version with a missing chunk was written';
  assert not exists (select 1 from public.comic_version_chunks where project_id = p and hash = a), 'the rolled-back put left its chunk';
  assert not exists (select 1 from public.comic_versions where project_id = p), 'the rolled-back put left a row';

  -- The manifest is walked too: a hash the manifest names but the list forgot is still required…
  failed := false;
  begin
    perform public.comic_history_put(p, u, pg_temp.ver('edits', md5('r1'), m) || jsonb_build_object('chunks', jsonb_build_array(a)),
                                     jsonb_build_array(pg_temp.chunk('A')));
  exception when foreign_key_violation then failed := true;
  end;
  assert failed, 'a manifest hash missing from the store was accepted';
  -- …and lands in `chunks` (so the GC keeps it) when it is stored.
  res := public.comic_history_put(p, u, pg_temp.ver('start', md5('r1'), m) || jsonb_build_object('chunks', jsonb_build_array(a)),
                                  jsonb_build_array(pg_temp.chunk('A'), pg_temp.chunk('M')));
  assert (res ->> 'deduped')::boolean = false, 'a new root writes a row';
  assert (res ->> 'bytesNew')::int = 2, 'bytesNew counts the two new chunks';
  select * into v from public.comic_versions where id = (res ->> 'id')::uuid;
  assert v.chunks = (select array_agg(x order by x) from unnest(array[a, m]) x), 'chunks = list ∪ manifest: ' || v.chunks::text;
  assert v.pinned and v.user_id = u and v.codec = 'v5' and v.content_at <= now(), 'a start row is pinned';

  -- Equal root on the line's newest row: an automatic kind writes nothing.
  res2 := public.comic_history_put(p, u, pg_temp.ver('edits', md5('r1'), m), '[]'::jsonb);
  assert (res2 ->> 'deduped')::boolean and res2 ->> 'id' = res ->> 'id', 'an unchanged state dedupes';
  select count(*) into n from public.comic_versions where project_id = p;
  assert n = 1, 'dedupe wrote a row';

  -- A new state, then a named save of that same state: the head is pinned and named instead.
  res := public.comic_history_put(p, u, pg_temp.ver('edits', md5('r2'), a), '[]'::jsonb);
  assert not (select pinned from public.comic_versions where id = (res ->> 'id')::uuid), 'an edits row is not pinned';
  res2 := public.comic_history_put(p, u, pg_temp.ver('named', md5('r2'), a, '{"name":"  Draft 1  ","note":"before the chase"}'), '[]'::jsonb);
  assert res2 ->> 'id' = res ->> 'id' and (res2 ->> 'deduped')::boolean, 'a named save of an unchanged state names the head';
  select * into v from public.comic_versions where id = (res ->> 'id')::uuid;
  assert v.pinned and v.name = 'Draft 1' and v.note = 'before the chase' and v.kind = 'edits', 'the head is pinned and named';
  -- A publish of an unchanged state marks the head; a before-restore extends its keep.
  perform public.comic_history_put(p, u, pg_temp.ver('publish', md5('r2'), a, '{"publishedRev":7}'), '[]'::jsonb);
  assert (select published_rev from public.comic_versions where id = (res ->> 'id')::uuid) = 7, 'publish marks the head';
  perform public.comic_history_put(p, u, pg_temp.ver('before_restore', md5('r2'), a), '[]'::jsonb);
  assert (select keep_until from public.comic_versions where id = (res ->> 'id')::uuid) > now() + interval '29 days', 'before_restore keeps the head 30 days';

  -- Another user's line id is not this comic's.
  failed := false;
  begin
    perform public.comic_history_put(p, u, pg_temp.ver('edits', md5('r3'), a, jsonb_build_object('alternativeId', gen_random_uuid())), '[]'::jsonb);
  exception when no_data_found then failed := true;
  end;
  assert failed, 'a put on an unknown line was accepted';

  -- A parent from another comic is dropped, never linked.
  res := public.comic_history_put(p, u, pg_temp.ver('ai', md5('r4'), a, jsonb_build_object('parentId', gen_random_uuid())), '[]'::jsonb);
  assert (select parent_id from public.comic_versions where id = (res ->> 'id')::uuid) is null, 'a foreign parent was linked';

  -- A classic snapshot is imported once, by its id.
  res := public.comic_history_put(p, u, pg_temp.ver('legacy', md5('L1'), a, '{"codec":"legacy","legacyRef":{"snapshotId":"s1"}}'), '[]'::jsonb);
  res2 := public.comic_history_put(p, u, pg_temp.ver('legacy', md5('L1b'), a, '{"codec":"legacy","legacyRef":{"snapshotId":"s1"}}'), '[]'::jsonb);
  assert res2 ->> 'id' = res ->> 'id' and (res2 ->> 'deduped')::boolean, 'a classic snapshot imports once';
end $$;

-- ── 4. A saved moment is immutable except its label columns ─────────────────────────────────────────────────────
do $$
declare
  p uuid := '10000000-0000-4000-8000-000000000001';
  vid uuid := (select id from public.comic_versions where project_id = p and kind = 'start');
  rejected boolean := false;
begin
  begin
    update public.comic_versions set manifest = '{}'::jsonb where id = vid;
  exception when insufficient_privilege then rejected := true;
  end;
  assert rejected, 'a manifest changed';
  rejected := false;
  begin
    update public.comic_versions set chunks = '{}' where id = vid;
  exception when insufficient_privilege then rejected := true;
  end;
  assert rejected, 'a chunk list changed (it would let the GC strand chunks)';
  rejected := false;
  begin
    update public.comic_versions set parent_id = (select id from public.comic_versions where project_id = p and kind = 'ai') where id = vid;
  exception when insufficient_privilege then rejected := true;
  end;
  assert rejected, 'a parent was re-pointed';
  update public.comic_versions set label = 'Renamed', note = 'n', pinned = true where id = vid;
  assert (select label from public.comic_versions where id = vid) = 'Renamed', 'label columns change';
end $$;

-- ── 5. Thinning: schedule, protections, cap, budget ─────────────────────────────────────────────────────────────
do $$
declare
  p uuid := '10000000-0000-4000-8000-000000000003';
  u uuid := '00000000-0000-4000-8000-0000000000a1';
  c0 text := pg_temp.h('C0');
  hour3 timestamptz := date_trunc('hour', now() - interval '3 days');
  day20 timestamptz := date_trunc('day', now() - interval '20 days');
  week200 timestamptz := date_trunc('week', now() - interval '200 days');
  alt_head uuid;
  alt_line uuid;
  named uuid;
  parent uuid;
  child uuid;
  res jsonb;
begin
  insert into public.comic_version_chunks (project_id, hash, user_id, codec, kind, content, bytes)
  values (p, c0, u, 'v5', 'page', 'C0', 2);
  perform pg_temp.row(p, 'a1 1h ago', now() - interval '1 hour', c0);
  perform pg_temp.row(p, 'a2 47h ago, same hour as nothing', now() - interval '47 hours', c0);
  perform pg_temp.row(p, 'b1', hour3 + interval '10 minutes', c0);
  perform pg_temp.row(p, 'b2', hour3 + interval '20 minutes', c0);
  perform pg_temp.row(p, 'b3 newest of its hour', hour3 + interval '30 minutes', c0);
  perform pg_temp.row(p, 'b4 another hour', hour3 - interval '2 hours', c0);
  perform pg_temp.row(p, 'k1 keep_until', hour3 + interval '5 minutes', c0, null, false, now() + interval '1 day');
  -- A named row that was unpinned by hand: named versions are kept forever all the same.
  named := pg_temp.row(p, 'n1 named, unpinned', hour3 + interval '7 minutes', c0);
  update public.comic_versions set name = 'Kept by name' where id = named;
  alt_head := pg_temp.row(p, 'e1 a line head', hour3 + interval '1 minute', c0);
  perform pg_temp.row(p, 'c1', day20 + interval '10 hours', c0);
  perform pg_temp.row(p, 'c2 newest of its day', day20 + interval '15 hours', c0);
  perform pg_temp.row(p, 'd1', week200 + interval '1 day', c0);
  perform pg_temp.row(p, 'd2 newest of its week', week200 + interval '2 days', c0);
  perform pg_temp.row(p, 'p1 pinned', week200 + interval '1 day 1 hour', c0, null, true);
  -- A second line whose newest-written row is older in content than its other row: both stay (newest row of a line).
  insert into public.comic_alternatives (project_id, user_id, name, head_version_id) values (p, u, 'New ending', alt_head) returning id into alt_line;
  perform pg_temp.row(p, 'x1 line', day20 + interval '2 days 10 hours', c0, alt_line);
  perform pg_temp.row(p, 'x2 line newest', day20 + interval '2 days 9 hours', c0, alt_line, false, null, 0, 'edits', now() - interval '1 minute');
  -- An ai row whose before_ai parent will be thinned: the child keeps living with a null parent.
  parent := pg_temp.row(p, 'f1 parent', day20 + interval '5 days 1 hour', c0);
  child := pg_temp.row(p, 'f2 child, newest of its day', day20 + interval '5 days 2 hours', c0, null, false, null, 0, 'ai', null, parent);

  res := public.comic_history_put(p, u, pg_temp.ver('edits', md5('now'), c0), '[]'::jsonb);
  assert (res ->> 'thinned')::int = 5, 'b1, b2, c1, d1 and f1 are thinned: ' || res::text;
  assert (res ->> 'budgetThinned')::int = 0, 'no budget thinning';
  assert not pg_temp.alive('b1') and not pg_temp.alive('b2') and not pg_temp.alive('c1') and not pg_temp.alive('d1') and not pg_temp.alive('f1 parent'), 'the schedule thins';
  assert pg_temp.alive('a1 1h ago') and pg_temp.alive('a2 47h ago, same hour as nothing'), 'everything from the last 48 hours stays';
  assert pg_temp.alive('b3 newest of its hour') and pg_temp.alive('b4 another hour'), 'the newest per hour stays';
  assert pg_temp.alive('c2 newest of its day') and pg_temp.alive('d2 newest of its week'), 'the newest per day / week stays';
  assert pg_temp.alive('k1 keep_until') and pg_temp.alive('e1 a line head') and pg_temp.alive('p1 pinned'), 'keep_until, heads and pinned rows stay';
  assert pg_temp.alive('n1 named, unpinned'), 'a named row is never thinned';
  assert pg_temp.alive('x1 line') and pg_temp.alive('x2 line newest'), 'the newest row of a line stays';
  assert (select parent_id from public.comic_versions where id = child) is null, 'a thinned parent leaves a null parent_id';
end $$;

do $$
declare
  p uuid := '10000000-0000-4000-8000-000000000004';
  u uuid := '00000000-0000-4000-8000-0000000000a1';
  c0 text := pg_temp.h('C0');
  res jsonb;
  i int;
begin
  insert into public.comic_version_chunks (project_id, hash, user_id, codec, kind, content, bytes) values (p, c0, u, 'v5', 'page', 'C0', 2);
  for i in 1..6 loop
    perform pg_temp.row(p, 'cap' || i, now() - make_interval(hours => 10 - i), c0);
  end loop;
  perform pg_temp.row(p, 'cap pinned', now() - interval '20 hours', c0, null, true);
  res := public.comic_history_put(p, u, pg_temp.ver('edits', md5('cap now'), c0), '[]'::jsonb, '{"unpinnedRows":3}');
  assert (res ->> 'thinned')::int = 4, 'seven unpinned rows over a cap of three thin four: ' || res::text;
  assert not pg_temp.alive('cap1') and not pg_temp.alive('cap4') and pg_temp.alive('cap5') and pg_temp.alive('cap6'), 'the oldest go first';
  assert pg_temp.alive('cap pinned'), 'pinned rows are not counted or thinned';
end $$;

do $$
declare
  p uuid := '10000000-0000-4000-8000-000000000005';
  u uuid := '00000000-0000-4000-8000-0000000000a1';
  c0 text := pg_temp.h('C0');
  res jsonb;
  i int;
begin
  insert into public.comic_version_chunks (project_id, hash, user_id, codec, kind, content, bytes) values (p, c0, u, 'v5', 'page', 'C0', 2);
  for i in 1..5 loop
    perform pg_temp.row(p, 'budget' || i, now() - make_interval(hours => 10 - i), c0, null, false, null, 1000);
  end loop;
  perform pg_temp.row(p, 'budget pinned', now() - interval '20 hours', c0, null, true, null, 1000);
  -- 6000 kept + 2 new bytes over a 3500 budget: the three oldest deletable rows go (5002 → 4002 → 3002 ≤ 3500 … stop after 3).
  res := public.comic_history_put(p, u, pg_temp.ver('edits', md5('budget now'), pg_temp.h('NEW')), jsonb_build_array(pg_temp.chunk('NEW')),
                                  '{"bytesPerComic":3500}');
  assert (res ->> 'bytesNew')::int = 3, 'the new chunk is counted';
  assert (res ->> 'budgetThinned')::int = 3 and (res ->> 'thinned')::int = 0, 'the budget thins and reports: ' || res::text;
  assert not pg_temp.alive('budget1') and not pg_temp.alive('budget3') and pg_temp.alive('budget4'), 'oldest first';
  assert pg_temp.alive('budget pinned'), 'pinned rows survive the budget';
end $$;

-- ── 6. GC: only unreferenced chunks older than 10 minutes, this comic only ──────────────────────────────────────
do $$
declare
  p uuid := '10000000-0000-4000-8000-000000000006';
  u uuid := '00000000-0000-4000-8000-0000000000a1';
  res jsonb;
begin
  insert into public.comic_version_chunks (project_id, hash, user_id, codec, kind, content, bytes, created_at) values
    (p, pg_temp.h('old orphan'), u, 'v5', 'page', 'old orphan', 0, now() - interval '20 minutes'),
    (p, pg_temp.h('young orphan'), u, 'v5', 'page', 'young orphan', 0, now() - interval '5 minutes'),
    (p, pg_temp.h('old referenced'), u, 'v5', 'page', 'old referenced', 0, now() - interval '20 minutes'),
    -- the same content in another comic is that comic's own chunk: never touched by this comic's GC
    ('10000000-0000-4000-8000-000000000001', pg_temp.h('old orphan'), u, 'v5', 'page', 'old orphan', 0, now() - interval '20 minutes');
  perform pg_temp.row(p, 'gc ref', now() - interval '1 hour', pg_temp.h('old referenced'));
  res := public.comic_history_put(p, u, pg_temp.ver('edits', md5('gc now'), pg_temp.h('old referenced')), '[]'::jsonb);
  assert (res ->> 'gcChunks')::int = 1, 'exactly the old orphan is collected: ' || res::text;
  assert not exists (select 1 from public.comic_version_chunks where project_id = p and hash = pg_temp.h('old orphan')), 'old orphan gone';
  assert exists (select 1 from public.comic_version_chunks where project_id = p and hash = pg_temp.h('young orphan')), 'a chunk younger than 10 minutes stays';
  assert exists (select 1 from public.comic_version_chunks where project_id = p and hash = pg_temp.h('old referenced')), 'a referenced chunk stays';
  assert exists (select 1 from public.comic_version_chunks where project_id = '10000000-0000-4000-8000-000000000001' and hash = pg_temp.h('old orphan')),
    'another comic''s chunk is never collected';
end $$;

-- ── 7. Label, delete, forget a path, heads and lines ────────────────────────────────────────────────────────────
do $$
declare
  p uuid := '10000000-0000-4000-8000-000000000007';
  u uuid := '00000000-0000-4000-8000-0000000000a1';
  other uuid := '00000000-0000-4000-8000-0000000000b2';
  photo text := 'u/a/p/7/ref/face.webp';
  h1 text := pg_temp.h('L1');
  h2 text := pg_temp.h('L2');
  v1 uuid;
  v2 uuid;
  v3 uuid;
  alt jsonb;
  line uuid;
  row_json jsonb;
  failed boolean;
  msg text;
  i int;
begin
  v1 := (public.comic_history_put(p, u, pg_temp.ver('named', md5('l1'), h1, '{"name":"Draft 1"}'),
                                  jsonb_build_array(pg_temp.chunk('L1', array[photo, 'u/a/p/7/img/p1.webp']))) ->> 'id')::uuid;
  v2 := (public.comic_history_put(p, u, pg_temp.ver('edits', md5('l2'), h2), jsonb_build_array(pg_temp.chunk('L2', array[photo]))) ->> 'id')::uuid;

  -- Label: name pins an automatic row; '' clears; another user sees nothing.
  row_json := public.comic_history_label(p, u, v2, 'Before the twist', null, null);
  assert row_json ->> 'name' = 'Before the twist' and (row_json ->> 'pinned')::boolean, 'naming pins';
  assert not (row_json ? 'manifest') and not (row_json ? 'user_id'), 'the label answer is a list row';
  row_json := public.comic_history_label(p, u, v2, '', null, false);
  assert row_json ->> 'name' is null and not (row_json ->> 'pinned')::boolean, ''''' clears the name; pinned:false unpins';
  row_json := public.comic_history_label(p, u, v1, null, null, false);
  assert (row_json ->> 'pinned')::boolean, 'a saved version stays pinned';
  assert public.comic_history_label(p, u, gen_random_uuid(), 'x', null, null) is null, 'a missing version is null';
  failed := false;
  begin
    perform public.comic_history_label(p, other, v1, 'mine now', null, null);
  exception when insufficient_privilege then failed := true;
  end;
  assert failed, 'another user labelled a version';

  -- Delete: only saved versions, never the newest row, never a line's head.
  failed := false;
  begin
    perform public.comic_history_delete(p, u, v2);
  exception when object_not_in_prerequisite_state then failed := true; msg := sqlerrm;
  end;
  assert failed and msg like 'COMIC_HISTORY_REFUSED:%', 'an automatic row was deleted';
  v3 := (public.comic_history_put(p, u, pg_temp.ver('named', md5('l3'), h1, '{"name":"Draft 2"}'), '[]'::jsonb) ->> 'id')::uuid;
  failed := false;
  begin
    perform public.comic_history_delete(p, u, v3);
  exception when object_not_in_prerequisite_state then failed := true; msg := sqlerrm;
  end;
  assert failed and msg = 'COMIC_HISTORY_REFUSED:newest', 'the newest row was deleted';

  -- Lines: create (head pinned), one active at a time, at most 5 lines with "Original".
  alt := public.comic_history_alternative_create(p, u, '  New ending  ', v1, v2, 5);
  line := (alt ->> 'id')::uuid;
  assert alt ->> 'name' = 'New ending' and not (alt ->> 'is_active')::boolean and (alt ->> 'head_version_id')::uuid = v2, 'a line starts';
  assert (select pinned from public.comic_versions where id = v2), 'a line head is pinned';
  failed := false;
  begin
    perform public.comic_history_delete(p, u, v1);  -- named, not newest… but v1 is no head: allowed below
  exception when others then failed := true;
  end;
  assert not failed and not exists (select 1 from public.comic_versions where id = v1), 'a saved version is removed';
  assert (select from_version_id from public.comic_alternatives where id = line) is null, 'a removed start point reads as not recorded';
  for i in 2..4 loop
    perform public.comic_history_alternative_create(p, u, 'Try ' || i, null, v3, 5);
  end loop;
  failed := false;
  begin
    perform public.comic_history_alternative_create(p, u, 'One too many', null, v3, 5);
  exception when program_limit_exceeded then failed := true; msg := sqlerrm;
  end;
  assert failed and msg = 'COMIC_HISTORY_LIMIT:alternatives', 'a 6th line was created';
  perform public.comic_history_alternative_update(p, u, line, null, true);
  perform public.comic_history_alternative_update(p, u, (select id from public.comic_alternatives where project_id = p and name = 'Try 2'), 'Try two', true);
  assert (select count(*) from public.comic_alternatives where project_id = p and is_active) = 1, 'one active line';
  assert (select name from public.comic_alternatives where project_id = p and is_active) = 'Try two', 'renamed and active';
  -- A put on a line, then set_head moves its head; the old head unpins.
  v1 := (public.comic_history_put(p, u, pg_temp.ver('edits', md5('l4'), h2, jsonb_build_object('alternativeId', line)), '[]'::jsonb) ->> 'id')::uuid;
  assert public.comic_history_set_head(p, u, line, v1), 'set_head';
  assert (select head_version_id from public.comic_alternatives where id = line) = v1, 'the head moved';
  assert (select pinned from public.comic_versions where id = v1) and not (select pinned from public.comic_versions where id = v2), 'new head pinned, old one released';
  assert not public.comic_history_set_head(p, u, gen_random_uuid(), v1), 'an unknown line is false';
  assert public.comic_history_set_head(p, u, null, v3), 'the Original line''s head is pinned';
  failed := false;
  begin
    perform public.comic_history_delete(p, u, v1);
  exception when object_not_in_prerequisite_state then failed := true; msg := sqlerrm;
  end;
  assert failed, 'a line head was deleted';
  -- Remove: never the active line; its rows unpin and join Original.
  failed := false;
  begin
    perform public.comic_history_alternative_remove(p, u, (select id from public.comic_alternatives where project_id = p and is_active));
  exception when object_not_in_prerequisite_state then failed := true; msg := sqlerrm;
  end;
  assert failed and msg = 'COMIC_HISTORY_REFUSED:active', 'the active line was removed';
  assert public.comic_history_alternative_remove(p, u, line), 'a line is removed';
  assert (select alternative_id from public.comic_versions where id = v1) is null and not (select pinned from public.comic_versions where id = v1),
    'its rows unpin and join Original';
  assert not public.comic_history_alternative_remove(p, u, line), 'removing twice is false';

  -- Forget a reference photo: every chunk of this comic drops it; nothing else changes.
  assert public.comic_history_forget_path(p, u, ' ' || photo || ' ') = 2, 'both chunks forget the photo';
  assert not exists (select 1 from public.comic_version_chunks where project_id = p and photo = any (paths)), 'the photo is gone from history';
  assert exists (select 1 from public.comic_version_chunks where project_id = p and 'u/a/p/7/img/p1.webp' = any (paths)), 'other paths stay';
  assert public.comic_history_forget_path(p, u, photo) = 0, 'forgetting twice changes nothing';
end $$;

-- ── 8. GC roots ─────────────────────────────────────────────────────────────────────────────────────────────────
do $$
declare
  p uuid := '10000000-0000-4000-8000-000000000001';
  u uuid := '00000000-0000-4000-8000-0000000000a1';
begin
  insert into public.comic_docs (project_id, user_id, doc) values (p, u, '{"pages":[{"render":{"asset":{"path":"u/a/p/1/img/live.webp"}}}]}');
  insert into public.artifacts (project_id, data) values (p, '{"x":{"imageId":"u/a/p/1/img/artifact.webp"}}');
  update public.projects set state = '{"thumbnailImageId":"u/a/p/1/img/thumb.webp","imageTags":{"u/a/p/1/img/tag.webp":["x"]}}' where id = p;
  insert into public.comic_version_chunks (project_id, hash, user_id, codec, kind, content, bytes, paths)
  values (p, pg_temp.h('history only'), u, 'v5', 'art', 'history only', 0, array['u/a/p/1/img/history-only.webp']);
  assert exists (select 1 from public.collect_active_image_paths() where path = 'u/a/p/1/img/history-only.webp'), 'a path only history keeps is live';
  assert (select count(*) from public.collect_active_image_paths()
           where path in ('u/a/p/1/img/live.webp', 'u/a/p/1/img/artifact.webp', 'u/a/p/1/img/thumb.webp', 'u/a/p/1/img/tag.webp')) = 4,
    'every live $.** branch is kept';
  assert public.comic_history_assert_gc_roots(), 'the guard passes';
end $$;

-- The LIVE definition (comic_security_guard_2026_10.sql §3a), i.e. without the history branch: the guard must fail.
create or replace function public.collect_active_image_paths()
returns table(path text)
language sql
stable
set search_path = public
as $$
  with project_paths as (
    select nullif(btrim(v #>> '{}'), '') as path
      from public.projects p,
           lateral jsonb_path_query(coalesce(p.state, '{}'::jsonb), 'strict $.**') v
     where jsonb_typeof(v) = 'string'
       and position('/' in (v #>> '{}')) > 0
    union all
    select nullif(btrim(jk), '')
      from public.projects p,
           lateral jsonb_object_keys(case when jsonb_typeof(p.state -> 'imageTags') = 'object' then p.state -> 'imageTags' else '{}'::jsonb end) jk
  ),
  artifact_paths as (
    select nullif(btrim(v #>> '{}'), '') as path
      from public.artifacts a,
           lateral jsonb_path_query(coalesce(a.data, '{}'::jsonb), 'strict $.**') v
     where jsonb_typeof(v) = 'string'
       and position('/' in (v #>> '{}')) > 0
  ),
  comic_doc_paths as (
    select nullif(btrim(v #>> '{}'), '') as path
      from public.comic_docs d,
           lateral jsonb_path_query(d.doc, 'strict $.**') v
     where jsonb_typeof(v) = 'string'
       and position('/' in (v #>> '{}')) > 0
  )
  select distinct path
    from (
      select path from project_paths
      union all
      select path from artifact_paths
      union all
      select path from comic_doc_paths
    ) combined
   where path is not null and path <> '';
$$;
do $$
declare
  failed boolean := false;
  msg text;
begin
  assert not exists (select 1 from public.collect_active_image_paths() where path = 'u/a/p/1/img/history-only.webp'), 'without the branch the path is unprotected';
  begin
    perform public.comic_history_assert_gc_roots();
  exception when others then failed := true; msg := sqlerrm;
  end;
  assert failed and msg like '%lacks the comic_version_chunks branch%', 'the guard passed without the branch: ' || coalesce(msg, '');
end $$;

-- A narrower copy (the old fixed-key comic_docs.sql shape) that only adds the history branch: still refused.
create or replace function public.collect_active_image_paths()
returns table(path text)
language sql
stable
set search_path = public
as $$
  select distinct p from (
    select d.doc #>> '{cover,render,asset,path}' as p from public.comic_docs d
    union all
    select x from public.comic_version_chunks c, unnest(c.paths) x
  ) s where p is not null;
$$;
do $$
declare
  failed boolean := false;
  msg text;
begin
  begin
    perform public.comic_history_assert_gc_roots();
  exception when others then failed := true; msg := sqlerrm;
  end;
  assert failed and msg like '%narrower copy%', 'the guard passed a narrower copy: ' || coalesce(msg, '');
end $$;

-- Re-applying the file restores the full definition (and is still idempotent with data in every table).
\ir ../comic_history.sql
do $$
begin
  assert public.comic_history_assert_gc_roots(), 'restored';
  assert exists (select 1 from public.collect_active_image_paths() where path = 'u/a/p/1/img/history-only.webp'), 'restored branch';
  assert not has_function_privilege('anon', 'public.collect_active_image_paths()', 'EXECUTE'), 'still not a client RPC';
end $$;

-- ── 9. Share links never reach history ──────────────────────────────────────────────────────────────────────────
do $$
declare
  f record;
begin
  assert to_regprocedure('public.comic_public_payload(text)') is not null and to_regprocedure('public.comic_share_card(text)') is not null,
    'the public RPCs are loaded';
  for f in
    select p.oid::regprocedure as sig, p.prosrc
      from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'public'
       and (p.proname in ('comic_public_payload', 'comic_share_card', 'comic_share_card_by_project')
            or has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  loop
    assert f.prosrc !~* 'comic_version|comic_alternatives|comic_history', f.sig::text || ' reaches the history tables';
  end loop;
end $$;

-- ── 10. Deleting a comic removes its history ────────────────────────────────────────────────────────────────────
do $$
declare
  p uuid := '10000000-0000-4000-8000-000000000007';
begin
  delete from public.projects where id = p;
  assert not exists (select 1 from public.comic_versions where project_id = p), 'versions cascade';
  assert not exists (select 1 from public.comic_version_chunks where project_id = p), 'chunks cascade';
  assert not exists (select 1 from public.comic_alternatives where project_id = p), 'lines cascade';
end $$;

\echo COMIC_HISTORY_OK
