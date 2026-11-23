\set ON_ERROR_STOP 1
create schema if not exists storage;
create table storage.buckets(id text primary key, public boolean, file_size_limit bigint, allowed_mime_types text[]);
insert into storage.buckets values
  ('comic-private',false,10485760,array['image/webp','image/png']),
  ('comic-assets',true,10485760,array['image/webp']);
\ir ../comic_private_draft_capacity.sql
\ir ../comic_private_draft_capacity.sql
do $$ begin
  assert (select public is false and file_size_limit=41943040 and allowed_mime_types=array['image/webp','image/png'] from storage.buckets where id='comic-private');
  assert (select public and file_size_limit=10485760 from storage.buckets where id='comic-assets');
end $$;
update storage.buckets set file_size_limit=null where id='comic-private';
\ir ../comic_private_draft_capacity.sql
do $$ begin
  assert (select file_size_limit is null from storage.buckets where id='comic-private');
end $$;
\echo COMIC_PRIVATE_DRAFT_CAPACITY_OK
