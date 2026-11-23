-- Apply after studio_original_harbor.sql, studio_original_rating_review.sql and comic_discovery.sql.
-- Registers the second editorial collection. No user identities, source files, edition rows or moderation receipts are created.
begin;
set local lock_timeout = '5s';
lock table public.comic_publications in share mode;
do $$
begin
  if exists (select 1 from public.comic_publications where slug in ('DSOriginalMarg001','DSOriginalBird001',
    'DSOriginalBubl001','DSOriginalWest001','DSOriginalNite001')) then
    raise exception 'A collection identifier is already used by a member publication'; end if;
end $$;

create or replace function public.studio_original_story_pages(p_key text)
returns integer language sql immutable strict set search_path='' as $$
  select case when p_key='margin' then 30 when p_key in ('parrots','glass-hills') then 20
              when p_key in ('tide','orchard','fox','table-nine','harbor','bubble','night-atlas') then 15 end
$$;
revoke all on function public.studio_original_story_pages(text) from public,anon,authenticated,service_role;
grant execute on function public.studio_original_story_pages(text) to service_role;

-- Use the existing strict report schema and hard-category/rating evaluation for all approved book lengths.
create or replace function studio_original_review.outcome(r jsonb, requested text, ceiling text, expected_pages integer)
returns text language plpgsql immutable set search_path='' as $$
declare
  target jsonb; state text; assessed text; grade integer; hard boolean := false;
  overage boolean := false; missing boolean := false;
  ages constant text[] := array['G','PG','PG-13'];
  categories constant text[] := array['sexual','minor_sexual','nudity','graphic_gore','self_harm','hate','harassment',
                                      'real_person','dangerous','violence','scary','language','romance','substances','weapons','ip_parody'];
  hard_categories constant text[] := array['sexual','minor_sexual','nudity','graphic_gore','self_harm','hate','harassment','real_person','dangerous'];
