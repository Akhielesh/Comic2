-- comic_discovery.sql (redesign DS-R2; owner decision R-D3), on a throwaway Postgres with stand-ins for the production
-- tables it reads (projects, comic_docs, storage.objects, profiles.avatar_url) and comic_publications.sql under it.
-- Synthetic data only.
--   * the file applies twice (idempotent), and again with data in place;
--   * an anonymous caller sees every live PUBLIC comic exactly once across the pages of every sort, and never an
--     unlisted, unpublished, suspended or held (forced-private) one; every page but the last is full;
--   * items carry only the allow-listed keys; a byline only where the publication shows its creator; an avatar only
--     from our storage; a cover only under the publication's own pub/<key>/;
--   * the limit is clamped to 1..24; a search is LIKE-escaped (a '%' or '_' finds itself) and finds a username only
--     where it is shown; rating, kind, language and length filter; unknown inputs answer an empty page;
--   * "this week" windows, the trending order, localized titles, featured picks (window, hold) and the shelves;
--   * comic_featured and comic_discover_kind are out of the clients' reach; both RPCs are SECURITY DEFINER with
--     search_path = public; a hold that lands later takes the comic out of the listing.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- Like Supabase: new tables in public are granted to the API roles unless revoked.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

-- ── Stand-ins for the production tables (only the columns these files read) ─────────────────────────────────────
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  name text,
  state jsonb,
  is_public boolean default false,
  is_forced_private boolean default false,
  cover_image_url text,
  likes_count integer not null default 0,
  views_count integer not null default 0,
  updated_at timestamptz default now()
);
create table public.comic_docs (
  project_id uuid primary key references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  doc jsonb not null,
  rev integer not null default 0
);
create or replace function auth.role() returns text language sql stable as $$ select nullif(auth.jwt() ->> 'role', '') $$;
create schema if not exists storage;
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, created_at timestamptz default now());

\ir ../comic_publications.sql

-- The listing reads profiles.avatar_url (the stub has no such column; production does).
alter table public.profiles add column if not exists avatar_url text;

\ir ../comic_discovery.sql
\ir ../comic_discovery.sql

-- ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────
insert into auth.users (id) values
  ('00000000-0000-4000-8000-00000000000a'), ('00000000-0000-4000-8000-00000000000b'),
  ('00000000-0000-4000-8000-00000000000c'), ('00000000-0000-4000-8000-00000000000d');
insert into public.profiles (id, username, avatar_url) values
  ('00000000-0000-4000-8000-00000000000a', 'alice', 'https://abcdefghij12.supabase.co/storage/v1/object/public/comic-assets/avatars/alice-1.webp'),
  ('00000000-0000-4000-8000-00000000000b', 'bob', 'https://abcdefghij12.supabase.co/storage/v1/object/public/comic-assets/avatars/bob.webp'),
  -- An uploaded avatar lives under the owner's id: never listed.
  ('00000000-0000-4000-8000-00000000000c', 'cara_x', 'https://abcdefghij12.supabase.co/storage/v1/object/public/comic-assets/00000000-0000-4000-8000-00000000000c/avatar-1.webp'),
  ('00000000-0000-4000-8000-00000000000d', 'dave', 'https://tracker.example/pixel.png');

create function pg_temp.mk(
  p_slug text, p_user uuid, p_title text,
  p_status text default 'live', p_visibility text default 'public', p_held boolean default false,
  p_rating text default 'PG', p_kind_label text default 'Comic', p_pages integer default 4,
  p_show_creator boolean default false, p_langs text[] default '{en}',
  p_first timestamptz default now() - interval '1 day', p_views bigint default 0, p_likes integer default 0,
  p_cover text default 'variants', p_extra_card jsonb default '{}'::jsonb
) returns uuid language plpgsql as $$
declare
  v_project uuid := gen_random_uuid();
  v_key text := 'K' || left(md5(p_slug), 21);
  v_asset jsonb;
  v_snapshot jsonb;
  v_pub uuid;
