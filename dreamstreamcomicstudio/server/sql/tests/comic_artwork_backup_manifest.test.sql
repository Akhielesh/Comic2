\set ON_ERROR_STOP 1
create schema if not exists storage;
create table if not exists storage.objects(id uuid primary key,bucket_id text,name text,version text,metadata jsonb,updated_at timestamptz);
alter table storage.objects add column if not exists version text, add column if not exists metadata jsonb, add column if not exists updated_at timestamptz;
grant usage on schema storage to service_role;
grant select on storage.objects to service_role;
\ir ../comic_artwork_backup_manifest.sql
\ir ../comic_artwork_backup_manifest.sql
begin;
insert into storage.objects(id,bucket_id,name,version,metadata,updated_at) values
 ('00000000-0000-0000-0000-000000000001','comic-private','private-a','v1','{"size":0,"eTag":"one"}',now()),
 ('00000000-0000-0000-0000-000000000002','avatars','unrelated','v1','{}',now()),
 ('00000000-0000-0000-0000-000000000003','comic-private','private-b',null,'{"size":"unknown"}',now()),
 ('00000000-0000-0000-0000-000000000004','comic-assets','public-a','v3','{"size":"560","etag":"three"}',now());
set local role service_role;
do $$ declare a record; begin
 assert not has_function_privilege('anon','public.comic_artwork_backup_manifest(text,uuid,integer)','execute');
 assert not has_function_privilege('authenticated','public.comic_artwork_backup_manifest(text,uuid,integer)','execute');
 assert has_function_privilege('service_role','public.comic_artwork_backup_manifest(text,uuid,integer)','execute');
 select * into a from public.comic_artwork_backup_manifest('comic-private',null,1);
 assert a.name='private-a' and a.size=0 and a.etag='one' and a.bucket='comic-private';
 select * into a from public.comic_artwork_backup_manifest('comic-private',a.id,1);
 assert a.name='private-b' and a.size is null and a.etag is null and a.version is null;
 assert not exists(select 1 from public.comic_artwork_backup_manifest('comic-private',a.id,50));
 select * into a from public.comic_artwork_backup_manifest('comic-assets',null,1);
 assert a.name='public-a' and a.size=560 and a.etag='three';
 begin perform public.comic_artwork_backup_manifest('avatars',null,1); assert false; exception when invalid_parameter_value then null; end;
 begin perform public.comic_artwork_backup_manifest('comic-assets',null,51); assert false; exception when invalid_parameter_value then null; end;
end $$;
rollback;
