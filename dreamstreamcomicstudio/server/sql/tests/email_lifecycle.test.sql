\set ON_ERROR_STOP 1
alter table auth.users add column if not exists email_confirmed_at timestamptz;
\ir ../waitlist_signups.sql
\ir ../email_system.sql
insert into auth.users(id,email,email_confirmed_at) values('00000000-0000-0000-0000-00000000a101','old@example.test',now());
insert into public.waitlist_signups(email,kind) values('legacy@example.test','access');
\ir ../email_lifecycle.sql
\ir ../email_lifecycle.sql

do $$
declare
  claimed public.email_lifecycle_jobs;
  reclaimed public.email_lifecycle_jobs;
begin
  assert not exists(select 1 from public.email_lifecycle_jobs), 'no historical backfill';
  assert not has_function_privilege('anon','public.claim_lifecycle_email()','execute');
  assert not has_column_privilege('authenticated','public.waitlist_signups','mail_requested_at','insert');
  insert into auth.users(id,email,email_confirmed_at) values('00000000-0000-0000-0000-00000000a102','off@example.test',now());
  update public.email_lifecycle_settings set account_welcome_enabled=true;
  insert into auth.users(id,email) values('00000000-0000-0000-0000-00000000a103','new@example.test');
  assert not exists(select 1 from public.email_lifecycle_jobs), 'no welcome before verification';
  update auth.users set email_confirmed_at=now() where id='00000000-0000-0000-0000-00000000a103';
  update auth.users set email_confirmed_at=now() where id='00000000-0000-0000-0000-00000000a103';
  assert (select count(*) from public.email_lifecycle_jobs)=1, 'first confirmation creates a single welcome';
  select * into claimed from public.claim_lifecycle_email();
  assert claimed.attempts=1 and claimed.template='welcome';
  assert not exists(select 1 from public.claim_lifecycle_email()), 'no duplicate concurrent claim';
  update public.email_lifecycle_jobs set lease_until=now()-interval '1 minute';
  select * into reclaimed from public.claim_lifecycle_email();
  assert reclaimed.id=claimed.id and reclaimed.attempts=2 and reclaimed.lease_id<>claimed.lease_id;
  update public.email_lifecycle_jobs set state='sent' where id=claimed.id and lease_id=claimed.lease_id;
  assert not found, 'stale worker cannot acknowledge new lease';

  insert into public.waitlist_signups(email,kind,mail_requested_at) values('join@example.test','updates',now());
  update public.waitlist_signups set mail_requested_at=now()+interval '1 second' where email='join@example.test';
  assert (select count(*) from public.email_lifecycle_jobs where template='newsletter-confirm')=1, 'duplicate requests coalesce';
  update public.waitlist_signups set confirmed=true, confirm_token=null, mail_requested_at=now()+interval '2 seconds' where email='join@example.test';
  assert (select count(*) from public.email_lifecycle_jobs where template='newsletter-welcome')=1;
  insert into public.waitlist_signups(email,kind,confirm_token) values('out@example.test','updates','old-token');
  insert into public.email_suppressions(email,scope) values('out@example.test','marketing');
  update public.waitlist_signups set confirmed=true where email='out@example.test' and confirm_token='old-token';
  assert not found, 'persisted suppression prevents old-link confirmation even before the waitlist stamp';
  insert into public.waitlist_signups(email,kind,mail_requested_at) values('interest@example.test','access',now());
  assert (select count(*) from public.email_lifecycle_jobs where template='access-requested')=1;
end $$;
\echo EMAIL_LIFECYCLE_OK