begin
  insert into public.projects (id, user_id, name, state, is_public, is_forced_private, likes_count)
  values (v_project, p_user, p_title, '{}'::jsonb, p_visibility = 'public', p_held, p_likes);
  v_asset := case p_cover
    when 'variants' then jsonb_build_object('path', 'pub/' || v_key || '/cover-0123456789ab.webp', 'w', 2048, 'h', 3072,
      'variants', jsonb_build_array(
        jsonb_build_object('path', 'pub/' || v_key || '/cover-0123456789ab-w480.webp', 'w', 480, 'h', 720),
        jsonb_build_object('path', 'pub/' || v_key || '/cover-0123456789ab-w1080.webp', 'w', 1080, 'h', 1620)))
    when 'plain' then jsonb_build_object('path', 'pub/' || v_key || '/cover-0123456789ab.webp', 'w', 400, 'h', 600)
    when 'foreign' then jsonb_build_object('path', 'pub/K' || left(md5('someone else'), 21) || '/cover-0123456789ab.webp', 'w', 400, 'h', 600)
  end;
  v_snapshot := jsonb_build_object(
    'format', jsonb_build_object('kind', 'comic'),
    'cover', case when p_cover = 'page' then jsonb_build_object('render', jsonb_build_object('status', 'none'))
                  else jsonb_build_object('render', jsonb_build_object('status', 'ready', 'asset', v_asset)) end,
    'pages', case when p_cover = 'page'
                  then jsonb_build_array(jsonb_build_object('render', jsonb_build_object('status', 'ready', 'asset',
                         jsonb_build_object('path', 'pub/' || v_key || '/page-0123456789ab.webp'))))
                  else '[]'::jsonb end);
  insert into public.comic_publications (project_id, user_id, status, visibility, slug, asset_key, languages, show_creator,
                                         snapshot, card, safety, views_count, first_published_at, published_at)
  values (v_project, p_user, p_status, p_visibility, p_slug, v_key, p_langs, p_show_creator, v_snapshot,
          jsonb_build_object('v', 1, 'title', p_title, 'description', 'About ' || p_title, 'kindLabel', p_kind_label,
                             'pageCount', p_pages, 'aspect', '2:3', 'og', '{}'::jsonb, 'i18n', '{}'::jsonb) || p_extra_card,
          case when p_rating is null then '{}'::jsonb else jsonb_build_object('rating', p_rating) end,
          p_views, p_first, p_first)
  returning id into v_pub;
  return v_pub;
end $$;

select pg_temp.mk('aSpiceRun00000001', '00000000-0000-4000-8000-00000000000a', 'Spice Run', p_rating => 'G', p_pages => 12,
                  p_show_creator => true, p_langs => '{en,hi}', p_first => now() - interval '2 days', p_views => 50, p_likes => 7,
                  p_extra_card => jsonb_build_object('themeColor', '#aabbcc', 'i18n', jsonb_build_object('hi', jsonb_build_object('title', 'मसाला दौड़', 'description', 'एक कूरियर'))));
select pg_temp.mk('bMoonManga0000002', '00000000-0000-4000-8000-00000000000b', 'Moon Manga', p_rating => 'PG-13', p_kind_label => 'Manga',
                  p_pages => 30, p_first => now() - interval '30 days', p_views => 500);
select pg_temp.mk('cHeldStory0000003', '00000000-0000-4000-8000-00000000000b', 'Held Story', p_held => true, p_views => 9999);
select pg_temp.mk('dUnlisted00000004', '00000000-0000-4000-8000-00000000000b', 'Unlisted Tale', p_visibility => 'unlisted', p_views => 9999);
select pg_temp.mk('eUnpublish0000005', '00000000-0000-4000-8000-00000000000b', 'Unpublished Tale', p_status => 'unpublished', p_views => 9999);
select pg_temp.mk('fSuspended0000006', '00000000-0000-4000-8000-00000000000b', 'Suspended Tale', p_status => 'suspended', p_views => 9999);
select pg_temp.mk('gNoRating00000007', '00000000-0000-4000-8000-00000000000c', 'Unrated Book', p_rating => null, p_kind_label => 'Storybook',
                  p_show_creator => true, p_cover => 'plain');
