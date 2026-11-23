-- The normal auth roles, SQL stub and real publication schema run in an isolated local Postgres database.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create table public.projects (
  id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade,
  name text, state jsonb, is_public boolean default false, is_forced_private boolean default false,
  content_rating text, cover_image_url text, updated_at timestamptz default now()
);
create table public.comic_docs (project_id uuid primary key references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, doc jsonb not null, rev integer default 0);
create or replace function auth.role() returns text language sql stable as $$ select nullif(auth.jwt() ->> 'role','') $$;
create schema if not exists storage;
create table storage.objects (id uuid primary key default gen_random_uuid(),bucket_id text,name text,created_at timestamptz default now());
\ir ../comic_publications.sql
\ir ../comic_reader_library.sql
\ir ../comic_reader_library.sql

insert into auth.users(id) values ('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002'),('00000000-0000-4000-8000-000000000003');
create function pg_temp.member(n int) returns uuid language sql immutable as $$ select ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid $$;
create function pg_temp.slug(n int) returns text language sql immutable as $$ select 'Book' || lpad(n::text,13,'0') $$;
create function pg_temp.book(n int, author_id uuid) returns void language plpgsql as $$
declare proj uuid;
begin
  insert into public.projects(user_id,name,state,is_public,content_rating) values(author_id,'Fixture',jsonb_build_object('studioVersion',4,'shareSlug',pg_temp.slug(n)),true,'PG') returning id into proj;
  insert into public.comic_publications(project_id,user_id,slug,asset_key,visibility,snapshot,safety) values(proj,author_id,pg_temp.slug(n),'K' || lpad(n::text,21,'0'),'public',jsonb_build_object('pages',jsonb_build_array('one','two','three','four')),'{"rating":"PG"}');
end $$;
select pg_temp.book(i,pg_temp.member(2)) from generate_series(1,40) i;
select pg_temp.book(41,pg_temp.member(1));
update public.comic_publications set visibility='unlisted' where slug=pg_temp.slug(25);
update public.comic_publications set status='suspended' where slug=pg_temp.slug(26);
update public.projects set is_forced_private=true where state->>'shareSlug'=pg_temp.slug(27);
update public.projects set is_public=false where state->>'shareSlug'=pg_temp.slug(28);
update public.projects set content_rating=null where state->>'shareSlug'=pg_temp.slug(29);
update public.projects set state=state || '{"studioVersion":"4"}' where state->>'shareSlug'=pg_temp.slug(30);
update public.projects set state=state || '{"shareSlug":"Other000000000001"}' where state->>'shareSlug'=pg_temp.slug(31);
update public.comic_publications set safety='{"rating":"R"}' where slug=pg_temp.slug(32);
update public.comic_publications set snapshot='{"pages":{}}' where slug=pg_temp.slug(33);
update public.comic_publications set safety='{}' where slug=pg_temp.slug(34);

-- Post-apply privilege and schema checks include hostile Supabase table/function default grants above.
do $$ declare r text; t text; sig text='public.comic_reader_library(uuid,text,uuid,text,integer,integer,integer)'; begin
  assert has_function_privilege('authenticated',sig,'execute');
  assert not has_function_privilege('anon',sig,'execute');
  assert not has_function_privilege('service_role',sig,'execute');
  assert not (select prosecdef from pg_proc where oid=sig::regprocedure);
  assert (select prosecdef from pg_proc where oid='comic_reader_private.library(uuid,text,uuid,text,integer,integer,integer)'::regprocedure);
  assert (select proconfig @> array['search_path=""'] from pg_proc where oid='comic_reader_private.library(uuid,text,uuid,text,integer,integer,integer)'::regprocedure);
  foreach r in array array['authenticated','anon','service_role'] loop
    foreach t in array array['comic_reader_private.preferences','comic_reader_private.positions','comic_reader_private.listed'] loop
      assert not has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE');
    end loop;
    assert not has_function_privilege(r,'comic_reader_private.expire_positions()','EXECUTE');
  end loop;
  assert (select bool_and(relrowsecurity) from pg_class where oid in ('comic_reader_private.preferences'::regclass,'comic_reader_private.positions'::regclass));
  assert not exists(select 1 from information_schema.columns where table_schema='comic_reader_private' and table_name='positions' and column_name in ('slug','url','title','asset_key'));
end $$;

