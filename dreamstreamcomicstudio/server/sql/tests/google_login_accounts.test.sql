\set ON_ERROR_STOP 1
alter table auth.users add column if not exists email_confirmed_at timestamptz;
alter table auth.users add column if not exists raw_app_meta_data jsonb;
alter table auth.users add column if not exists deleted_at timestamptz;
\ir ../member_referrals.sql
\ir ../google_login_accounts.sql
\ir ../google_login_accounts.sql
do $$
declare owner uuid:=gen_random_uuid(); member uuid:=gen_random_uuid(); other_id uuid:=gen_random_uuid(); invite text;
begin
  insert into auth.users(id,email,email_confirmed_at) values(owner,'old@example.test',now());
  select code into invite from public.member_referral_summary(owner);
  insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data) values(member,'new@example.test', now(),
    jsonb_build_object('dreamstream_google_sub','verified-123','dreamstream_referral_code',invite));
  assert (select bound_id=member from public.lookup_google_login('verified-123','new@example.test'));
  assert (select bound_id is null and email_in_use from public.lookup_google_login('other-sub','old@example.test'));
  assert (select count(*)=1 from public.member_referral_signups where member_id=member and method='google' and verified_at is not null);
  begin
    insert into auth.users(id,email,raw_app_meta_data) values(other_id,'dup@example.test','{"dreamstream_google_sub":"verified-123"}');
    raise exception 'duplicate subject accepted';
  exception when unique_violation then null;
  end;
  assert not exists(select 1 from auth.users where id=other_id);
  insert into auth.users(id,email,raw_user_meta_data) values(other_id,'plain@example.test','{"dreamstream_google_sub":"fake"}');
  assert (select bound_id is null from public.lookup_google_login('fake','plain@example.test'));
  assert not has_function_privilege('authenticated','public.lookup_google_login(text,text)','EXECUTE');
  assert not has_function_privilege('anon','public.lookup_google_login(text,text)','EXECUTE');
  assert has_function_privilege('service_role','public.lookup_google_login(text,text)','EXECUTE');
  assert not has_schema_privilege('authenticated','google_login_private','USAGE');
end $$;
\echo GOOGLE_LOGIN_ACCOUNTS_OK