select pg_temp.mk('hPercent000000008', '00000000-0000-4000-8000-00000000000d', '100% Real_Deal', p_show_creator => true, p_cover => 'page');
-- 30 fillers in ONE statement: now() is the same for all, so z1..z10 share the exact first-publish time (keyset ties).
select pg_temp.mk('zFill' || lpad(i::text, 12, '0'), '00000000-0000-4000-8000-00000000000c', 'Filler ' || i,
                  p_first => case when i <= 10 then now() - interval '3 hours' + interval '0.123456 seconds' else now() - (i || ' hours')::interval end,
                  p_views => i % 5, p_cover => case when i = 1 then 'foreign' else 'variants' end)
  from generate_series(1, 30) i;
select pg_temp.mk('wToon' || lpad(i::text, 12, '0'), '00000000-0000-4000-8000-00000000000c', 'Toon ' || i, p_kind_label => 'Webtoon',
                  p_first => now() - interval '20 days')
  from generate_series(1, 4) i;

insert into public.comic_publication_stats (publication_id, day, views, uniques)
select c.id, d.day, d.n * 3, d.n
  from public.comic_publications c
  join (values ('aSpiceRun00000001', current_date, 5), ('aSpiceRun00000001', current_date - 1, 3),
               ('zFill000000000005', current_date, 2), ('bMoonManga0000002', current_date - 20, 100),
               ('cHeldStory0000003', current_date, 900)) d(slug, day, n) on d.slug = c.slug;

insert into public.comic_featured (publication_id, rank, starts_at, ends_at)
select c.id, f.rank, f.starts_at, f.ends_at
  from public.comic_publications c
  join (values ('aSpiceRun00000001', 5, null::timestamptz, null::timestamptz),
               ('cHeldStory0000003', 1, null, null),
               ('bMoonManga0000002', 10, null, now() - interval '1 day'),
               ('gNoRating00000007', 20, now() + interval '1 day', null),
               ('hPercent000000008', 30, now() - interval '1 day', now() + interval '1 day')) f(slug, rank, starts_at, ends_at)
    on f.slug = c.slug;

-- Test helper: the slugs of a page, sorted.
create or replace function public.t_slugs(p jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(e ->> 'slug' order by e ->> 'slug'), '{}') from jsonb_array_elements(p -> 'items') e
$$;

-- ── Catalogue: grants, attributes, RLS ─────────────────────────────────────────────────────────────────────────
do $$
begin
  assert has_function_privilege('anon', 'public.comic_discover_list(text, text, text, text, text, text, boolean, integer, bigint, text)', 'execute'),
    'anon can list';
  assert has_function_privilege('anon', 'public.comic_discover_shelves(text, text, text, text)', 'execute'), 'anon can read the shelves';
  assert not has_function_privilege('anon', 'public.comic_discover_kind(jsonb)', 'execute'), 'the kind helper is internal';
  assert not has_function_privilege('authenticated', 'public.comic_discover_kind(jsonb)', 'execute'), 'the kind helper is internal';
  assert (select bool_and(prosecdef and proconfig @> array['search_path=public']) from pg_proc
           where pronamespace = 'public'::regnamespace and proname in ('comic_discover_list', 'comic_discover_shelves')),
    'both RPCs are SECURITY DEFINER with search_path = public';
  assert (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'comic_discover%') = 3, 'no stray overloads';
  assert (select relrowsecurity from pg_class where oid = 'public.comic_featured'::regclass), 'comic_featured has RLS on';
  assert not exists (select 1 from pg_policies where tablename = 'comic_featured'), 'comic_featured has no policies';
  assert not has_table_privilege('anon', 'public.comic_featured', 'select'), 'anon cannot read featured picks';
  assert not has_table_privilege('authenticated', 'public.comic_featured', 'insert'), 'clients cannot feature';
  assert has_table_privilege('service_role', 'public.comic_featured', 'insert'), 'the service role seeds featured picks';
  assert exists (select 1 from pg_indexes where indexname = 'comic_publication_stats_day_idx' and indexdef like '%(day)%'), 'stats(day) index';
