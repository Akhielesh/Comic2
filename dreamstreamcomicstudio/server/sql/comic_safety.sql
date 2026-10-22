-- Comic Studio PG-13 safety (P1-SAFETY; buildplan §7 #2, migration name `comic_safety_pg13`).
--
-- Idempotent: safe to re-run. Service-role writes only: every table has RLS ON, no policies,
-- and all privileges revoked from anon/authenticated. Rows hold categories, decisions, one-way
-- hashes and costs — NEVER the screened text or image.
--
-- Deliberately NOT here (buildplan amendments): no comic_docs.safety_* columns and no
-- projects_guard_publish trigger. The P0-SEC guard (comic_security_guard_2026_10.sql) and the
-- frozen publications (comic_publications.sql) own "who may make a comic public".
--
-- Apply BEFORE the server that writes these tables (harmless earlier). Inspect first:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.project_moderation_actions'::regclass and contype = 'c';

-- ── 1. Decisions (strikes, analytics, cost) ─────────────────────────────────────────────────

create table if not exists public.comic_safety_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  surface text not null,
  layer text not null,
  decision text not null,
  categories text[] not null default '{}',
  effective_rating text,
  assessed text,
  severity smallint not null default 0,
  content_hash text,
  model text,
  cost_usd numeric(10, 6) not null default 0,
  created_at timestamptz not null default now()
);

-- Checks are (re)declared by name so a re-run converges on the current lists.
alter table public.comic_safety_events drop constraint if exists comic_safety_events_surface_check;
alter table public.comic_safety_events add constraint comic_safety_events_surface_check
  check (surface in ('message', 'script', 'file', 'upload', 'patch', 'render', 'publish', 'report', 'import', 'appeal'));
alter table public.comic_safety_events drop constraint if exists comic_safety_events_layer_check;
alter table public.comic_safety_events add constraint comic_safety_events_layer_check
  check (layer in ('prefilter', 'classifier', 'vision_qc', 'vision_check', 'provider', 'hash', 'admin', 'second_opinion', 'classifier_unavailable'));
alter table public.comic_safety_events drop constraint if exists comic_safety_events_decision_check;
alter table public.comic_safety_events add constraint comic_safety_events_decision_check
  check (decision in ('allow', 'adapt', 'block', 'withhold', 'restore'));
alter table public.comic_safety_events drop constraint if exists comic_safety_events_effective_rating_check;
alter table public.comic_safety_events add constraint comic_safety_events_effective_rating_check
  check (effective_rating is null or effective_rating in ('G', 'PG', 'PG-13'));
alter table public.comic_safety_events drop constraint if exists comic_safety_events_assessed_check;
alter table public.comic_safety_events add constraint comic_safety_events_assessed_check
  check (assessed is null or assessed in ('G', 'PG', 'PG-13', 'X'));
alter table public.comic_safety_events drop constraint if exists comic_safety_events_severity_check;
alter table public.comic_safety_events add constraint comic_safety_events_severity_check
  check (severity between 0 and 3);
alter table public.comic_safety_events drop constraint if exists comic_safety_events_hash_shape;
alter table public.comic_safety_events add constraint comic_safety_events_hash_shape
  check (content_hash is null or content_hash ~ '^[0-9a-f]{16,64}$');

create index if not exists comic_safety_events_user_idx on public.comic_safety_events (user_id, created_at desc);
create index if not exists comic_safety_events_project_idx on public.comic_safety_events (project_id, created_at desc);
create index if not exists comic_safety_events_strikes_idx on public.comic_safety_events (user_id, created_at desc) where severity > 0;

alter table public.comic_safety_events enable row level security;
revoke all on public.comic_safety_events from public, anon, authenticated;

-- ── 2. Cases (reader reports, owner appeals, automatic flags) ───────────────────────────────

create table if not exists public.comic_safety_cases (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete set null,
  reporter_id uuid references auth.users(id) on delete set null,
  -- Salted, daily-rotating hash of an anonymous reporter's IP (dedupe only; never the IP).
  reporter_fingerprint text,
  -- RenderTarget, asset path / quarantine path, page, the check run when it opened. No content.
  target jsonb not null default '{}'::jsonb,
  reason text not null,
  note text,
  status text not null default 'open',
  resolution text,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  -- UTC day of the report (the dedupe key; a plain column keeps the unique index immutable).
  report_day date not null default ((now() at time zone 'utc')::date),
  created_at timestamptz not null default now()
);
alter table public.comic_safety_cases add column if not exists report_day date not null default ((now() at time zone 'utc')::date);

