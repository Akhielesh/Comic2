-- Apply before enabling private Director outputs. Preserve an existing larger or unlimited capacity.
-- The application still limits reference uploads to 10 MiB; a finished Director WebP can be 40 MiB.
do $$
begin
  if not exists (select 1 from storage.buckets where id = 'comic-private' and public is false
      and (allowed_mime_types is null or 'image/webp' = any (allowed_mime_types))) then
    raise exception 'An existing private comic-private bucket accepting WebP is required';
  end if;
  update storage.buckets set file_size_limit = 41943040
   where id = 'comic-private' and public is false and file_size_limit < 41943040;
end $$;
