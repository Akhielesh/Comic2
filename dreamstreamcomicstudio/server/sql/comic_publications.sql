-- Comic Studio v4/v5 publications: frozen, allow-listed share snapshots behind /c/<slug>
-- (P1-PUBLISH; sharing.md §2, contract §9.3 / §12.7 / §14).
--
-- Apply with the Supabase MCP `apply_migration`, name `comic_studio_v4_publications`, on the
-- "Comic" project (bdjfmxfmhqhzvgrhbbzm), AFTER comic_security_guard_2026_10.sql. Every statement
-- is idempotent (create ... if not exists / create or replace / drop ... if exists), so
-- re-applying is safe. Run `get_advisors(security)` afterwards.
--
-- Security model (owner addendum: "share links are READ ONLY ... very strong security"):
--   * comic_publications / _stats / _viewers / _config: RLS on; the owner may READ their own
--     publication + stats; nobody but the service role (the server) writes; anon has no
--     table access at all.
--   * The ONLY anonymous surface is four SECURITY DEFINER RPCs that return allow-listed
--     fields of LIVE publications. Unknown, revoked, unpublished and suspended slugs run the
--     same single query and return NULL (no oracle). Malformed slugs never match.
--   * Slugs are 17 base62 chars (≈101 bits, CSPRNG, minted by the server), asset keys 22
--     (≈131 bits). Neither is derived from a project or user id.
--   * View tracking needs an HMAC proof made with a secret only the edge Worker and this
--     database know (`comic_publication_config.view_salt` = Worker secret SHARE_VIEW_SALT), so
--     the public anon key alone cannot inflate views. Without the secret, tracking is off
--     (fail closed); reading is unaffected.
--   * projects.is_public stays server-written for v4 (P0-SEC guard). This file adds:
--       - projects_suspend_publication: moderation (is_forced_private → true) suspends the
--         live publication at once (the RPCs also refuse forced-private projects);
--       - projects_guard_publication_state: a client re-save of a v4 listing row can never
--         change the server-mirrored state.shareSlug / state.publicCover (the gallery reads
--         them from public rows).
--   * Content rating (P2-PUBLIC-PAYLOAD): the publish gate's rating (G / PG / PG-13) is frozen in
--     safety.rating at publish time. comic_share_card and comic_public_payload expose it as
--     `rating` only when it is one of those three values; older rows simply have no `rating` key
--     (readers treat that as unknown, never as kids-friendly). Re-applying this file only replaces
--     the two function bodies; their grants, SECURITY DEFINER and search_path stay as they are.
--   * pub/ objects are not registered in image_assets; publication code owns their lifecycle.
--     comic_publication_orphan_keys() lists pub/<key>/ prefixes with no live/suspended row
--     (older than a day, so an in-flight publish is never swept) for the server's sweep
--     (storage.protect_delete() forbids SQL deletes, so the server removes them via the API).

create extension if not exists pgcrypto with schema extensions;

-- ── Tables ──────────────────────────────────────────────────────────────────────────────────

create table if not exists public.comic_publications (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null unique references public.projects(id) on delete cascade,
  user_id            uuid not null references auth.users(id) on delete cascade,
  status             text not null default 'live' check (status in ('live', 'unpublished', 'suspended')),
  visibility         text not null default 'unlisted' check (visibility in ('unlisted', 'public')),
  slug               text unique,                        -- null unless live/suspended
  asset_key          text,                               -- storage prefix pub/<asset_key>/ (rotates with the slug)
  languages          text[] not null default '{}',       -- published editions; [0] = default/source
  default_lang       text,
  start_page         integer check (start_page is null or start_page between 1 and 500),
  allow_download     boolean not null default true,      -- addendum: readers may download by default
  allow_embed        boolean not null default true,
  show_creator       boolean not null default false,     -- privacy default (kids content)
  snapshot           jsonb,                              -- allow-listed ComicDoc (contract §9.3)
  card               jsonb not null default '{}'::jsonb, -- ShareCard: what link previews need
  published_rev      integer not null default 0,
  safety             jsonb not null default '{}'::jsonb, -- publish-gate summary + content fingerprint
  views_count        bigint not null default 0,
  first_published_at timestamptz,
  published_at       timestamptz,
  unpublished_at     timestamptz,
  updated_at         timestamptz not null default now()
);

