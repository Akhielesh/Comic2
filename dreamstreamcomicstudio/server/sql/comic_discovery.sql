-- Discover: the public listing behind /discover (redesign DS-R2; owner decision R-D3). ASK-FIRST.
--
-- Apply with the Supabase MCP `apply_migration`, name `comic_discovery`, on the "Comic" project
-- (bdjfmxfmhqhzvgrhbbzm), AFTER comic_publications.sql and comic_hold_unlists_2026_10.sql, and only after the
-- security review of DS-R2 (redesign plan §11.3 M12: before the PR that turns Discover on for admins). Every
-- statement is idempotent (create ... if not exists / create or replace), so re-applying is safe. Run
-- `get_advisors(security)` afterwards. Until it is applied the edge route answers 503 ("taking a moment"), never a
-- wrong list. Tested on a throwaway Postgres by server/sql/tests/comic_discovery.test.sql and pinned statically by
-- tests/config/discoveryListingGuard.test.ts.
--
-- Security model (privacy on Discover, redesign §14 risk 6):
--   * Two new anonymous read RPCs, both SECURITY DEFINER with search_path = public, served through the edge Worker
--     (api-proxy/src/publicDiscover.ts; cached at most 2 x 30 s so a hold leaves every listing within a minute):
--       comic_discover_list    — one page of live PUBLIC publications (keyset cursor, at most 24 rows);
--       comic_discover_shelves — the Discover home shelves, every one built by comic_discover_list.
--   * Every query that reads comic_publications keeps only status = 'live', visibility = 'public' and a project that
--     moderation has not forced private (the forced-private join), in the ranking AND again where the rows are
--     built, so an unlisted, unpublished, suspended or held comic is never listed.
--   * Outputs are an allow-list: slug, title, description, kind, page count, aspect, cover {w480, w1080} (paths
--     under the publication's own pub/<asset_key>/ prefix only), rating, languages, published dates, likes, theme
--     colour, and creator {username, avatarUrl} ONLY when the publication shows its creator (show_creator, the
--     "Show my username" switch, default off; avatarUrl only for an avatar in our storage whose URL holds no id).
--     Never the snapshot, safety data, an asset key or a user id. A search
--     matches a username only where that username is shown, so a hidden byline cannot be found by searching for it.
--   * Inputs fail closed: an unknown sort, rating, kind, length, language or cursor returns an empty page (never an
--     unfiltered one); the limit is clamped to 1..24; a search is cut to 60 characters and LIKE-escaped here.
--   * No reader statistic leaves the database: the ranking scores (reads, the staff rank) stay inside the query, and
--     the keyset cursor is the last item's slug only (comic_publication_stats is owner-only under RLS).
--   * comic_featured (staff picks, seeded by SQL for now) is service-only: RLS on, no policies, no client grants.
--   * Cost: one ranking pass over the public rows plus the last 7 days of comic_publication_stats (index below),
--     then the snapshot is read for the <= 25 rows of the page only (their cover variants). Past ~10k public comics,
--     add per-sort indexes and split the ranking per sort.

-- ── Preconditions (fail the migration rather than ship a function that fails when called) ─────────────────────
do $$
begin
  if to_regclass('public.comic_publications') is null or to_regclass('public.comic_publication_stats') is null then
    raise exception 'apply comic_publications.sql before comic_discovery.sql';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'projects' and column_name = 'is_forced_private') then
    raise exception 'public.projects.is_forced_private is missing (rbac_moderation_plan_entitlements.sql)';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'projects' and column_name = 'likes_count') then
    raise exception 'public.projects.likes_count is missing (social_foundation.sql)';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'profiles' and column_name in ('username', 'avatar_url')) <> 2 then
    raise exception 'public.profiles.username / avatar_url are missing';
  end if;
end $$;

-- ── Featured picks (service-only) ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.comic_featured (
  publication_id uuid primary key references public.comic_publications(id) on delete cascade,
  rank           integer not null default 100 check (rank between 0 and 10000), -- 0 shows first
  starts_at      timestamptz,
  ends_at        timestamptz,
  note           text check (note is null or char_length(note) <= 200),      -- staff only, never listed
  created_at     timestamptz not null default now()
);
alter table public.comic_featured enable row level security;
revoke all on public.comic_featured from anon, authenticated;

-- Trending reads the last 7 days of stats for every public publication.
create index if not exists comic_publication_stats_day_idx on public.comic_publication_stats (day);

-- ── Helper: the comic kind from the frozen share card (not client-callable) ───────────────────────────────────
-- The card's kindLabel is written at publish from the comic's format.kind (server publication/snapshot.ts
-- kindLabelOf); reading it keeps filtering off the (large) snapshot. Unknown labels read as 'comic'.
create or replace function public.comic_discover_kind(p_card jsonb)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_card ->> 'kindLabel'
           when 'Manga' then 'manga'
           when 'Webtoon' then 'webtoon'
           when 'Comic strip' then 'strip'
           when 'Storybook' then 'storybook'
           else 'comic'
         end;
