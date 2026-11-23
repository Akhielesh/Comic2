-- Account Library positions are opt-in. Apply after comic_publications.sql and the projects content_rating guard.
-- Only the authenticated RPC is exposed. Neither preferences nor positions contain a share slug, URL or private title.
begin;

create schema if not exists comic_reader_private;
revoke all on schema comic_reader_private from public, anon, authenticated, service_role;
grant usage on schema comic_reader_private to authenticated;

create table if not exists comic_reader_private.preferences (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null,
  epoch uuid not null default gen_random_uuid(),
  last_revision integer not null default 0 check (last_revision >= 0)
);
create table if not exists comic_reader_private.positions (
  owner_id uuid not null references comic_reader_private.preferences(owner_id) on delete cascade,
  publication_id uuid not null references public.comic_publications(id) on delete cascade,
  page integer not null check (page between 1 and 500),
  revision integer not null check (revision > 0),
  updated_at timestamptz not null,
  primary key (owner_id, publication_id)
);
create index if not exists comic_reader_positions_publication on comic_reader_private.positions(publication_id);
create index if not exists comic_reader_positions_expiry on comic_reader_private.positions(updated_at);
alter table comic_reader_private.preferences enable row level security;
alter table comic_reader_private.positions enable row level security;
revoke all on comic_reader_private.preferences, comic_reader_private.positions from public, anon, authenticated, service_role;

-- The public reader numbers the frozen, drawn pages consecutively. The current public mirror must agree with the edition.
create or replace view comic_reader_private.listed as
select c.id, c.user_id as author_id, c.slug,
       case when jsonb_typeof(c.snapshot -> 'pages') = 'array' then jsonb_array_length(c.snapshot -> 'pages') end as page_count
  from public.comic_publications c
  join public.projects p on p.id = c.project_id and p.user_id = c.user_id
 where c.status = 'live' and c.visibility = 'public' and c.slug ~ '^[A-Za-z0-9]{17}$'
   and p.is_public is true and not coalesce(p.is_forced_private, false)
   and p.state -> 'studioVersion' = '4'::jsonb and p.state ->> 'shareSlug' = c.slug
   and p.content_rating in ('G','PG','PG-13')
   and (c.safety ->> 'rating' is null or c.safety ->> 'rating' in ('G','PG','PG-13'));
revoke all on comic_reader_private.listed from public, anon, authenticated, service_role;

-- Purge on withdrawal or rotation so relisting the very same database row cannot revive old reading history.
create or replace function comic_reader_private.forget_publication() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'projects' then
    delete from comic_reader_private.positions r using public.comic_publications c
     where c.project_id = old.id and r.publication_id = c.id;
  else
    delete from comic_reader_private.positions where publication_id = old.id;
  end if;
  return null;
end;
$$;
revoke all on function comic_reader_private.forget_publication() from public, anon, authenticated, service_role;
drop trigger if exists comic_reader_forget_publication on public.comic_publications;
create trigger comic_reader_forget_publication after update of slug, asset_key, status, visibility, safety, user_id, project_id on public.comic_publications
  for each row when (old.slug is distinct from new.slug or old.asset_key is distinct from new.asset_key
    or old.status is distinct from new.status or old.visibility is distinct from new.visibility
    or old.user_id is distinct from new.user_id or old.project_id is distinct from new.project_id
    or (new.safety ->> 'rating') not in ('G','PG','PG-13')) execute function comic_reader_private.forget_publication();
drop trigger if exists comic_reader_forget_project on public.projects;
create trigger comic_reader_forget_project after update of is_public, is_forced_private, state, user_id, content_rating on public.projects
  for each row when (old.user_id is distinct from new.user_id or old.is_public is distinct from new.is_public
    or old.is_forced_private is distinct from new.is_forced_private or (old.content_rating is distinct from new.content_rating and (new.content_rating is null or new.content_rating not in ('G','PG','PG-13')))
    or (old.state ->> 'shareSlug') is distinct from (new.state ->> 'shareSlug')
    or (old.state -> 'studioVersion') is distinct from (new.state -> 'studioVersion')) execute function comic_reader_private.forget_publication();

-- Used by the scheduled retention job; index-driven batches do not block a member updating a row.
create or replace function comic_reader_private.expire_positions() returns void
language sql set search_path = '' as $$
  delete from comic_reader_private.positions r using (
    select owner_id, publication_id from comic_reader_private.positions
     where updated_at <= statement_timestamp() - interval '30 days'
     order by updated_at limit 5000 for update skip locked
  ) expired where r.owner_id = expired.owner_id and r.publication_id = expired.publication_id;
$$;
revoke all on function comic_reader_private.expire_positions() from public, anon, authenticated, service_role;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('comic-reader-expiry', '*/10 * * * *', 'select comic_reader_private.expire_positions()');
  end if;
end $$;