set role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
do $$ declare me uuid=pg_temp.member(1); e uuid; new_epoch uuid; result jsonb; rev int; n int; begin
  assert public.comic_reader_library(me) = '{"enabled":false,"epoch":null,"reads":[]}'::jsonb;
  assert public.comic_reader_library(me,'save',null,pg_temp.slug(1),2,4,0)='{"saved":false}'::jsonb;
  begin perform public.comic_reader_library(pg_temp.member(3),'enable'); assert false; exception when insufficient_privilege then null; end;
  begin perform public.comic_reader_library(null); assert false; exception when insufficient_privilege then null; end;
  begin perform public.comic_reader_library(me,'unknown'); assert false; exception when invalid_parameter_value then null; end;
  result=public.comic_reader_library(me,'enable'); e=(result->>'epoch')::uuid;
  assert result->>'enabled'='true' and e is not null;
  assert (public.comic_reader_library(me,'enable',e)->>'epoch')::uuid=e;
  result=public.comic_reader_library(me,'save',e,pg_temp.slug(1),2,4,0); rev=(result->>'revision')::int;
  assert result->>'saved'='true' and rev=1;
  assert public.comic_reader_library(me,'save',e,pg_temp.slug(1),3,4,0)='{"saved":false}'::jsonb;
  assert public.comic_reader_library(me,'save',e,pg_temp.slug(1),2,4,rev) = result;
  result=public.comic_reader_library(me,'save',e,pg_temp.slug(1),1,4,rev);
  assert result='{"saved":true,"revision":2}'::jsonb;
  result=public.comic_reader_library(me)->'reads'->0;
  assert result-'at'=jsonb_build_object('slug',pg_temp.slug(1),'page',1,'lastPage',4,'revision',2) and jsonb_typeof(result->'at')='number';
  foreach n in array array[25,26,27,28,29,30,31,32,33,41,999] loop
    assert public.comic_reader_library(me,'save',e,pg_temp.slug(n),1,4,0)='{"saved":false}'::jsonb, format('ineligible publication %s',n);
  end loop;
  assert public.comic_reader_library(me,'save',e,'not-a-slug',1,4,0)='{"saved":false}'::jsonb;
  assert public.comic_reader_library(me,'save',e,pg_temp.slug(3),1,5,0)='{"saved":false}'::jsonb;
  assert public.comic_reader_library(me,'save',e,pg_temp.slug(3),0,4,0)='{"saved":false}'::jsonb;
  assert public.comic_reader_library(me,'save',e,pg_temp.slug(3),5,4,0)='{"saved":false}'::jsonb;
  assert public.comic_reader_library(me,'save',e,pg_temp.slug(3),0,501,0)='{"saved":false}'::jsonb;
  assert public.comic_reader_library(me,'save',e,pg_temp.slug(3),null,4,null)='{"saved":false}'::jsonb;
  assert public.comic_reader_library(me,'save',e,pg_temp.slug(34),2,4,0)->>'saved'='true';
  result=public.comic_reader_library(me,'clear',gen_random_uuid()); assert jsonb_array_length(result->'reads')=2;
  new_epoch=(public.comic_reader_library(me,'clear',e)->>'epoch')::uuid;
  assert new_epoch<>e and public.comic_reader_library(me)->'reads'='[]'::jsonb;
  assert public.comic_reader_library(me,'save',e,pg_temp.slug(1),3,4,0)='{"saved":false}'::jsonb;
  assert public.comic_reader_library(me,'save',new_epoch,pg_temp.slug(1),3,4,0)->>'saved'='true';
  result=public.comic_reader_library(me,'disable',e); assert result->>'enabled'='true';
  result=public.comic_reader_library(me,'disable',new_epoch); assert result->>'enabled'='false';
  assert result->'reads'='[]'::jsonb;
  assert public.comic_reader_library(me,'save',new_epoch,pg_temp.slug(1),4,4,1)=jsonb_build_object('saved',false);
  assert public.comic_reader_library(me,'enable')->>'enabled'='false';
  assert public.comic_reader_library(me,'enable',new_epoch)->>'enabled'='false';
  e=(public.comic_reader_library(me,'enable',(result->>'epoch')::uuid)->>'epoch')::uuid;
  for n in 1..24 loop assert public.comic_reader_library(me,'save',e,pg_temp.slug(n),2,4,0)->>'saved'='true'; end loop;
  assert public.comic_reader_library(me,'save',e,pg_temp.slug(34),2,4,0)->>'saved'='true';
  result=public.comic_reader_library(me)->'reads'; assert jsonb_array_length(result)=24 and result->0->>'slug'=pg_temp.slug(34);
  assert not exists(select 1 from jsonb_array_elements(result) x where x->>'slug'=pg_temp.slug(1));
  assert public.comic_reader_library(me,'save',e,pg_temp.slug(1),1,4,1)='{"saved":false}'::jsonb;
  assert (public.comic_reader_library(me,'save',e,pg_temp.slug(1),3,4,0)->>'revision')::int >24;
