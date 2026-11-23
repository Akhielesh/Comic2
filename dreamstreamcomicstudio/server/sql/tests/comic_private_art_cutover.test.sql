\set ON_ERROR_STOP 1
set client_min_messages=warning;
create table public.projects(id uuid primary key,user_id uuid not null);
create table public.comic_docs(project_id uuid primary key references public.projects(id),user_id uuid not null,doc jsonb not null,rev int not null);
create table public.image_assets(path text primary key,user_id uuid not null,project_id uuid,bucket text not null);
create schema storage;
create table storage.buckets(id text primary key,public boolean not null);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text not null,name text not null,version text,
  updated_at timestamptz not null default now(), metadata jsonb not null,unique(bucket_id,name));
grant usage on schema storage to service_role;
grant select,update on public.projects,public.comic_docs,public.image_assets,storage.objects to service_role;
grant select on storage.buckets to service_role;
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
\ir ../comic_private_art_cutover.sql
\ir ../comic_private_art_cutover.sql
create function pg_temp.uid(n int) returns uuid language sql immutable as $$ select ('abc00000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
create function pg_temp.key(n text) returns text language sql immutable as $$ select 'u/'||pg_temp.uid(1)||'/p/'||pg_temp.uid(2)||'/img/'||n $$;
insert into public.projects values (pg_temp.uid(2),pg_temp.uid(1)),(pg_temp.uid(3),pg_temp.uid(1)),(pg_temp.uid(4),pg_temp.uid(5));
insert into public.comic_docs values(pg_temp.uid(2),pg_temp.uid(1),jsonb_build_object('oldHistory',jsonb_build_array(jsonb_build_object('path',pg_temp.key('art.webp')))),7),
  (pg_temp.uid(4),pg_temp.uid(1),'{}',1);
insert into storage.buckets values ('comic-assets',true),('comic-private',false);
insert into storage.objects(bucket_id,name,version,metadata)
 select b,n,gen_random_uuid()::text,jsonb_build_object('size',100,'eTag','"test"') from
 (values ('comic-assets'),('comic-private')) bucket(b) cross join
 (values (pg_temp.key('art.webp')),(pg_temp.key('art_w480.webp')),(pg_temp.key('art_w1080.webp'))) names(n);
insert into storage.objects(bucket_id,name,metadata) values
 ('comic-private',pg_temp.key('draft-v1-00000000-0000-4000-8000-000000000010_w480.webp'),'{}'),
 ('comic-private',replace(pg_temp.key('ref.webp'),'/img/','/ref/'),'{}'),('comic-private','q/quarantined/pic.webp','{}'),
 ('comic-assets','library/v1/item/pic.webp','{}'),('comic-assets','pub/edition/page.webp','{}'),('comic-assets','u/member/tmp/pic.webp','{}');
insert into public.image_assets values
 (pg_temp.key('art.webp'),pg_temp.uid(1),pg_temp.uid(2),'comic-assets'),
 (pg_temp.key('art_w480.webp'),pg_temp.uid(1),null,'comic-assets'),
 (pg_temp.key('art_w1080.webp'),pg_temp.uid(5),pg_temp.uid(4),'comic-assets'),
 ('classic/otherwise.webp',pg_temp.uid(1),pg_temp.uid(3),'comic-assets');
create function pg_temp.manifest() returns jsonb language sql as $$
 select jsonb_agg(jsonb_build_object('name',s.name,'bytes',(s.metadata->>'size')::int,
   'sourceId',s.id,'sourceVersion',s.version,'sourceUpdatedAt',s.updated_at,'sourceEtag',s.metadata->>'eTag','sourceSha256',repeat('a',64),
   'privateId',p.id,'privateVersion',p.version,'privateUpdatedAt',p.updated_at,'privateEtag',p.metadata->>'eTag','privateSha256',repeat('a',64)) order by s.name)
 from storage.objects s join storage.objects p using(name)
 where s.bucket_id='comic-assets' and p.bucket_id='comic-private'
$$;
create function pg_temp.go(m jsonb, verified_at timestamptz default now(), owner_id uuid default pg_temp.uid(1),
  project_id uuid default pg_temp.uid(2), revision int default 7) returns int language sql as $$
  select public.comic_activate_private_art(project_id,owner_id,revision,verified_at,m)
$$;
do $$ declare role_name text; sig text; begin
  foreach sig in array array['public.comic_activate_private_art(uuid,uuid,integer,timestamptz,jsonb)','public.comic_private_art_scopes(uuid[])'] loop
    assert has_function_privilege('service_role',sig,'execute');
    assert not (select prosecdef from pg_proc where oid=sig::regprocedure);
    assert (select proconfig @> array['search_path=""'] from pg_proc where oid=sig::regprocedure);
    foreach role_name in array array['anon','authenticated'] loop
      assert not has_function_privilege(role_name,sig,'execute');
      assert not has_schema_privilege(role_name,'comic_art_maintenance','usage');
      assert not has_table_privilege(role_name,'comic_art_maintenance.active_projects','select,insert,update,delete');
      assert not has_function_privilege(role_name,'comic_art_maintenance.keep_registry_bucket()','execute');
    end loop;
  end loop;
  assert (select relrowsecurity from pg_class where oid='comic_art_maintenance.active_projects'::regclass);
  assert (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='comic_art_maintenance.keep_registry_bucket()'::regprocedure);
end $$;
set role service_role;
do $$ declare m jsonb=pg_temp.manifest(); begin
  assert jsonb_array_length(m)=3;
  assert not exists(select 1 from public.comic_private_art_scopes(array[pg_temp.uid(2),pg_temp.uid(3),pg_temp.uid(4)]));
  begin perform public.comic_private_art_scopes(array_fill(pg_temp.uid(2),array[129])); assert false; exception when invalid_parameter_value then null; end;
  begin perform pg_temp.go('[]'); assert false; exception when invalid_parameter_value then null; end;
  begin perform pg_temp.go(m,now()-interval '31 minutes'); assert false; exception when object_not_in_prerequisite_state then null; end;
  begin perform pg_temp.go(m,now()+interval '1 minute'); assert false; exception when object_not_in_prerequisite_state then null; end;
  begin perform pg_temp.go(m,now(),pg_temp.uid(5)); assert false; exception when invalid_parameter_value then null; end;
  begin perform pg_temp.go(m,now(),pg_temp.uid(1),pg_temp.uid(2),6); assert false; exception when object_not_in_prerequisite_state then null; end;
  begin perform pg_temp.go(m - 1); assert false; exception when object_not_in_prerequisite_state then null; end;
  begin perform pg_temp.go(m||jsonb_build_array(m->0)); assert false; exception when invalid_parameter_value then null; end;
  begin perform pg_temp.go(jsonb_set(m,'{0,privateSha256}',to_jsonb(repeat('b',64)))); assert false; exception when invalid_parameter_value then null; end;
  begin perform pg_temp.go(jsonb_set(m,'{0,sourceSha256}','null')); assert false; exception when invalid_parameter_value then null; end;
  begin perform pg_temp.go(jsonb_set(m,'{0,sourceVersion}','"old"')); assert false; exception when object_not_in_prerequisite_state then null; end;
  begin perform pg_temp.go(jsonb_set(m,'{0,sourceId}',to_jsonb(pg_temp.uid(700)))); assert false; exception when object_not_in_prerequisite_state then null; end;
  begin perform pg_temp.go(jsonb_set(m,'{0,privateUpdatedAt}',to_jsonb(now()-interval '1 second'))); assert false; exception when object_not_in_prerequisite_state then null; end;
  begin perform pg_temp.go(jsonb_set(m,'{0,privateEtag}','null')); assert false; exception when object_not_in_prerequisite_state then null; end;
  begin perform pg_temp.go(jsonb_set(m,'{0,bytes}','99')); assert false; exception when object_not_in_prerequisite_state then null; end;
  begin perform pg_temp.go(jsonb_set(m,'{0,name}','"pub/pic"')); assert false; exception when invalid_parameter_value then null; end;
  assert not exists(select 1 from comic_art_maintenance.active_projects);
end $$;
reset role;
do $$ declare m jsonb=pg_temp.manifest(); begin
  delete from storage.objects where name=pg_temp.key('art_w480.webp') and bucket_id='comic-private';
  begin perform pg_temp.go(m); assert false; exception when object_not_in_prerequisite_state then null; end;
  insert into storage.objects(bucket_id,name,version,metadata) values('comic-private',pg_temp.key('art_w480.webp'),'new','{"size":100}');
  update public.comic_docs set doc='{"pages":[{"render":{"status":"rendering"}}]}' where project_id=pg_temp.uid(2);
  begin perform pg_temp.go(pg_temp.manifest()); assert false; exception when object_not_in_prerequisite_state then null; end;
  update public.comic_docs set doc=jsonb_build_object('history',jsonb_build_array(jsonb_build_object('path',pg_temp.key('gone.webp')))) where project_id=pg_temp.uid(2);
  begin perform pg_temp.go(pg_temp.manifest()); assert false; exception when object_not_in_prerequisite_state then null; end;
  update public.comic_docs set doc='{}' where project_id=pg_temp.uid(2);
  insert into storage.objects(bucket_id,name,metadata) values('comic-assets',pg_temp.key('unexpected/nested.webp'),'{}');
  begin perform pg_temp.go(pg_temp.manifest()); assert false; exception when object_not_in_prerequisite_state then null; end;
  delete from storage.objects where name=pg_temp.key('unexpected/nested.webp');
  insert into storage.objects(bucket_id,name,metadata) values('comic-private',pg_temp.key('untracked.webp'),'{"size":100}');
  begin perform pg_temp.go(pg_temp.manifest()); assert false; exception when object_not_in_prerequisite_state then null; end;
  delete from storage.objects where name=pg_temp.key('untracked.webp');
  update public.comic_docs set user_id=pg_temp.uid(5) where project_id=pg_temp.uid(2);
  begin perform pg_temp.go(pg_temp.manifest()); assert false; exception when invalid_parameter_value then null; end;
  update public.comic_docs set user_id=pg_temp.uid(1) where project_id=pg_temp.uid(2);
end $$;
-- Everything above also works on installations without the optional history feature.
create table public.comic_version_chunks(project_id uuid, user_id uuid, content text, paths text[]);
grant select on public.comic_version_chunks to service_role;
insert into public.comic_version_chunks values
  (pg_temp.uid(2),pg_temp.uid(1),'serialized historical content',array[pg_temp.key('absent-from-storage.webp')]),
  (pg_temp.uid(4),pg_temp.uid(5),'another book',array[pg_temp.key('other-scope.webp')]);
set role service_role;
do $$ begin
  begin perform pg_temp.go(pg_temp.manifest()); assert false; exception when object_not_in_prerequisite_state then null; end;
  assert not exists(select 1 from comic_art_maintenance.active_projects);
end $$;
reset role;
update public.comic_version_chunks set content=pg_temp.key('forgotten-in-the-past.webp'), paths=array[pg_temp.key('art_w480.webp')]
 where project_id=pg_temp.uid(2);
set role service_role;
do $$ declare m jsonb=pg_temp.manifest(); begin
  assert pg_temp.go(m)=3;
  assert exists(select 1 from pg_locks where pid=pg_backend_pid() and relation='storage.objects'::regclass and mode='ShareLock' and granted);
  assert exists(select 1 from pg_locks where pid=pg_backend_pid() and relation='public.image_assets'::regclass and mode='ShareRowExclusiveLock' and granted);
  assert pg_temp.go(m)=3;
  begin perform pg_temp.go(jsonb_set(m,'{0,sourceVersion}','"not-original"')); assert false; exception when object_not_in_prerequisite_state then null; end;
  assert (select count(*)=1 and bool_and(owner_id=pg_temp.uid(1)) from public.comic_private_art_scopes(array[pg_temp.uid(2),pg_temp.uid(3),pg_temp.uid(2)]));
  assert (select count(*)=2 from public.image_assets where bucket='comic-private');
  assert (select bool_and(bucket='comic-assets') from public.image_assets where user_id=pg_temp.uid(5) or project_id=pg_temp.uid(3));
  assert (select count(*)=3 from storage.objects where bucket_id='comic-assets' and name like pg_temp.key('%'));
  update public.image_assets set bucket='comic-assets' where path=pg_temp.key('art.webp');
  assert (select bucket='comic-private' from public.image_assets where path=pg_temp.key('art.webp'));
  begin update public.image_assets set user_id=pg_temp.uid(5) where path=pg_temp.key('art.webp'); assert false; exception when check_violation then null; end;
  reset role;
  insert into public.image_assets(path,user_id,project_id,bucket) values
    (upper(pg_temp.key('uppercase-scope.webp')),pg_temp.uid(1),pg_temp.uid(2),'comic-assets'),
    (replace(pg_temp.key('mixed-scope.webp'),pg_temp.uid(2)::text,upper(pg_temp.uid(2)::text)),pg_temp.uid(1),pg_temp.uid(2),'comic-assets'),
    (pg_temp.key('UPPERCASE-ART.webp'),pg_temp.uid(1),pg_temp.uid(2),'comic-assets');
  assert (select bool_and(bucket='comic-assets') from public.image_assets where path in (
    upper(pg_temp.key('uppercase-scope.webp')),replace(pg_temp.key('mixed-scope.webp'),pg_temp.uid(2)::text,upper(pg_temp.uid(2)::text))));
  assert (select bucket='comic-private' from public.image_assets where path=pg_temp.key('UPPERCASE-ART.webp'));
  set local role service_role;
  update public.projects set user_id=pg_temp.uid(5) where id=pg_temp.uid(2);
  begin perform public.comic_private_art_scopes(array[pg_temp.uid(2)]); assert false; exception when object_not_in_prerequisite_state then null; end;
  begin update public.image_assets set bucket='comic-assets' where path=pg_temp.key('art.webp'); assert false; exception when object_not_in_prerequisite_state then null; end;
  assert not exists(select 1 from public.comic_private_art_scopes(array[pg_temp.uid(3)]));
end $$;
reset role;
\echo COMIC_PRIVATE_ART_CUTOVER_OK
