\set ON_ERROR_STOP 1
set client_min_messages=warning;
-- comic_docs as comic_docs.sql makes it (the columns this file reads), with one row written before the listing existed.
create table public.comic_docs(project_id uuid primary key,user_id uuid not null,doc jsonb not null,rev int not null default 0,
  updated_at timestamptz not null default now());
grant select on public.comic_docs to authenticated, service_role;
grant insert, update on public.comic_docs to service_role;
create function pg_temp.uid(n int) returns uuid language sql immutable as $$ select ('abc00000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into public.comic_docs(project_id,user_id,doc,updated_at) values
  (pg_temp.uid(1),pg_temp.uid(9),jsonb_build_object(
     'brief',jsonb_build_object('title','Night ferry','premise','A private premise the listing never copies.'),
     'gate',jsonb_build_object('id','g1','status','open','estimateUsd',0.4),
     'planStatus','draft',
     'directorDraft',jsonb_build_object('status','interrupted'),
     'conversation',jsonb_build_array(jsonb_build_object('role','user','text','private words'),
       jsonb_build_object('role','assistant','text','a plan','cards',jsonb_build_array(jsonb_build_object('type','plan','id','c1'))))),
   '2026-11-01T00:00:00Z');
\ir ../comic_docs_listing.sql
\ir ../comic_docs_listing.sql
do $$ declare row_listing jsonb; begin
  -- Backfilled: a doc saved before summaries keeps the four scalars "Needs you" is read from, and nothing else of it.
  select listing into row_listing from public.comic_docs where project_id=pg_temp.uid(1);
  assert row_listing = '{"activity":null,"gate":"open","plan":"draft","draft":"interrupted","lastCard":"plan"}'::jsonb, row_listing::text;
  assert position('private' in row_listing::text)=0 and position('0.4' in row_listing::text)=0;
  -- The backfill leaves the list's order alone.
  assert (select updated_at from public.comic_docs where project_id=pg_temp.uid(1))='2026-11-01T00:00:00Z'::timestamptz;

  -- A save writes the doc; the listing follows it (insert and update), whatever the writer passed for it.
  set local role service_role;
  insert into public.comic_docs(project_id,user_id,doc,listing) values (pg_temp.uid(2),pg_temp.uid(9),
    jsonb_build_object('workspaceActivity',jsonb_build_object('v',1,'attention','approval','working',false,'finished','[]'::jsonb),
      'gate',jsonb_build_object('status','open'),'conversation','[]'::jsonb),
    '{"activity":"forged"}');
  assert (select listing->'activity'->>'attention' from public.comic_docs where project_id=pg_temp.uid(2))='approval';
  assert (select listing->>'lastCard' from public.comic_docs where project_id=pg_temp.uid(2)) is null;
  update public.comic_docs set doc=doc||jsonb_build_object('workspaceActivity',jsonb_build_object('v',1,'attention',null,'working',true,'finished','[]'::jsonb),'gate',null)
    where project_id=pg_temp.uid(2);
  assert (select listing from public.comic_docs where project_id=pg_temp.uid(2))=
    '{"activity":{"v":1,"attention":null,"working":true,"finished":[]},"gate":null,"plan":null,"draft":null,"lastCard":null}'::jsonb;
  update public.comic_docs set listing='{"gate":"open"}' where project_id=pg_temp.uid(2);
  assert (select listing->'activity'->>'working' from public.comic_docs where project_id=pg_temp.uid(2))='true';
  reset role;

  -- The trigger's function is not reachable from the API roles and runs with an empty search_path.
  assert not has_function_privilege('anon','public.comic_docs_keep_listing()','execute');
  assert not has_function_privilege('authenticated','public.comic_docs_keep_listing()','execute');
  assert (select proconfig @> array['search_path=""'] from pg_proc where oid='public.comic_docs_keep_listing()'::regprocedure);
  assert not (select prosecdef from pg_proc where oid='public.comic_docs_keep_listing()'::regprocedure);
  -- One trigger, however often the file runs.
  assert (select count(*) from pg_trigger where tgrelid='public.comic_docs'::regclass and not tgisinternal)=1;
end $$;
\echo COMIC_DOCS_LISTING_OK
