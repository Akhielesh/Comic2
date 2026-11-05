-- Register interest (2026-11): which DreamStream studios a subscriber wants to hear about.
--
-- Registering interest reuses the newsletter's double opt-in row: one kind = 'updates' row per
-- address in public.waitlist_signups, with the picked studios in product_interests. POST
-- /api/interest (server/src/routes/interest.ts) is the only writer for it, through the service
-- role. Admins read aggregate counts only, through waitlist_interest_summary() below.
--
-- Idempotent: safe to run more than once. Additive: it drops no column or policy; the one policy it
-- alters (waitlist_public_insert, section 7) only gets stricter. The only rows it ever removes
-- are stale, non-subscribed interest rows and their confirmation-email log rows, through the
-- daily retention job in section 6 (the first run deletes any already past their 30 days).
-- Apply it AFTER the backend that ships with it is deployed (that backend only writes ids in the
-- list below; an older one still accepts 'code_studio' / 'dashboards' and its inserts would fail
-- the new CHECK). The backend works before this file is applied: the live table already has
-- product_interests (added outside the repo), the CHECK is then enforced by the server alone,
-- and the admin summary counts rows itself instead of calling the function.
--
-- Requires server/sql/waitlist_signups.sql. Restates the email_system.sql double opt-in columns
-- (add column if not exists) so this file also stands on its own.
--
-- The studio list must match services/studioInterests.ts (STUDIO_INTERESTS); the test
-- services/studioInterests.test.ts fails when they differ.

-- 1) Columns. product_interests and feedback exist on the live table but were never in a repo
--    SQL file; this reconciles the repo with production. The rest come from email_system.sql.
alter table public.waitlist_signups
  add column if not exists product_interests text[] not null default '{}'::text[],
  add column if not exists feedback text,
  add column if not exists confirmed boolean not null default false,
  add column if not exists confirm_token text,
  add column if not exists confirm_sent_at timestamptz,
  add column if not exists confirmed_at timestamptz,
  add column if not exists unsubscribed_at timestamptz;

-- 1b) One spelling per address. Lookups compare the stored address exactly, and the unique index
--     is on lower(email), so a row stored with capitals (only a direct client insert could write
--     one) would be invisible to them yet block the server's own insert. Lowercasing can't
--     collide: that index already forbids two rows differing only in case. Matched no row on
--     2026-11-05; section 7 stops new ones.
update public.waitlist_signups set email = lower(email) where email <> lower(email);

-- 2) Retired ids (Code Studio was retired on 2026-10-22, ADR 0005; "Dashboards" was never a
--    studio). Nothing is lost: any such value moves to metadata.retired_product_interests before
--    the CHECK below is added. Matches no row once it has run (and matched none on 2026-11-05).
update public.waitlist_signups
set
  metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
    'retired_product_interests',
    to_jsonb(array(
      select x from unnest(product_interests) as x
      where not (x = any (array['comic_studio', 'stream_studio', 'chat_studio', 'atlas_studio', 'future_studios']::text[]))
    ))
  ),
  product_interests = array(
    select x from unnest(product_interests) as x
    where x = any (array['comic_studio', 'stream_studio', 'chat_studio', 'atlas_studio', 'future_studios']::text[])
  )
where not (product_interests <@ array['comic_studio', 'stream_studio', 'chat_studio', 'atlas_studio', 'future_studios']::text[]);

-- 3) Only known studio ids, and no more of them than the list holds (the server also dedupes).
--    Dropped and re-added, so re-running this file after the list changes updates the constraint.
alter table public.waitlist_signups drop constraint if exists waitlist_signups_product_interests_known;
alter table public.waitlist_signups
  add constraint waitlist_signups_product_interests_known check (
    product_interests <@ array['comic_studio', 'stream_studio', 'chat_studio', 'atlas_studio', 'future_studios']::text[]
    and cardinality(product_interests) <= 5
  );

-- 4) The per-recipient confirmation throttle (and the auth-email one) look up email_log by exact
--    to_email + template, newest first. The existing index is on lower(to_email), which those
--    equality lookups can't use. to_email is always stored lowercased (emailStore.normalizeEmail).
create index if not exists idx_email_log_to_template
  on public.email_log (to_email, template, created_at desc);

