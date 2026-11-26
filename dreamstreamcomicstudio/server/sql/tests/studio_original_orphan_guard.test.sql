\set ON_ERROR_STOP on
-- The orphan sweep's scan must never list a Studio Original's pub/<asset_key>/ folder: editions have no
-- comic_publications row, so before the guard every published Original read as an orphan a day later.
create schema if not exists storage;
create table storage.objects(bucket_id text not null, name text not null, created_at timestamptz not null default now());
create table public.comic_publications(slug text, asset_key text, status text);
grant select on public.comic_publications to service_role;
\ir ../studio_original_editions.sql
\ir ../studio_original_orphan_guard.sql
\ir ../studio_original_orphan_guard.sql
do $$
declare
  edition text := 'EditionFolderFixture01';
  member text := 'MemberFolderFixture001';
  orphan text := 'OrphanFolderFixture001';
  fresh text := 'FreshFolderFixture0001';
  keys text[];
begin
  insert into public.studio_original_editions(book_key, slug, source_digest, asset_key, status)
  values ('tide', 'DSOriginalTide001', repeat('a', 64), edition, 'staging');
  insert into public.comic_publications(slug, asset_key, status) values ('MemberSlug', member, 'live');
  insert into storage.objects(bucket_id, name, created_at) values
    ('comic-assets', 'pub/' || edition || '/cover.webp', now() - interval '3 days'),
    ('comic-assets', 'pub/' || member || '/page-01.webp', now() - interval '3 days'),
    ('comic-assets', 'pub/' || orphan || '/page-01.webp', now() - interval '3 days'),
    ('comic-assets', 'pub/' || fresh || '/page-01.webp', now());
  select array_agg(k order by k) into keys from public.comic_publication_orphan_keys(100) as k;
  assert keys = array[orphan], format('expected only the orphan folder, got %s', keys);
  assert not has_function_privilege('anon', 'public.comic_publication_orphan_keys(integer)', 'execute');
  assert not has_function_privilege('authenticated', 'public.comic_publication_orphan_keys(integer)', 'execute');
  assert has_function_privilege('service_role', 'public.comic_publication_orphan_keys(integer)', 'execute');
end$$;
\echo STUDIO_ORIGINAL_ORPHAN_GUARD_OK