end $$;

set role anon;
do $$
begin
  perform 1 from public.comic_featured;
  raise exception 'anon read comic_featured';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  perform public.comic_discover_kind('{}'::jsonb);
  raise exception 'anon called comic_discover_kind';
exception when insufficient_privilege then null;
end $$;

-- ── Every live public comic once, in every sort; nothing else; only allow-listed keys ───────────────────────────
do $$
declare
  s text;
  page jsonb;
  seen text[];
  after_n bigint;
  after_slug text;
  pages integer;
  item jsonb;
  allowed constant text[] := array['slug', 'title', 'description', 'kind', 'pageCount', 'aspect', 'cover', 'rating', 'languages',
                                   'publishedAt', 'firstPublishedAt', 'likes', 'themeColor', 'creator'];
  expected constant text[] := array['aSpiceRun00000001', 'bMoonManga0000002', 'gNoRating00000007', 'hPercent000000008']
    || array(select 'zFill' || lpad(i::text, 12, '0') from generate_series(1, 30) i)
    || array(select 'wToon' || lpad(i::text, 12, '0') from generate_series(1, 4) i);
begin
  foreach s in array array['new', 'trending', 'most_read'] loop
    seen := '{}';
    after_n := null;
    after_slug := null;
    pages := 0;
    loop
      page := public.comic_discover_list(p_sort => s, p_limit => 5, p_after_n => after_n, p_after_slug => after_slug);
      pages := pages + 1;
      assert pages < 40, s || ': paging ends';
      for item in select * from jsonb_array_elements(page -> 'items') loop
        seen := seen || (item ->> 'slug');
        assert (select bool_and(k = any (allowed)) from jsonb_object_keys(item) k), s || ': only allow-listed keys, got ' || item::text;
        assert item ? 'title' and item ? 'kind' and item ? 'pageCount' and item ? 'languages' and item ? 'publishedAt', s || ': core keys';
        if item ? 'creator' then
          assert (select bool_and(k in ('username', 'avatarUrl')) from jsonb_object_keys(item -> 'creator') k), 'creator keys';
        end if;
        if item ? 'cover' then
          assert (select array_agg(k order by k) from jsonb_object_keys(item -> 'cover') k) = array['w1080', 'w480'], 'cover keys';
        end if;
      end loop;
      exit when jsonb_typeof(page -> 'next') = 'null';
      assert jsonb_array_length(page -> 'items') = 5, s || ': a page with a next page is full';
      after_n := (page -> 'next' ->> 'n')::bigint;
      after_slug := page -> 'next' ->> 'slug';
    end loop;
    assert cardinality(seen) = (select count(distinct x) from unnest(seen) x), s || ': no comic twice';
    assert (select array_agg(x order by x) from unnest(seen) x) = (select array_agg(x order by x) from unnest(expected) x),
      s || ': exactly the live public comics, got ' || array_to_string(seen, ',');
  end loop;
  page := public.comic_discover_list(p_sort => 'new', p_limit => 24);
  assert page::text !~ '(user_?id|snapshot|safety|asset_?key|views_count|0000-4000-8000)', 'no internals in a page: ' || page::text;
end $$;

-- ── Limit, order, cover, byline, localization ──────────────────────────────────────────────────────────────────
do $$
declare
  page jsonb;
  a jsonb;
  key_a text := 'K' || left(md5('aSpiceRun00000001'), 21);