begin
  if jsonb_typeof(r) is distinct from 'object' or not (r ?& array['pages','cover','text'])
     or r - array['pages','cover','text'] <> '{}'::jsonb or jsonb_typeof(r->'pages') is distinct from 'array' then return 'invalid'; end if;
  if expected_pages is null or expected_pages not in (15,20,30) or jsonb_array_length(r->'pages')<>expected_pages or array_position(ages,requested) is null or array_position(ages,ceiling) is null then return 'invalid'; end if;
  for target in select value from jsonb_array_elements(jsonb_build_array(r->'text',r->'cover') || (r->'pages')) loop
    if jsonb_typeof(target) is distinct from 'object' or not (target ?& array['status','assessed','categories'])
       or target - array['status','assessed','categories'] <> '{}'::jsonb
       or jsonb_typeof(target->'categories') is distinct from 'array' then return 'invalid'; end if;
    if jsonb_array_length(target->'categories')>cardinality(categories)
       or exists (select 1 from jsonb_array_elements(target->'categories') c
                   where jsonb_typeof(c) <> 'string' or not ((c#>>'{}')=any(categories))) then return 'invalid'; end if;
    state:=target->>'status'; assessed:=target->>'assessed'; grade:=array_position(ages,assessed);
    if state is null or state not in ('pass','over_rating','unchecked','pending','blocked')
       or (assessed is not null and grade is null and assessed<>'X') then return 'invalid'; end if;
    if state='blocked' or assessed='X' or target->'categories' ?| hard_categories or grade>array_position(ages,ceiling) then hard:=true;
    elsif state in ('unchecked','pending') or assessed is null then missing:=true;
    elsif grade>array_position(ages,requested) then
      if state<>'over_rating' then return 'invalid'; end if;
      overage:=true;
    elsif state<>'pass' then return 'invalid';
    end if;
  end loop;
  return case when hard then 'blocked' when overage and missing then 'mixed'
              when overage then 'over_rating' when missing then 'needs_check' else 'cleared' end;
end $$;

revoke all on function studio_original_review.outcome(jsonb,text,text,integer) from public,anon,authenticated,service_role;
-- Preserve the historical fifteen-page archive/claim contract exactly.
create or replace function studio_original_review.outcome(r jsonb, requested text, ceiling text)
returns text language sql immutable set search_path='' as $$
  select studio_original_review.outcome(r,requested,ceiling,15)
$$;
create or replace function public.studio_original_report_state(p_key text,p_report jsonb,p_rating text)
returns text language sql immutable security definer set search_path='' as $$
  select studio_original_review.outcome(p_report,p_rating,'PG-13',public.studio_original_story_pages(p_key))
$$;
revoke all on function public.studio_original_report_state(text,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.studio_original_report_state(text,jsonb,text) to service_role;

-- Each new source is a first-time edition. The old metadata-only historical revision flow cannot be used on these keys.
alter table studio_original_review.attempts drop constraint if exists original_first_time_collection,
  add constraint original_first_time_collection check (book_key not in ('margin','parrots','bubble','glass-hills','night-atlas'));

alter table public.studio_original_editions
  drop constraint studio_original_editions_book_key_check,
  drop constraint studio_original_editions_check,
  drop constraint original_live_complete,
  drop constraint original_review_report_shape,
  drop constraint if exists original_collection_review,
  add constraint studio_original_editions_book_key_check check (public.studio_original_story_pages(book_key) is not null),
  add constraint studio_original_editions_check check (slug = case book_key
    when 'tide' then 'DSOriginalTide001' when 'orchard' then 'DSOriginalTree001' when 'fox' then 'DSOriginalFox0001'
    when 'table-nine' then 'DSOriginalNine001' when 'harbor' then 'DSOriginalPort001' when 'margin' then 'DSOriginalMarg001'
    when 'parrots' then 'DSOriginalBird001' when 'bubble' then 'DSOriginalBubl001' when 'glass-hills' then 'DSOriginalWest001'
    when 'night-atlas' then 'DSOriginalNite001' end),
  add constraint original_review_report_shape check (review_report is null
    or public.studio_original_report_state(book_key,review_report,rating) <> 'invalid'),
  add constraint original_collection_review check (book_key in ('tide','orchard','fox','table-nine','harbor')
    or status not in ('checked','live') or
    (review_report is not null and public.studio_original_report_state(book_key,review_report,rating) is not distinct from 'cleared')),
  add constraint original_live_complete check (status <> 'live' or (
    published_at is not null and card is not null and jsonb_typeof(card)='object'
    and (card->>'pageCount') is not distinct from public.studio_original_story_pages(book_key)::text
    and snapshot is not null and jsonb_typeof(snapshot->'pages') is not distinct from 'array'
    and jsonb_array_length(snapshot->'pages')=public.studio_original_story_pages(book_key)
    and cover_path is not null and starts_with(cover_path,'pub/'||asset_key||'/')
    and (book_key in ('tide','orchard','fox','table-nine','harbor') or (
      snapshot#>'{format,pageCount}' is not distinct from to_jsonb(public.studio_original_story_pages(book_key))
      and snapshot#>>'{format,kind}' is not distinct from (case when book_key='margin' then 'manga' else 'comic' end)
      and snapshot#>>'{format,readingDirection}' is not distinct from (case when book_key='margin' then 'rtl' else 'ltr' end)
      and card->>'kindLabel' is not distinct from (case when book_key='margin' then 'Manga' else 'Comic' end)
      and card->>'aspect' is not distinct from snapshot#>>'{format,pageAspect}'
      and coalesce(case when book_key in ('glass-hills','night-atlas')
        then snapshot#>>'{format,pageAspect}' in ('3:2','4:3','5:4','16:9','21:9','4:1','8:1')
        else snapshot#>>'{format,pageAspect}' in ('2:3','3:4','4:5','9:16','9:21','1:4','1:8') end,false)
    ))
  ));

create or replace function public.comic_originals_catalog()
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('slug',e.slug,'title',e.card->>'title','description',e.card->>'description','coverPath',e.cover_path,
 'creator',e.card->>'creator','language','en','style',e.snapshot#>>'{style,name}','rating',e.rating,'pageCount',jsonb_array_length(e.snapshot->'pages'),
 'kind',coalesce(e.snapshot#>>'{format,kind}','comic'),'aspectRatio',e.snapshot#>>'{format,pageAspect}',
 'publishedAt',(extract(epoch from e.published_at)*1000)::bigint,'updatedAt',(extract(epoch from e.published_at)*1000)::bigint) order by e.book_key),'[]'::jsonb)
 from public.studio_original_editions e where e.status='live' and e.checked_digest=e.source_digest
$$;

-- Preserve the deployed Discover body, permissions and member visibility clauses. Abort on an unexpected
-- editorial branch instead of replacing a diverged function. The stock comic_discovery.sql has the same two updates.
do $$
declare
  func regprocedure := 'public.comic_discover_list(text,text,text,text,text,text,boolean,integer,text,text[])'::regprocedure;
  def text := pg_get_functiondef(func);
  prev_output text := $old$'kind', 'comic', 'pageCount', e->'pageCount'$old$;
  next_output text := $new$'kind', coalesce(e->>'kind','comic'), 'pageCount', e->'pageCount'$new$;
  prev_filter text := $old$(p_kind is null or p_kind='comic')$old$;
  next_filter text := $new$(p_kind is null or p_kind=coalesce(e->>'kind','comic'))$new$;
begin
  if strpos(def,next_output)>0 and strpos(def,next_filter)>0 and strpos(def,prev_output)=0 and strpos(def,prev_filter)=0 then return; end if;
  if cardinality(string_to_array(def,prev_output))<>2 or cardinality(string_to_array(def,prev_filter))<>2
     or strpos(def,next_output)>0 or strpos(def,next_filter)>0 then raise exception 'Unexpected editorial Discover definition'; end if;
  execute replace(replace(def,prev_output,next_output),prev_filter,next_filter);
end $$;
commit;
