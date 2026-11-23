-- Extend the fixed editorial identifiers after studio_original_editions.sql.
-- Registering this pair creates no edition, gate decision, storage asset or public listing.
begin;
set local lock_timeout = '5s';

-- Check under a short write-excluding lock; a later service claim checks again before inserting.
lock table public.comic_publications in share mode;
do $$
begin
  if exists (select 1 from public.comic_publications where slug = 'DSOriginalPort001') then
    raise exception 'Harbor editorial slug is already used by a member publication';
  end if;
end $$;

alter table public.studio_original_editions
  drop constraint studio_original_editions_book_key_check,
  drop constraint studio_original_editions_check,
  add constraint studio_original_editions_book_key_check
    check (book_key in ('tide', 'orchard', 'fox', 'table-nine', 'harbor')),
  add constraint studio_original_editions_check check (slug = case book_key
    when 'tide'       then 'DSOriginalTide001'
    when 'orchard'    then 'DSOriginalTree001'
    when 'fox'        then 'DSOriginalFox0001'
    when 'table-nine' then 'DSOriginalNine001'
    when 'harbor'     then 'DSOriginalPort001'
  end);

commit;
