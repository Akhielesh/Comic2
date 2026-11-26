-- Studio Originals keep their public artwork under comic-assets/pub/<asset_key>/, the same layout as member
-- publications, but they have no comic_publications row. comic_publication_orphan_keys() (comic_publications.sql)
-- only spares prefixes owned by a live or suspended comic_publications row, so every Original's folder read as an
-- orphan one day after it was published, and the opportunistic sweep would delete it.
--
-- This replaces the function with the same query plus one more exclusion: any asset_key recorded in
-- studio_original_editions, whatever the edition's status. The server also skips those keys itself
-- (sweepOrphanPublications), so either guard alone protects the artwork.
--
-- Apply after server/sql/comic_publications.sql and server/sql/studio_original_editions.sql, and again whenever
-- comic_publications.sql is re-applied (that file defines the function without this exclusion).
-- Idempotent; changes no data, grants or tables.

create or replace function public.comic_publication_orphan_keys(p_limit integer default 200)
returns setof text
language sql
stable
security definer
set search_path = public, storage
as $$
  select k.asset_key
    from (
      select split_part(o.name, '/', 2) as asset_key, max(o.created_at) as newest
        from storage.objects o
       where o.bucket_id = 'comic-assets'
         and o.name like 'pub/%'
       group by split_part(o.name, '/', 2)
    ) k
   where k.asset_key ~ '^[A-Za-z0-9]{22}$'
     and k.newest < now() - interval '1 day'
     and not exists (
       select 1 from public.comic_publications c
        where c.asset_key = k.asset_key and c.status in ('live', 'suspended'))
     and not exists (
       select 1 from public.studio_original_editions e
        where e.asset_key = k.asset_key)
   limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;

revoke all on function public.comic_publication_orphan_keys(integer) from public, anon, authenticated;
grant execute on function public.comic_publication_orphan_keys(integer) to service_role;