end $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}',false);
do $$ declare me uuid=pg_temp.member(3); e uuid; begin
  assert public.comic_reader_library(me) = '{"enabled":false,"epoch":null,"reads":[]}'::jsonb;
  e=(public.comic_reader_library(me,'enable')->>'epoch')::uuid;
  assert public.comic_reader_library(me,'save',e,pg_temp.slug(3),4,4,0)->>'saved'='true';
  assert jsonb_array_length(public.comic_reader_library(me)->'reads')=1;
end $$;
reset role;
select set_config('request.jwt.claims','{}',false);
-- Relisting the same slug/project never restores former positions. Routine publishing can retain eligible reads.
update public.comic_publications set visibility='unlisted' where slug=pg_temp.slug(3);
update public.comic_publications set visibility='public' where slug=pg_temp.slug(3);
update public.comic_publications set slug='Rotated0000000001' where slug=pg_temp.slug(4);
update public.comic_publications set slug=pg_temp.slug(4) where slug='Rotated0000000001';
update public.comic_publications set status='unpublished' where slug=pg_temp.slug(5);
update public.comic_publications set status='live' where slug=pg_temp.slug(5);
update public.projects set is_forced_private=true where state->>'shareSlug'=pg_temp.slug(6);
update public.projects set is_forced_private=false where state->>'shareSlug'=pg_temp.slug(6);
update public.projects set content_rating=null where state->>'shareSlug'=pg_temp.slug(7);
update public.projects set content_rating='PG' where state->>'shareSlug'=pg_temp.slug(7);
update public.comic_publications set safety='{"rating":"R"}' where slug=pg_temp.slug(8);
update public.projects set state=state || '{"shareSlug":"Different00000001"}' where state->>'shareSlug'=pg_temp.slug(9);
update comic_reader_private.positions set updated_at=now()-interval '31 days' where publication_id=(select id from public.comic_publications where slug=pg_temp.slug(10));
do $$ begin
  assert not exists(select 1 from comic_reader_private.positions r join public.comic_publications c on r.publication_id=c.id where c.slug in (select pg_temp.slug(i) from generate_series(3,9)i));
  assert (select count(*) from comic_reader_private.positions where owner_id=pg_temp.member(3))=0;
  assert exists(select 1 from comic_reader_private.positions where updated_at < now()-interval '30 days');
end $$;
set role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
do $$ declare reads jsonb=public.comic_reader_library(pg_temp.member(1))->'reads'; begin
  assert not exists(select 1 from jsonb_array_elements(reads) x where x->>'slug'=pg_temp.slug(10));
  assert exists(select 1 from jsonb_array_elements(reads) x where x->>'slug'=pg_temp.slug(11));
end $$;
reset role;
select comic_reader_private.expire_positions();
do $$ begin
  assert not exists(select 1 from comic_reader_private.positions where updated_at < now()-interval '30 days');
  -- A reader who never opted in has no preferences; no per-book state exists without membership.
  assert not exists(select 1 from comic_reader_private.preferences where owner_id=pg_temp.member(2));
end $$;
-- A fresh browser tab competes with an uncommitted save. Both saw the same revision, exactly one advances it.
select exists(select 1 from pg_available_extensions where name='dblink') as has_dblink \gset
\if :has_dblink
create extension if not exists dblink with schema extensions;
select extensions.dblink_connect('reader_device', format('host=%L port=%s dbname=%L user=%L',current_setting('unix_socket_directories'),current_setting('port'),current_database(),current_user));
select extensions.dblink_exec('reader_device','set role authenticated');
select extensions.dblink_exec('reader_device', format('set request.jwt.claims = %L',jsonb_build_object('sub',pg_temp.member(1),'role','authenticated')::text));
select p.epoch as race_epoch, r.revision as race_rev from comic_reader_private.positions r
  join comic_reader_private.preferences p on r.owner_id=p.owner_id join public.comic_publications c on c.id=r.publication_id
 where p.owner_id=pg_temp.member(1) and c.slug=pg_temp.slug(11) \gset
begin;
select public.comic_reader_library(pg_temp.member(1),'save',:'race_epoch',pg_temp.slug(11),4,4,:race_rev);
select extensions.dblink_send_query('reader_device',format('select public.comic_reader_library(%L,''save'',%L,%L,1,4,%s)',pg_temp.member(1),:'race_epoch',pg_temp.slug(11),:race_rev));
select extensions.dblink_is_busy('reader_device');
commit;
do $$ declare response jsonb; begin
  select result into response from extensions.dblink_get_result('reader_device') as remote(result jsonb);
  assert response=jsonb_build_object('saved',false);
  assert (select page=4 from comic_reader_private.positions r join public.comic_publications c on c.id=r.publication_id where c.slug=pg_temp.slug(11) and owner_id=pg_temp.member(1));
end $$;
select extensions.dblink_disconnect('reader_device');
\endif
\ir ../comic_reader_library.sql
\echo COMIC_READER_LIBRARY_OK