create or replace function comic_reader_private.library(p_owner uuid, p_action text, p_epoch uuid, p_slug text,
   p_page integer, p_last_page integer, p_revision integer) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  pref comic_reader_private.preferences%rowtype;
  position_row comic_reader_private.positions%rowtype;
  pub_id uuid;
  published_pages integer;
  next_revision integer;
  reads jsonb = '[]'::jsonb;
  cutoff timestamptz = statement_timestamp() - interval '30 days';
begin
  if p_owner is null or p_owner is distinct from auth.uid() then
    raise exception 'Sign in to your own Library.' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('get','enable','clear','disable','save') then
    raise exception 'Unknown Library action.' using errcode = '22023';
  end if;
  -- Serialize only this member's mutations, including the first opt-in before a preference row exists.
  if p_action = 'get' then perform pg_advisory_xact_lock_shared(hashtextextended(p_owner::text, 9214723));
  else perform pg_advisory_xact_lock(hashtextextended(p_owner::text, 9214723)); end if;
  select * into pref from comic_reader_private.preferences where owner_id = p_owner;
  if p_action = 'enable' and p_epoch is not distinct from pref.epoch then
    if pref.owner_id is null then
      insert into comic_reader_private.preferences(owner_id, enabled) values(p_owner, true) returning * into pref;
    elsif not pref.enabled then
      update comic_reader_private.preferences set enabled = true, epoch = gen_random_uuid(), last_revision = 0
       where owner_id = p_owner returning * into pref;
    end if;
  elsif p_action in ('clear','disable') and p_epoch = pref.epoch then
    delete from comic_reader_private.positions where owner_id = p_owner;
    update comic_reader_private.preferences set enabled = enabled and p_action <> 'disable', epoch = gen_random_uuid(), last_revision = 0
     where owner_id = p_owner returning * into pref;
  elsif p_action = 'save' then
    if not coalesce(pref.enabled and p_epoch = pref.epoch and p_slug ~ '^[A-Za-z0-9]{17}$'
         and p_page between 1 and p_last_page and p_last_page between 1 and 500 and p_revision >= 0, false) then
      return jsonb_build_object('saved', false);
    end if;
    select l.id, l.page_count into pub_id, published_pages from comic_reader_private.listed l
     where l.slug = p_slug and l.author_id <> p_owner for share;
    if pub_id is null or published_pages is distinct from p_last_page then return jsonb_build_object('saved', false); end if;
    delete from comic_reader_private.positions where owner_id = p_owner and updated_at <= cutoff;
    select * into position_row from comic_reader_private.positions where owner_id = p_owner and publication_id = pub_id;
    if p_revision <> coalesce(position_row.revision, 0) then return jsonb_build_object('saved', false); end if;
    if position_row.page = p_page then return jsonb_build_object('saved', true, 'revision', position_row.revision); end if;
    -- A per-member monotonic revision cannot repeat when an expired or evicted position is created again.
    update comic_reader_private.preferences set last_revision = last_revision + 1
     where owner_id = p_owner returning last_revision into next_revision;
    insert into comic_reader_private.positions(owner_id,publication_id,page,revision,updated_at)
      values (p_owner,pub_id,p_page,next_revision,clock_timestamp())
      on conflict (owner_id,publication_id) do update set page = excluded.page, revision = excluded.revision, updated_at = excluded.updated_at;
    delete from comic_reader_private.positions r using (
      select publication_id from comic_reader_private.positions where owner_id = p_owner order by updated_at desc, revision desc offset 24
    ) excess where r.owner_id = p_owner and r.publication_id = excess.publication_id;
    return jsonb_build_object('saved', true, 'revision', next_revision);
  end if;
  if pref.enabled then
    select coalesce(jsonb_agg(jsonb_build_object('slug', l.slug,'page',least(r.page,l.page_count),'lastPage',l.page_count,
                  'at',floor(extract(epoch from r.updated_at)*1000)::bigint,'revision',r.revision)
                  order by r.updated_at desc, r.revision desc), '[]'::jsonb) into reads
      from comic_reader_private.positions r join comic_reader_private.listed l on l.id = r.publication_id
     where r.owner_id = p_owner and l.author_id <> p_owner and l.page_count between 1 and 500 and r.updated_at > cutoff;
  end if;
  return jsonb_build_object('enabled',coalesce(pref.enabled,false),'epoch',pref.epoch,'reads',reads);
end;
$$;
revoke all on function comic_reader_private.library(uuid,text,uuid,text,integer,integer,integer) from public, anon, authenticated, service_role;
grant execute on function comic_reader_private.library(uuid,text,uuid,text,integer,integer,integer) to authenticated;

create or replace function public.comic_reader_library(p_owner uuid, p_action text default 'get', p_epoch uuid default null,
    p_slug text default null, p_page integer default null, p_last_page integer default null, p_revision integer default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select comic_reader_private.library(p_owner,p_action,p_epoch,p_slug,p_page,p_last_page,p_revision);
$$;
revoke all on function public.comic_reader_library(uuid,text,uuid,text,integer,integer,integer) from public, anon, authenticated, service_role;
grant execute on function public.comic_reader_library(uuid,text,uuid,text,integer,integer,integer) to authenticated;
commit;