begin
  assert jsonb_array_length(public.comic_discover_list(p_limit => 1000) -> 'items') = 24, 'the limit is clamped to 24';
  assert jsonb_typeof(public.comic_discover_list(p_limit => 1000) -> 'next') = 'object', 'more pages after 24';
  assert jsonb_array_length(public.comic_discover_list(p_limit => 0) -> 'items') = 1, 'the limit is at least 1';
  assert jsonb_array_length(public.comic_discover_list(p_limit => null) -> 'items') = 24, 'the default limit is 24';

  page := public.comic_discover_list(p_sort => 'trending', p_limit => 3);
  assert page -> 'items' -> 0 ->> 'slug' = 'aSpiceRun00000001' and page -> 'items' -> 1 ->> 'slug' = 'zFill000000000005',
    'trending: most unique readers in the last 7 days first (old stats and held comics do not count): ' || page::text;
  page := public.comic_discover_list(p_sort => 'most_read', p_limit => 1);
  assert page -> 'items' -> 0 ->> 'slug' = 'bMoonManga0000002', 'most read: unique readers ever';
  page := public.comic_discover_list(p_sort => 'new', p_limit => 1);
  assert page -> 'items' -> 0 ->> 'slug' = 'zFill000000000010', 'new: the newest first publication first (ties: slug)';

  select e into a from jsonb_array_elements(public.comic_discover_list(p_q => 'Spice') -> 'items') e;
  assert a ->> 'title' = 'Spice Run' and a ->> 'kind' = 'comic' and (a ->> 'pageCount')::int = 12 and a ->> 'aspect' = '2:3', 'card fields';
  assert a ->> 'rating' = 'G' and a ->> 'themeColor' = '#aabbcc' and (a ->> 'likes')::int = 7, 'rating, colour, likes';
  assert a -> 'languages' = '["en", "hi"]'::jsonb, 'languages';
  assert (a ->> 'firstPublishedAt')::bigint <= (a ->> 'publishedAt')::bigint and (a ->> 'publishedAt')::bigint > 1700000000000, 'dates in ms';
  assert a -> 'cover' = jsonb_build_object('w480', 'pub/' || key_a || '/cover-0123456789ab-w480.webp', 'w1080', 'pub/' || key_a || '/cover-0123456789ab-w1080.webp'),
    'cover variants: ' || coalesce((a -> 'cover')::text, 'none');
  assert a -> 'creator' = jsonb_build_object('username', 'alice', 'avatarUrl',
    'https://abcdefghij12.supabase.co/storage/v1/object/public/comic-assets/avatars/alice-1.webp'),
    'a shown creator carries the username and a storage avatar';

  select e into a from jsonb_array_elements(public.comic_discover_list(p_q => 'Moon') -> 'items') e;
  assert not a ? 'creator', 'no byline when the publication hides its creator';
  assert a ->> 'kind' = 'manga' and a ->> 'rating' = 'PG-13', 'manga, PG-13';
  select e into a from jsonb_array_elements(public.comic_discover_list(p_q => 'Unrated') -> 'items') e;
  assert a -> 'creator' = '{"username": "cara_x"}'::jsonb, 'an avatar under the owner''s id is never listed';
  assert not a ? 'rating' and a ->> 'kind' = 'storybook', 'no rating; storybook';
  assert a -> 'cover' ->> 'w480' = a -> 'cover' ->> 'w1080' and a -> 'cover' ->> 'w480' like 'pub/%/cover-0123456789ab.webp', 'no variants: the original';
  select e into a from jsonb_array_elements(public.comic_discover_list(p_q => 'Real') -> 'items') e;
  assert a -> 'creator' = '{"username": "dave"}'::jsonb, 'an avatar outside our storage is dropped';
  assert a -> 'cover' ->> 'w1080' like 'pub/%/page-0123456789ab.webp', 'no cover art: page 1';
  select e into a from jsonb_array_elements(public.comic_discover_list(p_q => 'Filler 1', p_sort => 'new', p_limit => 24) -> 'items') e
   where e ->> 'slug' = 'zFill000000000001';
  assert a is not null and not a ? 'cover', 'a cover outside the publication''s own prefix is never listed';

  select e into a from jsonb_array_elements(public.comic_discover_list(p_lang => 'HI') -> 'items') e;
  assert a ->> 'slug' = 'aSpiceRun00000001' and a ->> 'title' = 'मसाला दौड़' and a ->> 'description' = 'एक कूरियर',
    'a language filter is case-insensitive and shows that edition''s title';
end $$;