-- Shape checks (added separately so an earlier partial apply still gets them).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'comic_publications_slug_shape') then
    alter table public.comic_publications
      add constraint comic_publications_slug_shape check (slug is null or slug ~ '^[A-Za-z0-9]{17}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'comic_publications_key_shape') then
    alter table public.comic_publications
      add constraint comic_publications_key_shape check (asset_key is null or asset_key ~ '^[A-Za-z0-9]{22}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'comic_publications_live_complete') then
    alter table public.comic_publications
      add constraint comic_publications_live_complete
      check (status <> 'live' or (slug is not null and asset_key is not null and snapshot is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'comic_publications_languages_cap') then
    alter table public.comic_publications
      add constraint comic_publications_languages_cap check (cardinality(languages) <= 12);
  end if;
end $$;

create unique index if not exists comic_publications_asset_key_idx on public.comic_publications (asset_key) where asset_key is not null;
create index if not exists comic_publications_user_idx on public.comic_publications (user_id, updated_at desc);
create index if not exists comic_publications_public_idx on public.comic_publications (published_at desc)
  where status = 'live' and visibility = 'public';

alter table public.comic_publications enable row level security;
drop policy if exists comic_publications_select_own on public.comic_publications;
create policy comic_publications_select_own on public.comic_publications
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.comic_publications from anon;
revoke insert, update, delete, truncate, references, trigger on public.comic_publications from authenticated;

-- Daily share analytics (no PII: the viewer is a salted daily hash made at the edge; the
-- 2-day viewer window exists only to count uniques).
create table if not exists public.comic_publication_stats (
  publication_id uuid not null references public.comic_publications(id) on delete cascade,
  day            date not null,
  views          integer not null default 0,
  uniques        integer not null default 0,
  completes      integer not null default 0,
  shares         integer not null default 0,
  by_channel     jsonb not null default '{}'::jsonb,
  by_lang        jsonb not null default '{}'::jsonb,
  primary key (publication_id, day)
);
create table if not exists public.comic_publication_viewers (
  publication_id uuid not null references public.comic_publications(id) on delete cascade,
  day            date not null,
  viewer_hash    text not null check (viewer_hash ~ '^[0-9a-f]{32}$'),
  primary key (publication_id, day, viewer_hash)
);
alter table public.comic_publication_stats enable row level security;
alter table public.comic_publication_viewers enable row level security;
drop policy if exists comic_publication_stats_own on public.comic_publication_stats;
create policy comic_publication_stats_own on public.comic_publication_stats for select to authenticated
  using (exists (select 1 from public.comic_publications p where p.id = publication_id and p.user_id = (select auth.uid())));
revoke all on public.comic_publication_stats, public.comic_publication_viewers from anon;
revoke insert, update, delete, truncate, references, trigger on public.comic_publication_stats from authenticated;
revoke all on public.comic_publication_viewers from authenticated;

-- Server-only configuration (the view-tracking HMAC secret). No policies: only SECURITY
-- DEFINER functions and the service role can read it.
create table if not exists public.comic_publication_config (
  key   text primary key,
  value text not null
);
alter table public.comic_publication_config enable row level security;
revoke all on public.comic_publication_config from anon, authenticated;

-- ── Anonymous read RPCs (the ONLY anon surface) ─────────────────────────────────────────────

create or replace function public.comic_share_card(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'slug', c.slug, 'visibility', c.visibility, 'languages', to_jsonb(c.languages),
           'defaultLang', c.default_lang, 'startPage', c.start_page,
           'allowDownload', c.allow_download, 'allowEmbed', c.allow_embed,
           'assetKey', c.asset_key, 'card', c.card,
           'publishedAt', (extract(epoch from c.published_at) * 1000)::bigint,
           'updatedAt', (extract(epoch from c.updated_at) * 1000)::bigint)
         -- The frozen publish-time rating, only when it is a known value (older rows: no key).
         || case when c.safety ->> 'rating' in ('G', 'PG', 'PG-13')
                 then jsonb_build_object('rating', c.safety ->> 'rating')
                 else '{}'::jsonb end
    from public.comic_publications c
    join public.projects p on p.id = c.project_id
   where p_slug ~ '^[A-Za-z0-9]{17}$'
     and c.slug = p_slug
     and c.status = 'live'
     and coalesce(p.is_forced_private, false) = false;
$$;

create or replace function public.comic_public_payload(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'publication', jsonb_build_object(
              'slug', c.slug, 'visibility', c.visibility, 'languages', to_jsonb(c.languages),
              'defaultLang', c.default_lang, 'startPage', c.start_page,
              'allowDownload', c.allow_download, 'allowEmbed', c.allow_embed,
              'publishedAt', (extract(epoch from c.published_at) * 1000)::bigint,
              'updatedAt', (extract(epoch from c.updated_at) * 1000)::bigint,
              'assetKey', c.asset_key, 'card', c.card)
            -- The frozen publish-time rating, only when it is a known value (older rows: no key).
            || case when c.safety ->> 'rating' in ('G', 'PG', 'PG-13')
                    then jsonb_build_object('rating', c.safety ->> 'rating')
                    else '{}'::jsonb end,
           'doc', c.snapshot)
    from public.comic_publications c
    join public.projects p on p.id = c.project_id
   where p_slug ~ '^[A-Za-z0-9]{17}$'
     and c.slug = p_slug
     and c.status = 'live'
     and coalesce(p.is_forced_private, false) = false;
$$;

-- Legacy ?view=read&id=<uuid> links: ONLY PUBLIC publications (an id never maps to an unlisted slug).
create or replace function public.comic_share_card_by_project(p_project uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.comic_share_card(c.slug)
    from public.comic_publications c
   where c.project_id = p_project
     and c.status = 'live'
     and c.visibility = 'public';
$$;

-- View / complete / share tracking. p_proof = hex(hmac_sha256(view_salt, slug:viewer:day)),
-- computed by the edge Worker; anything else (or a missing salt) is a silent no-op.
create or replace function public.comic_publication_track(
  p_slug text, p_event text, p_viewer text, p_channel text, p_lang text, p_proof text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_project uuid;
  v_new boolean := false;
  v_rows integer := 0;
  v_salt text;
  v_ok boolean := false;
  v_ch text := left(coalesce(nullif(p_channel, ''), 'direct'), 24);
  v_lang text := left(coalesce(nullif(p_lang, ''), 'src'), 12);
begin
  if p_event is null or p_event not in ('view', 'complete', 'share') then return; end if;
  if p_viewer is null or p_viewer !~ '^[0-9a-f]{32}$' then return; end if;
  if p_slug is null or p_slug !~ '^[A-Za-z0-9]{17}$' then return; end if;
  if p_proof is null or p_proof !~ '^[0-9a-f]{64}$' then return; end if;
  if v_ch !~ '^[a-z]{1,24}$' then v_ch := 'other'; end if;
  if v_lang !~ '^[A-Za-z0-9-]{2,12}$' then v_lang := 'src'; end if;

  select value into v_salt from public.comic_publication_config where key = 'view_salt';
  if v_salt is null or length(v_salt) < 32 then return; end if;
  -- Today or yesterday (UTC) so a request straddling midnight still counts.
  v_ok := p_proof = encode(extensions.hmac(p_slug || ':' || p_viewer || ':' || to_char(current_date, 'YYYY-MM-DD'), v_salt, 'sha256'), 'hex')
       or p_proof = encode(extensions.hmac(p_slug || ':' || p_viewer || ':' || to_char(current_date - 1, 'YYYY-MM-DD'), v_salt, 'sha256'), 'hex');
  if not v_ok then return; end if;

  select c.id, c.project_id into v_id, v_project
    from public.comic_publications c
    join public.projects p on p.id = c.project_id
   where c.slug = p_slug and c.status = 'live' and coalesce(p.is_forced_private, false) = false;
  if v_id is null then return; end if;

  if p_event = 'view' then
    insert into public.comic_publication_viewers (publication_id, day, viewer_hash)
    values (v_id, current_date, p_viewer)
    on conflict do nothing;
    get diagnostics v_rows = row_count;
    v_new := v_rows > 0;
  end if;

  insert into public.comic_publication_stats as s (publication_id, day, views, uniques, completes, shares, by_channel, by_lang)
  values (v_id, current_date, (p_event = 'view')::int, v_new::int, (p_event = 'complete')::int, (p_event = 'share')::int,
          case when p_event = 'view' then jsonb_build_object(v_ch, 1) else '{}'::jsonb end,
          case when p_event = 'view' then jsonb_build_object(v_lang, 1) else '{}'::jsonb end)
  on conflict (publication_id, day) do update set
    views = s.views + excluded.views,
    uniques = s.uniques + excluded.uniques,
    completes = s.completes + excluded.completes,
    shares = s.shares + excluded.shares,
    by_channel = case when p_event = 'view'
                   then s.by_channel || jsonb_build_object(v_ch, coalesce((s.by_channel ->> v_ch)::int, 0) + 1)
                   else s.by_channel end,
    by_lang = case when p_event = 'view'
                then s.by_lang || jsonb_build_object(v_lang, coalesce((s.by_lang ->> v_lang)::int, 0) + 1)
                else s.by_lang end;

  if p_event = 'view' and v_new then
    update public.comic_publications set views_count = views_count + 1 where id = v_id;
    -- Gallery compatibility (projects.views_count); service-side write, guard-exempt column.
    update public.projects set views_count = coalesce(views_count, 0) + 1 where id = v_project;
  end if;

  if random() < 0.01 then
    delete from public.comic_publication_viewers where day < current_date - 1;
  end if;
end;
$$;

-- The 5-argument signature from earlier drafts (no proof) must not survive as an open door.
drop function if exists public.comic_publication_track(text, text, text, text, text);

revoke all on function public.comic_share_card(text) from public;
revoke all on function public.comic_public_payload(text) from public;
revoke all on function public.comic_share_card_by_project(uuid) from public;
revoke all on function public.comic_publication_track(text, text, text, text, text, text) from public;
grant execute on function public.comic_share_card(text) to anon, authenticated, service_role;
grant execute on function public.comic_public_payload(text) to anon, authenticated, service_role;
grant execute on function public.comic_share_card_by_project(uuid) to anon, authenticated, service_role;
grant execute on function public.comic_publication_track(text, text, text, text, text, text) to anon, authenticated, service_role;

-- ── Guards on projects ──────────────────────────────────────────────────────────────────────

-- Moderation suspends the live publication the moment is_forced_private turns on.
create or replace function public.projects_suspend_publication()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.is_forced_private, false) and not coalesce(old.is_forced_private, false) then
    update public.comic_publications
       set status = 'suspended', updated_at = now()
     where project_id = new.id and status = 'live';
  end if;
  return null;
end;
$$;
revoke all on function public.projects_suspend_publication() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'projects' and column_name = 'is_forced_private') then
    execute 'drop trigger if exists projects_suspend_publication on public.projects';
    execute 'create trigger projects_suspend_publication after update of is_forced_private on public.projects '
         || 'for each row execute function public.projects_suspend_publication()';
  end if;
end $$;

-- A client re-save of a v4 listing row keeps the server-mirrored share keys (the gallery
-- reads state.shareSlug / state.publicCover of public rows). While a v4 row is PUBLIC, the
-- gallery shows only what passed the publish gate: the server wrote the published title
-- (name), blurb (state.overview) and opaque cover (state.coverImageId), and a direct client
-- update can't swap them for unreviewed text or another image (anyone can read public rows).
create or replace function public.projects_guard_publication_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb := coalesce(old.state, '{}'::jsonb);
begin
  if coalesce(auth.role(), 'service_role') = 'service_role' then return new; end if;
  if new.state is not distinct from old.state and new.name is not distinct from old.name then return new; end if;
  if not exists (select 1 from public.comic_docs d where d.project_id = old.id) then return new; end if;
  new.state := (coalesce(new.state, '{}'::jsonb) - 'shareSlug' - 'publicCover')
    || jsonb_strip_nulls(jsonb_build_object('shareSlug', v_old -> 'shareSlug', 'publicCover', v_old -> 'publicCover'));
  if coalesce(old.is_public, false) then
    new.name := old.name;
    new.state := (new.state - 'overview' - 'coverImageId')
      || jsonb_strip_nulls(jsonb_build_object('overview', v_old -> 'overview', 'coverImageId', v_old -> 'coverImageId'));
  end if;
  return new;
end;
$$;
revoke all on function public.projects_guard_publication_state() from public, anon, authenticated;

drop trigger if exists projects_guard_publication_state on public.projects;
create trigger projects_guard_publication_state
  before update on public.projects
  for each row execute function public.projects_guard_publication_state();

-- ── Orphan pub/ sweep (weekly; the server deletes through the Storage API) ──────────────────

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
   limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;
revoke all on function public.comic_publication_orphan_keys(integer) from public, anon, authenticated;
grant execute on function public.comic_publication_orphan_keys(integer) to service_role;

-- ── Post-apply assertions (fail the migration rather than ship a hole) ──────────────────────
do $$
begin
  if has_table_privilege('anon', 'public.comic_publications', 'select') then
    raise exception 'anon must not read comic_publications directly';
  end if;
  if has_table_privilege('authenticated', 'public.comic_publications', 'insert')
     or has_table_privilege('authenticated', 'public.comic_publications', 'update') then
    raise exception 'clients must not write comic_publications';
  end if;
  if has_table_privilege('anon', 'public.comic_publication_config', 'select')
     or has_table_privilege('authenticated', 'public.comic_publication_config', 'select') then
    raise exception 'comic_publication_config must be server-only';
  end if;
end $$;
