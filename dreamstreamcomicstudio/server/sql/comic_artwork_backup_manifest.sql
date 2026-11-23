begin;
-- A service-only keyset listing for the two Comic Studio storage buckets. Reading object
-- metadata here does not modify any storage object or change its existing bucket policies.
create or replace function public.comic_artwork_backup_manifest(p_bucket text, p_after uuid, p_limit integer)
returns table(id uuid, bucket text, name text, version text, size bigint, etag text, "updatedAt" timestamptz)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if p_bucket is null or p_bucket not in ('comic-assets','comic-private') or p_limit is null or p_limit not between 1 and 50 then
    raise exception 'Invalid backup scope' using errcode='22023';
  end if;
  return query
    select o.id,o.bucket_id,o.name,o.version,
      case when o.metadata->>'size' ~ '^[0-9]{1,15}$' then (o.metadata->>'size')::bigint end,
      coalesce(o.metadata->>'eTag',o.metadata->>'etag',o.metadata->>'ETag'),
      o.updated_at
    from storage.objects o where o.bucket_id=p_bucket and (p_after is null or o.id>p_after)
    order by o.id limit p_limit;
end $$;
revoke all on function public.comic_artwork_backup_manifest(text,uuid,integer) from public, anon, authenticated;
grant execute on function public.comic_artwork_backup_manifest(text,uuid,integer) to service_role;
commit;
