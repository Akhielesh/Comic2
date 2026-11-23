\set ON_ERROR_STOP 1
alter table auth.users add column if not exists email_confirmed_at timestamptz;
alter table auth.users add column if not exists raw_app_meta_data jsonb;
\ir ../member_referrals.sql
\ir ../member_referrals.sql
do $$
declare
  a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); c uuid:=gen_random_uuid();
  d uuid:=gen_random_uuid(); e uuid:=gen_random_uuid(); f uuid:=gen_random_uuid();
  g uuid:=gen_random_uuid(); h uuid:=gen_random_uuid(); proof uuid:=gen_random_uuid();
  code_a text; code_b text; started timestamptz:=now();
begin
  insert into auth.users(id,email_confirmed_at,created_at) values (a,now(),now()-interval '10 days'),(b,now(),now()-interval '5 days');
  select code into code_a from public.member_referral_summary(a);
  select code into code_b from public.member_referral_summary(b);
  assert code_a <> code_b and code_a ~ '^[0-9a-f]{32}$' and code_a = (select code from public.member_referral_summary(a));
  insert into auth.users(id,raw_user_meta_data,raw_app_meta_data) values(c,jsonb_build_object('referral_code',code_a),'{"provider":"email"}');
  assert (select count(*)=0 from public.member_referral_summary(c));
  assert (select verified_signups=0 from public.member_referral_summary(a));
  update auth.users set raw_user_meta_data=jsonb_build_object('referral_code',code_b) where id=c;
  update auth.users set email_confirmed_at=now() where id=c;
  update auth.users set email_confirmed_at=now() where id=c;
  assert (select verified_signups=1 from public.member_referral_summary(a)) and (select verified_signups=0 from public.member_referral_summary(b));
  insert into auth.users(id,raw_app_meta_data) values(d,'{"provider":"email"}');
  update auth.users set raw_user_meta_data=jsonb_build_object('referral_code',code_a),email_confirmed_at=now() where id=d;
  assert not exists(select 1 from public.member_referral_signups where member_id=d);
  insert into auth.users(id,email_confirmed_at,created_at,raw_app_meta_data)
  values(e,now(),started,'{"provider":"google"}'),(f,now(),started,'{"provider":"google"}'),(g,now(),started-interval '1 hour','{"provider":"google"}'),
    (h,null,started,'{"provider":"google"}');
  perform public.finish_google_member_referral(e,code_a,proof,started);
  perform public.finish_google_member_referral(e,code_b,gen_random_uuid(),started);
  perform public.finish_google_member_referral(f,code_a,proof,started);
  perform public.finish_google_member_referral(g,code_a,gen_random_uuid(),started);
  perform public.finish_google_member_referral(h,code_a,gen_random_uuid(),started);
  perform public.finish_google_member_referral(f,code_a,gen_random_uuid(),started-interval '3 hours');
  perform public.finish_google_member_referral(c,code_a,gen_random_uuid(),started);
  assert (select verified_signups=2 from public.member_referral_summary(a)) and (select verified_signups=0 from public.member_referral_summary(b));
  assert (select count(*)=2 from public.member_referral_signups where referrer_id=a);
  update auth.users set raw_app_meta_data='{"provider":"google"}' where id=f;
  perform public.finish_google_member_referral(f,(select code from public.member_referral_summary(f)),gen_random_uuid(),started);
  assert not exists(select 1 from public.member_referral_signups where member_id=f);
  assert not has_table_privilege('authenticated','public.member_referral_signups','select');
  assert not has_table_privilege('anon','public.member_referral_links','insert');
  assert not has_function_privilege('authenticated','public.member_referral_summary(uuid)','execute');
  assert not has_function_privilege('anon','public.finish_google_member_referral(uuid,text,uuid,timestamptz)','execute');
  assert not has_schema_privilege('authenticated','referral_private','usage');
  assert has_function_privilege('service_role','public.member_referral_summary(uuid)','execute');
end $$;

-- A failure writing optional attribution must not roll back account creation or verification.
begin;
create function pg_temp.break_referral_write() returns trigger language plpgsql as $$
begin raise exception 'test fixture rejects this referral'; end $$;
create trigger break_referral_write before insert or update on public.member_referral_signups for each row execute function pg_temp.break_referral_write();
do $$ declare a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); c text; begin
  insert into auth.users(id,email_confirmed_at) values(a,now());
  select code into c from public.member_referral_summary(a);
  insert into auth.users(id,raw_user_meta_data,raw_app_meta_data) values(b,jsonb_build_object('referral_code',c),'{"provider":"email"}');
  update auth.users set email_confirmed_at=now() where id=b;
  assert exists(select 1 from auth.users where id=b and email_confirmed_at is not null);
  assert not exists(select 1 from public.member_referral_signups where member_id=b);
end $$;
rollback;
\echo MEMBER_REFERRALS_OK