$$;
revoke all on function public.comic_discover_kind(jsonb) from public, anon, authenticated;

-- ── comic_discover_list: one page of public comics ────────────────────────────────────────────────────────────
-- p_sort: 'trending' (reads in the last 7 days, each reader counted once a day), 'new' (first published, newest
-- first), 'most_read' (all-time reads, each reader counted once a day) or 'featured' (staff picks by rank; the
-- shelves use it). The order is (n, slug) descending, where n is the score, which never leaves this function: the
-- keyset is the slug alone (p_after_slug = the previous page's `next`), and the page continues after that comic's
-- CURRENT score. A slug that is no longer listed under this query answers an empty page with no `next` (start again).
-- p_week: 'new' keeps comics first published in the last 7 days, 'trending' keeps comics read this week.
-- Returns { items: [...], next: { slug } | null }.
--
-- An earlier draft of this file (never applied to production) put the score in the cursor through a p_after_n
-- argument; that signature must not survive as a second, ambiguous overload where a test database still has it.
drop function if exists public.comic_discover_list(text, text, text, text, text, text, boolean, integer, bigint, text);
create or replace function public.comic_discover_list(
  p_sort text default 'trending',
  p_q text default null,
  p_rating text default null,
  p_lang text default null,
  p_kind text default null,
  p_length text default null,
  p_week boolean default false,
  p_limit integer default 24,
  p_after_slug text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 24), 1), 24);
  v_week boolean := coalesce(p_week, false);
  v_pattern text;
  v_lang text;
  v_min_pages integer;
  v_max_pages integer;
  v_out jsonb;