-- ── Search, filters, fail-closed inputs, windows ───────────────────────────────────────────────────────────────
do $$
begin
  assert public.t_slugs(public.comic_discover_list(p_q => '%')) = array['hPercent000000008'], 'a % searches for itself';
  assert public.t_slugs(public.comic_discover_list(p_q => '_')) = array['gNoRating00000007', 'hPercent000000008'],
    'an _ searches for itself (a title, or a username that is shown)';
  assert public.t_slugs(public.comic_discover_list(p_q => '100%')) = array['hPercent000000008'], '100%';
  assert public.t_slugs(public.comic_discover_list(p_q => 'alice')) = array['aSpiceRun00000001'], 'a shown username is searchable';
  assert public.t_slugs(public.comic_discover_list(p_q => 'bob')) = '{}', 'a hidden username finds nothing';
  assert public.t_slugs(public.comic_discover_list(p_q => 'cara_x')) = array['gNoRating00000007'], 'only where the username is shown';
  assert public.t_slugs(public.comic_discover_list(p_q => 'मसाला')) = array['aSpiceRun00000001'], 'a translated title is searchable';
  assert public.t_slugs(public.comic_discover_list(p_q => 'Held')) = '{}', 'a held comic is never found';
  assert public.t_slugs(public.comic_discover_list(p_q => repeat('x', 59) || 'Spice Run')) = '{}', 'the search is cut to 60 characters';
  assert public.t_slugs(public.comic_discover_list(p_q => '   ')) = public.t_slugs(public.comic_discover_list()), 'a blank search is no search';

  assert jsonb_array_length(public.comic_discover_list(p_rating => 'kids', p_limit => 24) -> 'items') = 24, 'kids-friendly comics exist';
  assert not exists (select 1 from jsonb_array_elements(public.comic_discover_list(p_rating => 'kids', p_q => 'Moon') -> 'items')), 'PG-13 is not kids';
  assert not exists (select 1 from jsonb_array_elements(public.comic_discover_list(p_rating => 'kids', p_q => 'Unrated') -> 'items')),
    'an unrated comic is never kids-friendly';
  assert public.t_slugs(public.comic_discover_list(p_rating => 'PG-13')) = array['bMoonManga0000002'], 'an exact rating';
  assert public.t_slugs(public.comic_discover_list(p_kind => 'manga')) = array['bMoonManga0000002'], 'kind from the card';
  assert public.t_slugs(public.comic_discover_list(p_kind => 'storybook')) = array['gNoRating00000007'], 'storybook';
  assert cardinality(public.t_slugs(public.comic_discover_list(p_kind => 'webtoon'))) = 4, 'webtoons';
  assert public.t_slugs(public.comic_discover_list(p_length => 'long')) = array['bMoonManga0000002'], '25+ pages';
  assert public.t_slugs(public.comic_discover_list(p_length => 'medium')) = array['aSpiceRun00000001'], '9-24 pages';

  assert public.t_slugs(public.comic_discover_list(p_rating => 'kidz')) = '{}', 'an unknown rating answers nothing, never everything';
  assert public.t_slugs(public.comic_discover_list(p_kind => 'novel')) = '{}', 'an unknown kind answers nothing';
  assert public.t_slugs(public.comic_discover_list(p_length => 'epic')) = '{}', 'an unknown length answers nothing';
  assert public.t_slugs(public.comic_discover_list(p_sort => 'random')) = '{}', 'an unknown sort answers nothing';
  assert public.t_slugs(public.comic_discover_list(p_sort => null)) = '{}', 'a null sort answers nothing';
  assert public.t_slugs(public.comic_discover_list(p_lang => 'english!')) = '{}', 'a malformed language answers nothing';
  assert public.t_slugs(public.comic_discover_list(p_after_n => 5)) = '{}', 'half a cursor answers nothing';
  assert public.t_slugs(public.comic_discover_list(p_after_n => -1, p_after_slug => 'aSpiceRun00000001')) = '{}', 'a negative cursor answers nothing';
  assert public.t_slugs(public.comic_discover_list(p_after_n => 1, p_after_slug => 'short')) = '{}', 'a malformed cursor slug answers nothing';

  assert public.t_slugs(public.comic_discover_list(p_sort => 'trending', p_week => true)) = array['aSpiceRun00000001', 'zFill000000000005'],
    'trending this week: read in the last 7 days';
  assert public.t_slugs(public.comic_discover_list(p_sort => 'new', p_week => true, p_q => 'Moon')) = '{}', 'new this week: not 30 days old';
  assert public.t_slugs(public.comic_discover_list(p_sort => 'new', p_week => true, p_q => 'Toon')) = '{}', 'new this week: not 20 days old';
  assert public.t_slugs(public.comic_discover_list(p_sort => 'new', p_week => true, p_q => 'Spice')) = array['aSpiceRun00000001'], 'new this week: 2 days old';
  assert cardinality(public.t_slugs(public.comic_discover_list(p_sort => 'new', p_q => 'Toon'))) = 4, 'without the window they are listed';