alter table public.comic_safety_cases drop constraint if exists comic_safety_cases_kind_check;
alter table public.comic_safety_cases add constraint comic_safety_cases_kind_check check (kind in ('report', 'appeal', 'auto'));
alter table public.comic_safety_cases drop constraint if exists comic_safety_cases_status_check;
alter table public.comic_safety_cases add constraint comic_safety_cases_status_check check (status in ('open', 'auto_cleared', 'resolved', 'dismissed'));
alter table public.comic_safety_cases drop constraint if exists comic_safety_cases_note_check;
alter table public.comic_safety_cases add constraint comic_safety_cases_note_check check (note is null or char_length(note) <= 300);
alter table public.comic_safety_cases drop constraint if exists comic_safety_cases_reason_check;
alter table public.comic_safety_cases add constraint comic_safety_cases_reason_check check (char_length(reason) between 1 and 200);
alter table public.comic_safety_cases drop constraint if exists comic_safety_cases_fingerprint_shape;
alter table public.comic_safety_cases add constraint comic_safety_cases_fingerprint_shape
  check (reporter_fingerprint is null or reporter_fingerprint ~ '^[0-9a-f]{16,64}$');

-- One report per (reporter, comic, target, day).
create unique index if not exists comic_safety_cases_dedupe
  on public.comic_safety_cases (project_id, coalesce(reporter_id::text, reporter_fingerprint, ''), coalesce(target->>'path', ''), report_day)
  where kind = 'report';
create index if not exists comic_safety_cases_open_idx on public.comic_safety_cases (status, created_at desc);
create index if not exists comic_safety_cases_project_idx on public.comic_safety_cases (project_id, created_at desc);
create index if not exists comic_safety_cases_owner_appeals_idx on public.comic_safety_cases (owner_user_id, created_at desc) where kind = 'appeal';

alter table public.comic_safety_cases enable row level security;
revoke all on public.comic_safety_cases from public, anon, authenticated;

-- ── 3. Image denylist (dHash near-duplicates of blocked images) ─────────────────────────────

create table if not exists public.comic_blocked_hashes (
  hash text primary key,
  kind text not null,
  category text not null,
  created_at timestamptz not null default now()
);
alter table public.comic_blocked_hashes drop constraint if exists comic_blocked_hashes_kind_check;
alter table public.comic_blocked_hashes add constraint comic_blocked_hashes_kind_check check (kind in ('dhash', 'sha256'));
alter table public.comic_blocked_hashes drop constraint if exists comic_blocked_hashes_shape;
alter table public.comic_blocked_hashes add constraint comic_blocked_hashes_shape
  check ((kind = 'dhash' and hash ~ '^[0-9a-f]{16}$') or (kind = 'sha256' and hash ~ '^[0-9a-f]{64}$'));

alter table public.comic_blocked_hashes enable row level security;
revoke all on public.comic_blocked_hashes from public, anon, authenticated;

-- ── 4. Quarantine map (where a withheld object went; moderators and appeals need it) ────────

create table if not exists public.comic_quarantine (
  path text primary key,
  quarantine_path text not null,
  project_id uuid references public.projects(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  reason text not null default 'blocked',
  created_at timestamptz not null default now()
);
alter table public.comic_quarantine drop constraint if exists comic_quarantine_path_shape;
alter table public.comic_quarantine add constraint comic_quarantine_path_shape check (quarantine_path like 'q/%');
create index if not exists comic_quarantine_project_idx on public.comic_quarantine (project_id, created_at desc);

alter table public.comic_quarantine enable row level security;
revoke all on public.comic_quarantine from public, anon, authenticated;

-- ── 5. Gallery rating mirror (server-written; a client can never set it) ────────────────────

alter table public.projects add column if not exists content_rating text;
alter table public.projects drop constraint if exists projects_content_rating_check;
alter table public.projects add constraint projects_content_rating_check
  check (content_rating is null or content_rating in ('G', 'PG', 'PG-13'));

-- A client write keeps the old value (insert: null): the "Kids-friendly" gallery filter must
-- never trust an owner's own label. Same caller test as the P0-SEC guard.
create or replace function public.projects_guard_content_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), 'service_role') <> 'service_role' then
    if tg_op = 'INSERT' then
      new.content_rating := null;
    else
      new.content_rating := old.content_rating;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.projects_guard_content_rating() from public, anon, authenticated;

