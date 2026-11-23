-- Capture the verified issuer's immutable subject at account creation, atomically with its Auth row.
-- Depends on member_referrals.sql. Only the backend can supply raw_app_meta_data on user creation.
begin;
create schema if not exists google_login_private;
revoke all on schema google_login_private from public, anon, authenticated;
create table if not exists google_login_private.subjects (
  subject text primary key check (length(subject) between 1 and 255),
  user_id uuid not null unique references auth.users(id) on delete cascade
);
alter table google_login_private.subjects enable row level security;
revoke all on google_login_private.subjects from public, anon, authenticated;

create or replace function google_login_private.bind_new_account() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  subject_value text := new.raw_app_meta_data->>'dreamstream_google_sub';
  invite_code text := new.raw_app_meta_data->>'dreamstream_referral_code';
begin
  if subject_value is null then return new; end if;
  insert into google_login_private.subjects(subject,user_id) values(subject_value,new.id);
  if invite_code ~ '^[a-f0-9]{32}$' then
    insert into public.member_referral_signups(member_id,referrer_id,method,proof_id,verified_at)
    select new.id, l.owner_id, 'google', new.id, new.email_confirmed_at
    from public.member_referral_links l where l.code=invite_code and l.owner_id<>new.id
    on conflict do nothing;
  end if;
  return new;
end $$;
revoke all on function google_login_private.bind_new_account() from public, anon, authenticated;
create or replace trigger bind_dreamstream_google_identity after insert on auth.users
for each row when (new.raw_app_meta_data ? 'dreamstream_google_sub')
execute function google_login_private.bind_new_account();

-- Return only the account that owns this subject. An unbound email match returns just a conflict flag.
create or replace function public.lookup_google_login(p_subject text,p_email text)
returns table(bound_id uuid,login_email text,email_in_use boolean)
language sql stable security definer set search_path = '' as $$
  select u.id,u.email::text,exists(select 1 from auth.users e where lower(e.email)=lower(p_email) and e.deleted_at is null)
  from (values(1)) as seed(dummy) left join google_login_private.subjects g on g.subject=p_subject
  left join auth.users u on u.id=g.user_id and u.deleted_at is null;
$$;
revoke all on function public.lookup_google_login(text,text) from public,anon,authenticated;
grant execute on function public.lookup_google_login(text,text) to service_role;
commit;