end $$;

-- ── Featured and the shelves ───────────────────────────────────────────────────────────────────────────────────
do $$
declare
  s jsonb;
begin
  s := public.comic_discover_shelves();
  assert (select array_agg(k order by k) from jsonb_object_keys(s) k) = array['featured', 'kids', 'manga', 'new', 'trending', 'webtoon'],
    'the home shelves (no language asked): ' || (select string_agg(k, ',') from jsonb_object_keys(s) k);
  assert public.t_slugs(jsonb_build_object('items', s -> 'featured')) = array['aSpiceRun00000001', 'hPercent000000008'],
    'featured: in its window and never held';
  assert s -> 'featured' -> 0 ->> 'slug' = 'aSpiceRun00000001', 'featured by rank';
  assert jsonb_array_length(s -> 'kids') = 12, 'a shelf holds 12';
  assert public.t_slugs(jsonb_build_object('items', s -> 'manga')) = array['bMoonManga0000002'], 'manga shelf';
  assert jsonb_array_length(s -> 'webtoon') = 4, 'webtoon shelf';
  assert public.t_slugs(jsonb_build_object('items', s -> 'trending')) = array['aSpiceRun00000001', 'zFill000000000005'], 'trending this week';

  s := public.comic_discover_shelves(p_your_lang => 'hi');
  assert public.t_slugs(jsonb_build_object('items', s -> 'lang')) = array['aSpiceRun00000001'], 'in your language';
  s := public.comic_discover_shelves(p_lang => 'en', p_your_lang => 'hi');
  assert not s ? 'lang', 'no "in your language" shelf under a language chip';
  s := public.comic_discover_shelves(p_rating => 'kids', p_kind => 'manga');
  assert not s ? 'kids' and not s ? 'manga' and not s ? 'webtoon', 'chips hide the shelves they would repeat';
  assert jsonb_array_length(s -> 'trending') = 0 and jsonb_array_length(s -> 'featured') = 0, 'a PG-13 manga is not kids-friendly';
  s := public.comic_discover_shelves(p_rating => 'kidz');
  assert jsonb_array_length(s -> 'featured') = 0 and jsonb_array_length(s -> 'new') = 0, 'an unknown chip answers nothing';
end $$;
reset role;

-- ── A hold that lands later takes the comic out (the moderation trigger suspends it; the listing excludes both) ─
update public.projects set is_forced_private = true
 where id = (select project_id from public.comic_publications where slug = 'aSpiceRun00000001');
set role anon;
do $$
begin
  assert not ('aSpiceRun00000001' = any (public.t_slugs(public.comic_discover_list(p_q => 'Spice')))), 'a held comic leaves the listing';
  assert not ('aSpiceRun00000001' = any (public.t_slugs(jsonb_build_object('items', public.comic_discover_shelves() -> 'featured')))),
    'and the featured shelf';
end $$;
reset role;

-- Re-applying with data in place changes nothing.
\ir ../comic_discovery.sql
do $$
begin
  assert (select count(*) from public.comic_featured) = 5, 'featured picks survive a re-apply';
end $$;

\echo COMIC_DISCOVERY_OK
