\set ON_ERROR_STOP 1
set client_min_messages = warning;
create table if not exists public.generation_cost_events(user_id uuid,provider text,created_at timestamptz,status text,is_byok boolean,provider_cost_usd numeric,reservation_id uuid);
create table if not exists public.token_ledger_entries(user_id uuid,provider text,created_at timestamptz,entry_type text,is_byok boolean,provider_cost_usd numeric,reservation_id uuid);
create table if not exists public.user_api_keys(user_id uuid,provider text);
\ir ../provider_usage_log.sql
\ir ../account_provider_analytics.sql
\ir ../account_provider_analytics.sql
do $$
declare a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); reservation uuid := gen_random_uuid(); r record; snap jsonb;
begin
  insert into auth.users(id) values(a),(b);
  insert into public.generation_cost_events(user_id,provider,created_at,status,is_byok,provider_cost_usd,reservation_id) values
    (a,'test',now(),'SETTLED',false,88,reservation), (a,'test',now(),'RESERVED',false,99,null),
    (b,'test',now(),'SETTLED',true,999,null),(a,'test',now()- interval '4 days','SETTLED',true,999,null);
  insert into public.token_ledger_entries(user_id,provider,created_at,entry_type,is_byok,provider_cost_usd,reservation_id) values
    (a,'test',now(),'SETTLE',false,88,reservation), (a,'test',now(),'BYOK_TRACKED',true,1,null),
    (a,'test',now(),'BYOK_SETTLED',true,0.3,null),(a,'test',now(),'USAGE_OBSERVED',true,0.01,null),
    (a,'test',now(),'USAGE_OBSERVED',true,null,null);
  select * into strict r from public.member_provider_models(a,now()-interval '1 day',now()+interval '1 second');
  assert r.platform_requests=1 and r.byok_requests=3 and r.estimated_byok_usd=0.3 and r.reported_byok_usd=0.01 and r.unpriced_byok_requests=1;
  insert into public.provider_usage_log(account_id,provider,day,calls,errors,blocked) values (a::text,'tool',current_date,3,1,2),(b::text,'tool',current_date,77,0,0);
  select * into strict r from public.member_provider_connectors(a,current_date,current_date+1);
  assert r.calls=3 and r.errors=1 and r.blocked=2;
  snap := jsonb_build_object('provider','openrouter','status','reported','checkedAt',1600000001000,'keyQuotaUsd',jsonb_build_object('remaining',4));
  perform public.record_provider_balance(a,snap,repeat('a',64));
  perform public.record_provider_balance(a,snap || '{"checkedAt":1600000000000}',repeat('a',64));
  perform public.record_provider_balance(null,snap,repeat('b',64));
  perform public.record_provider_balance(null,snap,repeat('b',64));
  assert (select count(*)=2 from public.provider_balance_observations);
  assert (select report=snap from public.provider_balance_observations where owner_id=a);
  assert not has_table_privilege('authenticated','public.provider_balance_observations','select');
  assert not has_function_privilege('authenticated','public.member_provider_models(uuid,timestamptz,timestamptz)','execute');
  assert not has_function_privilege('anon','public.record_provider_balance(uuid,jsonb,text)','execute');
  assert has_function_privilege('service_role','public.member_provider_connectors(uuid,date,date)','execute');
  insert into public.user_api_keys(user_id,provider) values(a,'openrouter');
  delete from public.user_api_keys where user_id=a;
  assert not exists (select 1 from public.provider_balance_observations where owner_id=a);
  assert not has_schema_privilege('authenticated','provider_analytics_private','usage');
  assert not has_function_privilege('authenticated','provider_analytics_private.forget_removed_provider_balances()','execute');
  assert (select count(*)=1 from public.provider_balance_observations where owner_id is null);
end $$;

-- A legacy client may still delete its own key under account RLS. The cleanup must
-- work without exposing the server-only observation table to that client.
insert into auth.users(id) values ('d133d133-0000-4444-8888-000000000001');
insert into public.user_api_keys(user_id,provider) values ('d133d133-0000-4444-8888-000000000001','deepseek');
select public.record_provider_balance('d133d133-0000-4444-8888-000000000001','{"provider":"deepseek","status":"reported","checkedAt":1600000001000}',repeat('c',64));
grant select,delete on public.user_api_keys to authenticated;
set role authenticated;
delete from public.user_api_keys where user_id='d133d133-0000-4444-8888-000000000001';
reset role;
do $$ begin assert not exists(select from public.provider_balance_observations where owner_id='d133d133-0000-4444-8888-000000000001'); end $$;
\echo ACCOUNT_PROVIDER_ANALYTICS_OK
