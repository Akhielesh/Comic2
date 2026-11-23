-- Apply after token_billing_foundation.sql and provider_usage_log.sql. PostgreSQL 15+.
-- All reads are server-only. NULL owner denotes a platform credential, accessible to operators only.
begin;
create table if not exists public.provider_balance_observations (
  owner_id uuid references auth.users(id) on delete cascade,
  provider text not null,
  credential_binding text not null check (credential_binding ~ '^[0-9a-f]{64}$'),
  day date not null,
  checked_at timestamptz not null,
  report jsonb not null check (jsonb_typeof(report) = 'object' and pg_column_size(report) <= 8192),
  unique nulls not distinct (owner_id, provider, credential_binding, day)
);
alter table public.provider_balance_observations enable row level security;
revoke all on public.provider_balance_observations from public, anon, authenticated;
grant select, insert, update, delete on public.provider_balance_observations to service_role;
create index if not exists provider_balance_read_idx on public.provider_balance_observations(owner_id,provider,credential_binding,checked_at desc);

create or replace function public.record_provider_balance(p_owner uuid,p_report jsonb,p_binding text)
returns void language sql security invoker set search_path = '' as $$
  insert into public.provider_balance_observations(owner_id,provider,credential_binding,day,checked_at,report)
  select p_owner,p_report->>'provider',p_binding,(t at time zone 'UTC')::date,t,p_report
    from (select to_timestamp((p_report->>'checkedAt')::bigint / 1000.0) t) as r
    where p_report->>'status' = 'reported'
  on conflict (owner_id,provider,credential_binding,day) do update set checked_at=excluded.checked_at, report=excluded.report
  where excluded.checked_at > provider_balance_observations.checked_at;
$$;
-- Removing a saved connection forgets its observations in the same transaction.
-- The supported legacy alias may still have a canonical credential after an alias cleanup.
create schema if not exists provider_analytics_private;
revoke all on schema provider_analytics_private from public,anon,authenticated;
-- The trigger needs authority to delete server-only rows when a legacy client deletes
-- its own key through existing account RLS. It accepts no caller arguments and can
-- operate only on OLD from a deletion of this exact table.
create or replace function provider_analytics_private.forget_removed_provider_balances()
returns trigger language plpgsql security definer set search_path = '' as $$
declare canonical text := case when old.provider = 'flux' then 'pixazo' else old.provider end;
begin
  if tg_op <> 'DELETE' or tg_relid <> 'public.user_api_keys'::regclass then
    raise exception 'Unexpected provider credential trigger';
  end if;
  if not exists (select 1 from public.user_api_keys k where k.user_id=old.user_id
    and (k.provider=canonical or (canonical='pixazo' and k.provider='flux'))) then
    delete from public.provider_balance_observations where owner_id=old.user_id and provider=canonical;
  end if;
  return old;
end $$;
-- Older installations can run analytics before installing account-key storage; rerun this
-- idempotent file after installing user_api_keys to attach the deletion trigger.
do $$ begin
  if to_regclass('public.user_api_keys') is not null then
    drop trigger if exists forget_provider_balances on public.user_api_keys;
    create trigger forget_provider_balances after delete on public.user_api_keys
      for each row execute function provider_analytics_private.forget_removed_provider_balances();
  end if;
end $$;
revoke all on function provider_analytics_private.forget_removed_provider_balances() from public,anon,authenticated;
-- Full owner/window aggregation in PostgreSQL avoids PostgREST row limits and cross-account reads.
-- Prefer the settled cost event when both ledgers record the same reservation. Early BYOK
-- settlements and unreserved helper calls only exist in token_ledger_entries.
create or replace function public.member_provider_models(p_owner uuid,p_from timestamptz,p_to timestamptz)
returns table(provider text, byok_requests bigint, platform_requests bigint, estimated_byok_usd numeric, reported_byok_usd numeric, unpriced_byok_requests bigint)
language sql stable security invoker set search_path = '' as $$
  with usage as (
    select g.provider,g.is_byok,g.provider_cost_usd cost,false reported
    from public.generation_cost_events g
    where g.user_id=p_owner and g.created_at>=p_from and g.created_at<p_to
      and g.status in ('SETTLED','BYOK_SETTLED')
    union all
    select l.provider,l.is_byok,l.provider_cost_usd,l.entry_type='USAGE_OBSERVED'
    from public.token_ledger_entries l
    where l.user_id=p_owner and l.created_at>=p_from and l.created_at<p_to
      and l.entry_type in ('SETTLE','BYOK_SETTLED','USAGE_OBSERVED')
      and (l.reservation_id is null or not exists(
        select 1 from public.generation_cost_events g where g.reservation_id=l.reservation_id
          and g.user_id=p_owner and g.status in ('SETTLED','BYOK_SETTLED')))
  )
  select u.provider,count(*) filter (where u.is_byok),count(*) filter (where not u.is_byok),
    sum(u.cost) filter (where u.is_byok and not u.reported and u.cost>=0),
    sum(u.cost) filter (where u.is_byok and u.reported and u.cost>=0),
    count(*) filter (where u.is_byok and (u.cost is null or u.cost<0))
  from usage u group by u.provider;
$$;
create or replace function public.member_provider_connectors(p_owner uuid,p_from date,p_to date)
returns table(provider text,calls bigint,errors bigint,blocked bigint)
language sql stable security invoker set search_path = '' as $$
  select p.provider,sum(p.calls),sum(p.errors),sum(p.blocked) from public.provider_usage_log p
  where p.account_id=p_owner::text and p.day>=p_from and p.day<p_to group by p.provider;
$$;
revoke all on function public.record_provider_balance(uuid,jsonb,text),public.member_provider_models(uuid,timestamptz,timestamptz),public.member_provider_connectors(uuid,date,date) from public,anon,authenticated;
grant execute on function public.record_provider_balance(uuid,jsonb,text),public.member_provider_models(uuid,timestamptz,timestamptz),public.member_provider_connectors(uuid,date,date) to service_role;
grant select on public.generation_cost_events,public.token_ledger_entries,public.provider_usage_log to service_role;
commit;
