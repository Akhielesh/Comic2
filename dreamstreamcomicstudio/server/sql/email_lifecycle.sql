-- Apply after waitlist_signups.sql and email_system.sql. No existing rows are scanned or enqueued.
-- Only the service role can inspect delivery jobs or request an interest message.
begin;
alter table public.waitlist_signups add column if not exists mail_requested_at timestamptz;
create table if not exists public.email_lifecycle_settings (
  id boolean primary key default true check (id),
  account_welcome_enabled boolean not null default false,
  wake_url text check (wake_url like 'https://%/api/health')
);
insert into public.email_lifecycle_settings(id) values(true) on conflict do nothing;
create table if not exists public.email_lifecycle_jobs (
  id uuid primary key default gen_random_uuid(),
  template text not null check (template in ('welcome','access-requested','newsletter-confirm','newsletter-welcome')),
  signup_id uuid references public.waitlist_signups(id) on delete cascade,
  account_id uuid references auth.users(id) on delete cascade,
  state text not null default 'queued' check (state in ('queued','sending','sent','skipped','failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  lease_id uuid,
  lease_until timestamptz,
  check ((template='welcome' and account_id is not null and signup_id is null)
     or (template<>'welcome' and account_id is null and signup_id is not null))
);
create unique index if not exists email_lifecycle_account on public.email_lifecycle_jobs(account_id) where account_id is not null;
create unique index if not exists email_lifecycle_signup_pending on public.email_lifecycle_jobs(signup_id,template)
  where state in ('queued','sending');
create index if not exists email_lifecycle_due on public.email_lifecycle_jobs(available_at) where state in ('queued','sending');
alter table public.email_lifecycle_jobs enable row level security;
alter table public.email_lifecycle_settings enable row level security;
revoke all on public.email_lifecycle_jobs, public.email_lifecycle_settings from public, anon, authenticated;
grant select,insert,update,delete on public.email_lifecycle_jobs to service_role;
grant select,update on public.email_lifecycle_settings to service_role;

-- A persisted opt-out takes effect even if the companion unsubscribe timestamp update is
-- still being retried. The UPDATE returns zero rows to the confirmation route.
create or replace function public.prevent_suppressed_confirmation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists(select 1 from public.email_suppressions where email=lower(new.email) and scope in ('all','marketing')) then
    return null;
  end if;
  return new;
end $$;
revoke all on function public.prevent_suppressed_confirmation() from public, anon, authenticated;
drop trigger if exists waitlist_honor_suppression on public.waitlist_signups;
create trigger waitlist_honor_suppression before update of confirmed on public.waitlist_signups
for each row when (new.kind='updates' and new.confirmed and not old.confirmed)
execute function public.prevent_suppressed_confirmation();

create or replace function public.enqueue_interest_email() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.mail_requested_at is null then return new; end if;
  if tg_op='UPDATE' and new.mail_requested_at is not distinct from old.mail_requested_at then return new; end if;
  insert into public.email_lifecycle_jobs(template,signup_id)
    values (case when new.kind='access' then 'access-requested' when new.confirmed then 'newsletter-welcome' else 'newsletter-confirm' end, new.id)
    on conflict do nothing;
  return new;
end $$;
drop trigger if exists waitlist_email_requested on public.waitlist_signups;
create trigger waitlist_email_requested after insert or update of mail_requested_at on public.waitlist_signups
for each row execute function public.enqueue_interest_email();

-- The Auth writer cannot access the service-only queue. The trigger takes no arguments and enqueues only
-- a verified transition for the row Auth just wrote. It reads no client-supplied address or metadata.
create or replace function public.enqueue_verified_welcome() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email_confirmed_at is null or nullif(new.email,'') is null then return new; end if;
  if tg_op='UPDATE' and old.email_confirmed_at is not null then return new; end if;
  if exists(select 1 from public.email_lifecycle_settings where account_welcome_enabled) then
    insert into public.email_lifecycle_jobs(template,account_id) values('welcome',new.id) on conflict do nothing;
  end if;
  return new;
end $$;
revoke all on function public.enqueue_interest_email(), public.enqueue_verified_welcome() from public, anon, authenticated;
drop trigger if exists verified_welcome_requested on auth.users;
create trigger verified_welcome_requested after insert or update of email_confirmed_at on auth.users
for each row execute function public.enqueue_verified_welcome();

-- Claim one event at a time: the runner sends one before claiming the next. Another process may reclaim
-- a crashed runner's lease. The completion write checks the lease ID so a stale owner cannot overwrite it.
create or replace function public.claim_lifecycle_email() returns setof public.email_lifecycle_jobs
language sql set search_path = '' as $$
 with candidate as (
   select id from public.email_lifecycle_jobs where
     (state='queued' and available_at <= now()) or (state='sending' and lease_until < now())
   order by available_at, id limit 1 for update skip locked
 )
 update public.email_lifecycle_jobs j set state='sending', attempts=j.attempts+1,
  lease_id=gen_random_uuid(), lease_until=now()+interval '10 minutes'
 from candidate c where j.id=c.id returning j.*
$$;
revoke all on function public.claim_lifecycle_email() from public, anon, authenticated;
grant execute on function public.claim_lifecycle_email() to service_role;
-- Optional wake-up for a sleeping Cloudflare Container. Only an explicitly configured HTTPS
-- health endpoint receives a GET, only while a job is due. No email, token or credential leaves
-- the database in this request. An active backend also polls without either extension.
do $$
begin
  if exists(select 1 from pg_extension where extname='pg_cron')
    and exists(select 1 from pg_extension where extname='pg_net') then
    perform cron.schedule('dreamstream-email-wake', '*/5 * * * *', $job$
      select net.http_get(url:=s.wake_url) from public.email_lifecycle_settings s
        where s.wake_url is not null and exists(select 1 from public.email_lifecycle_jobs j
          where (j.state='queued' and j.available_at<=now()) or (j.state='sending' and j.lease_until<now()));
    $job$);
  end if;
end $$;
commit;