begin
  -- Fail closed: anything unknown answers an empty page, never an unfiltered one.
  if p_sort is null or p_sort not in ('trending', 'new', 'most_read', 'featured')
     or (p_rating is not null and p_rating not in ('kids', 'G', 'PG', 'PG-13'))
     or (p_kind is not null and p_kind not in ('comic', 'manga', 'webtoon', 'strip', 'storybook'))
     or (p_length is not null and p_length not in ('short', 'medium', 'long'))
     or (p_lang is not null and (length(p_lang) > 35 or p_lang !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$'))
     or (p_after_slug is not null and p_after_slug !~ '^[A-Za-z0-9]{17}$') then
    return jsonb_build_object('items', '[]'::jsonb, 'next', null);
  end if;
  v_lang := lower(p_lang);
  v_min_pages := case p_length when 'short' then 1 when 'medium' then 9 when 'long' then 25 end;
  v_max_pages := case p_length when 'short' then 8 when 'medium' then 24 when 'long' then 500 end;
  -- The search: at most 60 characters, LIKE wildcards escaped (a '%' or '_' searches for itself).
  v_pattern := nullif(btrim(left(coalesce(p_q, ''), 60)), '');
  if v_pattern is not null then
    v_pattern := '%' || replace(replace(replace(v_pattern, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  -- base: every comic this query lists, with its score n (internal; never returned).
  with base as materialized (
    select c.id, c.slug,
           case p_sort
             when 'new' then (extract(epoch from coalesce(c.first_published_at, c.published_at, c.updated_at)) * 1000000)::bigint
             when 'most_read' then greatest(coalesce(c.views_count, 0), 0)
             when 'featured' then (10000 - f.rank)::bigint
             else coalesce(t.score, 0)
           end as n
      from public.comic_publications c
      join public.projects p on p.id = c.project_id
      left join public.profiles pr on pr.id = c.user_id
      left join (select s.publication_id, sum(s.uniques)::bigint as score
                   from public.comic_publication_stats s
                  where s.day >= current_date - 6
                  group by s.publication_id) t on t.publication_id = c.id
      left join public.comic_featured f
             on f.publication_id = c.id
            and (f.starts_at is null or f.starts_at <= now())
            and (f.ends_at is null or f.ends_at > now())
     where c.status = 'live'
       and c.visibility = 'public'
       and coalesce(p.is_forced_private, false) = false
       and (p_sort <> 'featured' or f.publication_id is not null)
       and (v_pattern is null
            or c.card ->> 'title' ilike v_pattern escape '\'
            or c.card ->> 'description' ilike v_pattern escape '\'
            or exists (select 1
                         from jsonb_each(case when jsonb_typeof(c.card -> 'i18n') = 'object' then c.card -> 'i18n' else '{}'::jsonb end) e
                        where e.value ->> 'title' ilike v_pattern escape '\')
            or (c.show_creator and pr.username ilike v_pattern escape '\'))
       and (p_rating is null
            or (p_rating = 'kids' and c.safety ->> 'rating' in ('G', 'PG'))
            or c.safety ->> 'rating' = p_rating)
       and (v_lang is null or exists (select 1 from unnest(c.languages) l where lower(l) = v_lang))
       and (p_kind is null or public.comic_discover_kind(c.card) = p_kind)
       and (v_min_pages is null
            or (jsonb_typeof(c.card -> 'pageCount') = 'number'
                and (c.card ->> 'pageCount')::numeric between v_min_pages and v_max_pages))
       and (not v_week
            or (p_sort = 'new' and coalesce(c.first_published_at, c.published_at, c.updated_at) >= now() - interval '7 days')
            or (p_sort = 'trending' and coalesce(t.score, 0) > 0)
            or p_sort not in ('new', 'trending'))
  ),
  -- ranked: the page (plus one row, only to know there is a next page) after the cursor's comic, by its current score.
  -- When that slug is not in base (unpublished, held, filtered out) the comparison is null and the page is empty.
  ranked as materialized (
    select x.id, x.slug, x.n
      from base x
     where p_after_slug is null or (x.n, x.slug) < ((select b.n from base b where b.slug = p_after_slug), p_after_slug)
     order by x.n desc, x.slug desc
     limit v_limit + 1
  )
  select jsonb_build_object(
           'items', coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
              'slug', c.slug,
              'title', coalesce((select c.card -> 'i18n' -> l ->> 'title' from unnest(c.languages) l where lower(l) = v_lang limit 1),
                                c.card ->> 'title'),
              'description', coalesce((select c.card -> 'i18n' -> l ->> 'description' from unnest(c.languages) l where lower(l) = v_lang limit 1),
                                      c.card ->> 'description', ''),
              'kind', public.comic_discover_kind(c.card),
              'pageCount', case when jsonb_typeof(c.card -> 'pageCount') = 'number' then c.card -> 'pageCount' end,
              'aspect', c.card ->> 'aspect',
              'cover', case when art.w480 is not null and art.w1080 is not null
                            then jsonb_build_object('w480', art.w480, 'w1080', art.w1080) end,
              'rating', case when c.safety ->> 'rating' in ('G', 'PG', 'PG-13') then c.safety ->> 'rating' end,
              'languages', to_jsonb(c.languages),
              'publishedAt', (extract(epoch from coalesce(c.published_at, c.updated_at)) * 1000)::bigint,
              'firstPublishedAt', (extract(epoch from coalesce(c.first_published_at, c.published_at, c.updated_at)) * 1000)::bigint,
              'likes', greatest(coalesce(p.likes_count, 0), 0),
              'themeColor', case when c.card ->> 'themeColor' ~ '^#[0-9a-fA-F]{6}$' then c.card ->> 'themeColor' end,
              -- The creator rule: a byline only when this publication shows its creator.
              'creator', case when c.show_creator and pr.username ~ '^[A-Za-z0-9_.-]{2,40}$'
                              then jsonb_build_object(
                                     'username', pr.username,
                                     'avatarUrl', case when length(pr.avatar_url) <= 500
                                                        and pr.avatar_url ~ '^https://[a-z0-9]{10,40}\.supabase\.co/storage/v1/object/public/[a-z0-9-]{3,63}/[A-Za-z0-9._/-]+$'
                                                        and pr.avatar_url !~ '\.\.'
                                                        -- never a user id: uploaded avatars live under <uid>/, so they
                                                        -- wait for an opaque copy (docs/features/discovery.md)
                                                        and pr.avatar_url !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                                                       then pr.avatar_url end)
                         end
            )) order by r.n desc, r.slug desc) filter (where r.rn <= v_limit), '[]'::jsonb),
           'next', case when max(r.rn) > v_limit
                        then (array_agg(jsonb_build_object('slug', r.slug)) filter (where r.rn = v_limit))[1] end)
    into v_out
    from (select ranked.*, row_number() over (order by ranked.n desc, ranked.slug desc) as rn from ranked) r
    join public.comic_publications c on c.id = r.id
    join public.projects p on p.id = c.project_id
    left join public.profiles pr on pr.id = c.user_id
    -- The cover: the published cover's copies (else page 1's), only under this publication's own pub/<key>/ prefix.
    left join lateral (
      select case when coalesce(v.w480, v.w1080, v.src) ~ ('^pub/' || c.asset_key || '/[A-Za-z0-9._-]{1,120}$')
                  then coalesce(v.w480, v.w1080, v.src) end as w480,
             case when coalesce(v.w1080, v.src, v.w480) ~ ('^pub/' || c.asset_key || '/[A-Za-z0-9._-]{1,120}$')
                  then coalesce(v.w1080, v.src, v.w480) end as w1080
        from (select a ->> 'path' as src,
                     (select e ->> 'path' from jsonb_array_elements(case when jsonb_typeof(a -> 'variants') = 'array' then a -> 'variants' else '[]'::jsonb end) e
                       where e ->> 'w' = '480' limit 1) as w480,
                     (select e ->> 'path' from jsonb_array_elements(case when jsonb_typeof(a -> 'variants') = 'array' then a -> 'variants' else '[]'::jsonb end) e
                       where e ->> 'w' = '1080' limit 1) as w1080
                from (select coalesce(c.snapshot #> '{cover,render,asset}', c.snapshot #> '{pages,0,render,asset}') as a) asset) v
    ) art on true
   where c.status = 'live'
     and c.visibility = 'public'
     and coalesce(p.is_forced_private, false) = false;

  return coalesce(v_out, jsonb_build_object('items', '[]'::jsonb, 'next', null));
end;
$$;

-- ── comic_discover_shelves: the Discover home ─────────────────────────────────────────────────────────────────
-- p_rating / p_lang / p_kind are the home's filter chips (they narrow every shelf); p_your_lang is the reader's
-- language, for "In your language" (only when no language chip is set). Each shelf has at most 12 comics; the edge
-- drops empty shelves and the thin ones (In your language, Webtoons, Manga need 4).
create or replace function public.comic_discover_shelves(
  p_rating text default null,
  p_lang text default null,
  p_kind text default null,
  p_your_lang text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return jsonb_strip_nulls(jsonb_build_object(
    'featured', public.comic_discover_list(p_sort => 'featured', p_rating => p_rating, p_lang => p_lang, p_kind => p_kind, p_limit => 12) -> 'items',
    'trending', public.comic_discover_list(p_sort => 'trending', p_rating => p_rating, p_lang => p_lang, p_kind => p_kind, p_week => true, p_limit => 12) -> 'items',
    'new', public.comic_discover_list(p_sort => 'new', p_rating => p_rating, p_lang => p_lang, p_kind => p_kind, p_week => true, p_limit => 12) -> 'items',
    'kids', case when p_rating is null
                 then public.comic_discover_list(p_sort => 'most_read', p_rating => 'kids', p_lang => p_lang, p_kind => p_kind, p_limit => 12) -> 'items' end,
    'lang', case when p_lang is null and p_your_lang is not null
                 then public.comic_discover_list(p_sort => 'most_read', p_rating => p_rating, p_lang => p_your_lang, p_kind => p_kind, p_limit => 12) -> 'items' end,
    'webtoon', case when p_kind is null
                    then public.comic_discover_list(p_sort => 'most_read', p_rating => p_rating, p_lang => p_lang, p_kind => 'webtoon', p_limit => 12) -> 'items' end,
    'manga', case when p_kind is null
                  then public.comic_discover_list(p_sort => 'most_read', p_rating => p_rating, p_lang => p_lang, p_kind => 'manga', p_limit => 12) -> 'items' end
  ));
end;
$$;

revoke all on function public.comic_discover_list(text, text, text, text, text, text, boolean, integer, text) from public;
revoke all on function public.comic_discover_shelves(text, text, text, text) from public;
grant execute on function public.comic_discover_list(text, text, text, text, text, text, boolean, integer, text) to anon, authenticated, service_role;
grant execute on function public.comic_discover_shelves(text, text, text, text) to anon, authenticated, service_role;

-- ── Post-apply assertions (fail the migration rather than ship a hole) ────────────────────────────────────────
do $$
begin
  if has_table_privilege('anon', 'public.comic_featured', 'select')
     or has_table_privilege('authenticated', 'public.comic_featured', 'select')
     or has_table_privilege('anon', 'public.comic_featured', 'insert')
     or has_table_privilege('authenticated', 'public.comic_featured', 'insert')
     or has_table_privilege('authenticated', 'public.comic_featured', 'update')
     or has_table_privilege('authenticated', 'public.comic_featured', 'delete') then
    raise exception 'comic_featured must be service-only';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.comic_featured'::regclass) then
    raise exception 'comic_featured must have RLS on';
  end if;
  if has_function_privilege('anon', 'public.comic_discover_kind(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.comic_discover_kind(jsonb)', 'execute') then
    raise exception 'comic_discover_kind is internal';
  end if;
  if exists (select 1 from pg_proc
              where pronamespace = 'public'::regnamespace
                and proname in ('comic_discover_list', 'comic_discover_shelves')
                and (not prosecdef or not coalesce(proconfig @> array['search_path=public'], false))) then
    raise exception 'the Discover RPCs must be SECURITY DEFINER with search_path = public';
  end if;
end $$;