-- 5) Admin summary: counts per studio, never an address. One row per studio id, plus a '*' row
--    for every subscriber whatever they picked. "pending" = not confirmed yet; unsubscribed rows
--    count only in the unsubscribed column. access_requests = the request-access waitlist
--    (kind = 'access'), which has no confirmation step.
create or replace function public.waitlist_interest_summary()
returns table (
  studio text,
  confirmed bigint,
  pending bigint,
  unsubscribed bigint,
  access_requests bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with picks as (
    select w.kind, w.confirmed, w.unsubscribed_at, s.studio
    from public.waitlist_signups as w
    cross join lateral unnest(w.product_interests) as s(studio)
    union all
    select w.kind, w.confirmed, w.unsubscribed_at, '*'::text
    from public.waitlist_signups as w
  )
  select
    p.studio,
    count(*) filter (where p.kind = 'updates' and p.confirmed and p.unsubscribed_at is null),
    count(*) filter (where p.kind = 'updates' and not p.confirmed and p.unsubscribed_at is null),
    count(*) filter (where p.kind = 'updates' and p.unsubscribed_at is not null),
    count(*) filter (where p.kind = 'access')
  from picks as p
  group by p.studio
$$;

-- Service role only. Postgres grants EXECUTE to PUBLIC by default; take it back from every
-- client role so the anon key can't call it through PostgREST.
revoke all on function public.waitlist_interest_summary() from public, anon, authenticated;
grant execute on function public.waitlist_interest_summary() to service_role;

-- 6) Retention for interest / newsletter rows (kind = 'updates'). Deletes a row that is not an
--    active subscription once BOTH its last confirmation email and its unsubscribe (if any) are
--    more than 30 days old:
--      * never confirmed: 30 days after the last confirmation email (links expire after 7);
--      * unsubscribed: 30 days after unsubscribing (its studio picks were already cleared then),
--        unless they asked to subscribe again within the last 30 days.
--    Active subscribers are never touched. Also deletes the email_log rows of confirmation
--    emails (template 'newsletter-confirm') older than 30 days, whoever they went to: someone
--    may have typed an address that isn't theirs, and the per-recipient throttle only needs the
--    last 24 hours. (A subscriber's own row keeps confirm_sent_at and confirmed_at.)
--    The marketing suppression list (email_suppressions) is separate and NOT purged: it is what
--    keeps an unsubscribed address from being emailed. Request-access rows (kind = 'access') are
--    out of scope here. Returns how many rows it deleted, both tables together.
create or replace function public.waitlist_interest_retention()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted integer;
  v_logs integer;
begin
  delete from public.waitlist_signups as w
  where w.kind = 'updates'
    and not (w.confirmed and w.unsubscribed_at is null)
    and coalesce(w.confirm_sent_at, w.created_at) < now() - interval '30 days'
    and coalesce(w.unsubscribed_at, '-infinity'::timestamptz) < now() - interval '30 days';
  get diagnostics v_deleted = row_count;

  delete from public.email_log as l
  where l.template = 'newsletter-confirm'
    and l.created_at < now() - interval '30 days';
  get diagnostics v_logs = row_count;

  return v_deleted + v_logs;
end;
$$;

revoke all on function public.waitlist_interest_retention() from public, anon, authenticated;
grant execute on function public.waitlist_interest_retention() to service_role;

-- Daily at 03:23 UTC via pg_cron (enabled on the project; same pattern as
-- image_assets_retention.sql). Re-running this file replaces the job instead of duplicating it.
create extension if not exists pg_cron with schema extensions;

do $do$
declare
  v_existing integer;
begin
  select jobid into v_existing from cron.job where jobname = 'waitlist-interest-retention-daily' limit 1;
  if v_existing is not null then
    perform cron.unschedule(v_existing);
  end if;
  perform cron.schedule(
    'waitlist-interest-retention-daily',
    '23 3 * * *',
    $job$select public.waitlist_interest_retention();$job$
  );
exception when undefined_table then
  raise notice 'cron.job table unavailable; skip schedule setup.';
end $do$;

-- 7) Access. RLS stays on, with no SELECT/UPDATE/DELETE policy and those privileges revoked
--    (waitlist_signups.sql): the service role (the server) is the only reader and the only one
--    that can change a row.
--    Clients keep INSERT, because the request-access form's offline fallback in
--    services/waitlist.ts (and older tabs) still insert directly, but ONLY of email, kind, source
--    and metadata: exactly what that fallback writes. Before this, anon could set every column
--    (live on 2026-11-05: INSERT on all 13 columns), so the public anon key could create an
--    already-"confirmed" subscriber, pick its confirm_token, or plant studio picks, skipping the
--    double opt-in. Every other column now takes its default (confirmed = false, no token, no
--    picks). The policy also requires the address in lowercase and repeats those defaults, so a
--    later blanket GRANT can't reopen it. (The server no longer trusts a token it didn't sign,
--    services/confirmToken.ts, so a forged token was already useless; this closes the rest.)
--    Safe to apply at any time: no current client writes any other column.
alter table public.waitlist_signups enable row level security;
revoke select, update, delete, truncate on public.waitlist_signups from anon, authenticated;
revoke insert, references, trigger on public.waitlist_signups from anon, authenticated;
grant insert (email, kind, source, metadata) on public.waitlist_signups to anon, authenticated;

-- Altered in place (waitlist_signups.sql created it), so there is no moment without the policy.
alter policy waitlist_public_insert on public.waitlist_signups
  to anon, authenticated
  with check (
    email is not null
    and char_length(email) <= 320
    and email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    and email = lower(email)
    and kind in ('updates', 'access')
    and confirmed = false
    and confirm_token is null
    and confirm_sent_at is null
    and confirmed_at is null
    and unsubscribed_at is null
    and cardinality(product_interests) = 0
    and feedback is null
  );
