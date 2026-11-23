begin;

-- Separate from access_invites: referrals attribute signups. They grant no role, credit or studio access.
create schema if not exists referral_private;
revoke all on schema referral_private from public, anon, authenticated;
create table if not exists public.member_referral_links (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  code text not null unique default replace(gen_random_uuid()::text,'-','') check (code ~ '^[0-9a-f]{32}$'),
  created_at timestamptz not null default now()
);
create table if not exists public.member_referral_signups (
  member_id uuid primary key references auth.users(id) on delete cascade,
  referrer_id uuid not null references public.member_referral_links(owner_id) on delete cascade,
  method text not null check (method in ('email','google')),
  proof_id uuid unique,
  joined_at timestamptz not null default now(),
  verified_at timestamptz,
  check (member_id <> referrer_id),
  check ((method = 'google') = (proof_id is not null))
);
create index if not exists member_referral_verified_owner on public.member_referral_signups(referrer_id) where verified_at is not null;
alter table public.member_referral_links enable row level security;
alter table public.member_referral_signups enable row level security;
revoke all on public.member_referral_links, public.member_referral_signups from public, anon, authenticated;

-- The API supplies the server-authenticated member id. Neither an address nor an invitee id leaves.
create or replace function public.member_referral_summary(p_owner uuid)
returns table(code text, verified_signups bigint)
language plpgsql security definer set search_path = '' as $$
declare own_code text;
begin
  if not exists (select 1 from auth.users u where u.id=p_owner and u.email_confirmed_at is not null) then return; end if;
  select l.code into own_code from public.member_referral_links l where l.owner_id=p_owner;
  if own_code is null then
    insert into public.member_referral_links as l(owner_id) values(p_owner)
      on conflict(owner_id) do update set owner_id=excluded.owner_id returning l.code into own_code;
  end if;
  return query select own_code, count(*) from public.member_referral_signups r where r.referrer_id=p_owner and r.verified_at is not null;
end $$;
revoke all on function public.member_referral_summary(uuid) from public, anon, authenticated;
grant execute on function public.member_referral_summary(uuid) to service_role;

-- Accept only the opaque code present AT INSERT. Later user-editable profile metadata cannot
-- create or replace a referral. A resend or cross-device verification uses the original row.
create or replace function referral_private.track_verified_signup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='INSERT' then
    if new.raw_app_meta_data->>'provider' = 'email' and (new.raw_user_meta_data->>'referral_code') ~ '^[0-9a-f]{32}$' then
      insert into public.member_referral_signups(member_id,referrer_id,method,verified_at)
        select new.id,l.owner_id,'email',new.email_confirmed_at from public.member_referral_links l
        where l.code=new.raw_user_meta_data->>'referral_code' and l.owner_id<>new.id
        on conflict do nothing;
    end if;
  elsif old.email_confirmed_at is null and new.email_confirmed_at is not null then
    update public.member_referral_signups set verified_at=new.email_confirmed_at
      where member_id=new.id and verified_at is null;
  end if;
  return new;
exception when others then
  -- The referral is optional. Auth must still create/confirm the account on a storage
  -- error (including a concurrently deleted referrer). Never log ids, email, codes or detail.
  raise warning 'member referral attribution unavailable, SQLSTATE %', SQLSTATE;
  return new;
end $$;
revoke all on function referral_private.track_verified_signup() from public, anon, authenticated, service_role;
create or replace trigger record_member_referral after insert or update of email_confirmed_at on auth.users
for each row execute function referral_private.track_verified_signup();

-- Only the service backend can pass a proof it signed before the Google authorization redirect.
-- Both PK and unique proof are enforced in the same insert so retries and racing callbacks are safe.
create or replace function public.finish_google_member_referral(p_member uuid,p_code text,p_proof uuid,p_started timestamptz)
returns void language sql security definer set search_path = '' as $$
  insert into public.member_referral_signups(member_id,referrer_id,method,proof_id,verified_at)
    select u.id,l.owner_id,'google',p_proof,u.email_confirmed_at
    from auth.users u join public.member_referral_links l on l.code=p_code
    where u.id=p_member and u.id<>l.owner_id and u.email_confirmed_at is not null
      and u.raw_app_meta_data->>'provider'='google'
      and p_started between now()-interval '2 hours' and now()
      and u.created_at>=p_started and l.created_at<=p_started and p_proof is not null
    on conflict do nothing;
$$;
revoke all on function public.finish_google_member_referral(uuid,text,uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.finish_google_member_referral(uuid,text,uuid,timestamptz) to service_role;
commit;
