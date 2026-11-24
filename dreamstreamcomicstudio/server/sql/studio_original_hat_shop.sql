-- Apply after studio_original_collection.sql. Register the route without creating an edition or a review.
begin;
set local lock_timeout = '5s';
lock table public.comic_publications in share mode;
do $$
begin
  if exists (select from public.comic_publications where slug = 'DSOriginalHats001') then
    raise exception 'Hat Shop editorial slug is already used by a member publication';
  end if;
end $$;

create or replace function public.studio_original_story_pages(p_key text)
returns integer language sql immutable strict set search_path='' as $$
  select case when p_key = 'margin' then 30 when p_key in ('parrots','glass-hills') then 20
              when p_key in ('tide','orchard','fox','table-nine','harbor','bubble','night-atlas','hat-shop') then 15 end
$$;

-- The existing collection checks enforce the full text, cover and page report, story count, comic format,
-- left-to-right reading order and portrait aspect. Lock the new reading copy to its own public ID and title.
alter table public.studio_original_editions
  drop constraint studio_original_editions_check,
  add constraint studio_original_editions_check check (slug = case book_key
    when 'tide' then 'DSOriginalTide001' when 'orchard' then 'DSOriginalTree001' when 'fox' then 'DSOriginalFox0001'
    when 'table-nine' then 'DSOriginalNine001' when 'harbor' then 'DSOriginalPort001' when 'margin' then 'DSOriginalMarg001'
    when 'parrots' then 'DSOriginalBird001' when 'bubble' then 'DSOriginalBubl001' when 'glass-hills' then 'DSOriginalWest001'
    when 'night-atlas' then 'DSOriginalNite001' when 'hat-shop' then 'DSOriginalHats001' end),
  drop constraint if exists original_hat_shop_edition,
  add constraint original_hat_shop_edition check (book_key <> 'hat-shop' or (
    (rating is null or rating = 'PG') and (status <> 'live' or (
      snapshot->>'id' is not distinct from slug
      and card->>'title' is not distinct from 'Four Letters and a Hat Shop'
      and snapshot#>>'{brief,title}' is not distinct from card->>'title'
    ))
  ));

-- Keep this first-time book out of the service-only historical revision RPC.
alter table studio_original_review.attempts
  drop constraint if exists original_hat_shop_first_review,
  add constraint original_hat_shop_first_review check (book_key <> 'hat-shop');
commit;
