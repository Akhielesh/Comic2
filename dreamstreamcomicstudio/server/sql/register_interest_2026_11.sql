-- Register interest (2026-11): which DreamStream studios a subscriber wants to hear about.
--
-- Registering interest reuses the newsletter's double opt-in row: one kind = 'updates' row per
-- address in public.waitlist_signups, with the picked studios in product_interests. POST
-- /api/interest (server/src/routes/interest.ts) is the only writer for it, through the service
-- role. Admins read aggregate counts only, through waitlist_interest_summary() below.
--
-- Idempotent: safe to run more than once. Additive: it drops no column or policy; the one policy it
-- alters (waitlist_public_insert, section 7) only gets stricter, and the one trigger it adds
-- (section 8) only changes what a client's direct INSERT of an already-listed address answers
-- (no more 23505, so the table no longer tells anyone whether an address is on it). The only rows it ever removes
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

-- 2b) Repeated ids. Until section 7 is applied, the public anon key can insert any picks, so a row
--     can hold more entries than the CHECK below allows while every entry is a known id (say
--     comic_studio six times). Section 2 leaves such a row alone, and the CHECK would then refuse
--     the table and stop this file before its lockdown (sections 7-8) runs, or roll all of it back
--     when it runs as one transaction. Keep each id once, in first-seen order. Matches no row once
--     it has run (and matched none on 2026-11-05).
update public.waitlist_signups
set product_interests = array(
  select u.x
  from unnest(product_interests) with ordinality as u(x, n)
  where u.x is not null
  group by u.x
  order by min(u.n)
)
where cardinality(product_interests) > (select count(distinct x) from unnest(product_interests) as x);

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
--    A timestamp more than a minute in the future counts as missing: the server only ever stamps
--    the current time, so such a value came through the old all-column client INSERT grant, and
--    it must not keep a row forever.
--    Active subscribers are never touched. Also deletes the email_log rows of confirmation
--    emails (template 'newsletter-confirm') once they are more than 30 days old AND from before
--    the current UTC month, whoever they went to: someone may have typed an address that isn't
--    theirs, and the per-recipient throttle only needs the last 24 hours, but the monthly email
--    cap (EMAIL_MAX_PER_MONTH) and the confirmation budget count this month's rows, so a 31-day
--    month must not lose its first day's. (A subscriber's own row keeps confirm_sent_at and
--    confirmed_at.)
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
    and coalesce(
          case when w.confirm_sent_at <= now() + interval '1 minute' then w.confirm_sent_at end,
          case when w.created_at <= now() + interval '1 minute' then w.created_at end,
          '-infinity'::timestamptz
        ) < now() - interval '30 days'
    and coalesce(
          case when w.unsubscribed_at <= now() + interval '1 minute' then w.unsubscribed_at end,
          '-infinity'::timestamptz
        ) < now() - interval '30 days';
  get diagnostics v_deleted = row_count;

  delete from public.email_log as l
  where l.template = 'newsletter-confirm'
    and l.created_at < least(
          now() - interval '30 days',
          date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
        );
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

-- 8) No subscription oracle through the table itself. The unique index on (lower(email), kind)
--    turned a client's direct INSERT of an address already on the list into a 23505 error
--    (PostgREST 409), so anyone holding the public anon key could learn whether an address has
--    a row: pending, subscribed, or unsubscribed within the retention window, or a request for
--    access. (Live on 2026-11-05, with or without section 7.)
--    Now, for client roles only (the WHEN clause: a PostgREST request with the public key or a
--    signed-in user's session), this function writes a row that passes the policy above itself,
--    with ON CONFLICT DO NOTHING, and skips the client's own insert. So the client gets the
--    same answer whether or not the address is on the list (201, and zero rows written by its
--    statement, should anything report a count), and an existing row is never touched. A row
--    that fails the policy goes on unchanged and is refused by the policy or a constraint, for a
--    new address and a listed one alike. Skipping duplicates WITHOUT that check would open a new
--    oracle: this trigger runs before the policy and the NOT NULL checks, so an uppercase
--    address or a null metadata would then be refused for a new address and skipped (accepted)
--    for a listed one.
--    The condition below must stay exactly the policy's (services/studioInterests.test.ts
--    compares them). The service role (the server) is not affected: it still gets 23505, which
--    registerInterest's race handling relies on.
--    SECURITY DEFINER because client roles can't read the table: it runs as the table owner, to
--    whom RLS doesn't apply (the table doesn't FORCE it), with an empty search_path. Its own
--    insert runs as that owner, so the WHEN clause doesn't fire it again.
create or replace function public.waitlist_client_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    new.email is not null
    and char_length(new.email) <= 320
    and new.email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    and new.email = lower(new.email)
    and new.kind in ('updates', 'access')
    and new.confirmed = false
    and new.confirm_token is null
    and new.confirm_sent_at is null
    and new.confirmed_at is null
    and new.unsubscribed_at is null
    and cardinality(new.product_interests) = 0
    and new.feedback is null
  ) is not true then
    return new;
  end if;
  insert into public.waitlist_signups values (new.*) on conflict do nothing;
  return null;
end;
$$;

-- A trigger function; nobody calls it directly.
revoke all on function public.waitlist_client_insert() from public, anon, authenticated;

create or replace trigger waitlist_client_insert
  before insert on public.waitlist_signups
  for each row
  when (current_user in ('anon', 'authenticated'))
  execute function public.waitlist_client_insert();

-- 9) A confirm_sent_at in the future can only have come through the old all-column client INSERT
--    grant (the server stamps the current time). The server already ignores one (it would
--    otherwise block every confirmation email to that address); this clears any that exist, now
--    that section 7 stops new ones. Matched no row on 2026-11-05.
update public.waitlist_signups
set confirm_sent_at = null
where confirm_sent_at > now() + interval '1 minute';