drop trigger if exists trg_projects_guard_content_rating on public.projects;
create trigger trg_projects_guard_content_rating
  before insert or update of content_rating on public.projects
  for each row execute function public.projects_guard_content_rating();

-- ── 6. Moderation actions: the new action names ─────────────────────────────────────────────

do $$
declare
  r record;
begin
  -- Drop every CHECK on project_moderation_actions that constrains `action` (the live name
  -- may differ from the inline default), then add the named superset.
  for r in
    select conname from pg_constraint
    where conrelid = 'public.project_moderation_actions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%action%'
      and conname <> 'project_moderation_actions_action_check_v2'
  loop
    execute format('alter table public.project_moderation_actions drop constraint %I', r.conname);
  end loop;
end;
$$;
alter table public.project_moderation_actions drop constraint if exists project_moderation_actions_action_check_v2;
alter table public.project_moderation_actions add constraint project_moderation_actions_action_check_v2
  check (action in (
    'force_private', 'request_republish', 'approve_republish', 'reject_republish',
    'auto_hold', 'withhold_page', 'restore_page', 'appeal', 'appeal_resolved', 'publish_blocked'
  ));

-- ── 7. Retention: events 180 days, closed cases 1 year, quarantine map 90 days after review ─

create or replace function public.purge_comic_safety_events()
returns integer
language sql
security definer
set search_path = public
as $$
  with e as (
    delete from public.comic_safety_events where created_at < now() - interval '180 days' returning 1
  ), c as (
    delete from public.comic_safety_cases where status <> 'open' and coalesce(resolved_at, created_at) < now() - interval '365 days' returning 1
  )
  select ((select count(*) from e) + (select count(*) from c))::int;
$$;
revoke all on function public.purge_comic_safety_events() from public, anon, authenticated;
grant execute on function public.purge_comic_safety_events() to service_role;

-- Daily, next to the image-asset retention job (its own job: the retention function is P0-SEC's).
do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'comic-safety-events-purge-daily';
    perform cron.schedule('comic-safety-events-purge-daily', '35 3 * * *', $job$select public.purge_comic_safety_events();$job$);
  end if;
exception when undefined_table or undefined_function then
  raise notice 'pg_cron unavailable; schedule purge_comic_safety_events() yourself.';
end;
$do$;

-- ── Post-apply checks (read-only; run after apply_migration) ────────────────────────────────
-- 1) RLS on, nothing granted to clients:
--    select relname, relrowsecurity from pg_class where relname in
--      ('comic_safety_events','comic_safety_cases','comic_blocked_hashes','comic_quarantine');      -- all true
--    select table_name, grantee, privilege_type from information_schema.role_table_grants
--     where table_name in ('comic_safety_events','comic_safety_cases','comic_blocked_hashes','comic_quarantine')
--       and grantee in ('anon','authenticated');                                                     -- 0 rows
--    select tablename, policyname from pg_policies where tablename like 'comic_safety%'
--       or tablename in ('comic_blocked_hashes','comic_quarantine');                                 -- 0 rows
-- 2) No publish trigger, the content-rating guard present:
--    select tgname from pg_trigger where tgrelid = 'public.projects'::regclass and not tgisinternal; -- has
--      trg_projects_guard_content_rating; NO trg_projects_guard_publish
-- 3) No comic_docs.safety_* columns:
--    select column_name from information_schema.columns where table_name = 'comic_docs' and column_name like 'safety%'; -- 0 rows
-- 4) Moderation actions accept the new names:
--    select pg_get_constraintdef(oid) from pg_constraint where conname = 'project_moderation_actions_action_check_v2';
-- 5) get_advisors(security): no new findings for these tables.
