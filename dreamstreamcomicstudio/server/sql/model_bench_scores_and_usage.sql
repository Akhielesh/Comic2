-- DRS Benchmark Scores + privacy-first monthly model-usage analytics +
-- the researcher role.
--
-- model_bench_scores: one row per (source, model), overwritten by each finished
-- bench run — public, non-sensitive reference data (scores, per-phase pass/fail,
-- timings; never raw provider error bodies).
--
-- model_usage_monthly: aggregate counters per (month, product, source, model).
-- Privacy-first by construction: no user ids, no sessions, nothing finer than
-- the month bucket ('YYYY-MM'). Bumped only by the server-side function below.

-- Researcher/analyst role: may run benches and build reports, not full admin.
alter table public.user_roles drop constraint if exists user_roles_role_check;
alter table public.user_roles
  add constraint user_roles_role_check check (role in ('admin', 'moderator', 'researcher'));

create table if not exists public.model_bench_scores (
  source text not null,
  model text not null,
  run_id uuid not null,
  score numeric(5,1) not null,
  phases jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  primary key (source, model)
);

alter table public.model_bench_scores enable row level security;
drop policy if exists model_bench_scores_public_read on public.model_bench_scores;
create policy model_bench_scores_public_read on public.model_bench_scores
  for select using (true);
-- Writes: service role only (no insert/update/delete policies).

create table if not exists public.model_usage_monthly (
  month text not null,            -- 'YYYY-MM'
  product text not null,          -- chat_studio | stream_studio | comic_studio
  source text not null,
  model text not null,
  requests bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (month, product, source, model)
);

alter table public.model_usage_monthly enable row level security;
drop policy if exists model_usage_monthly_public_read on public.model_usage_monthly;
create policy model_usage_monthly_public_read on public.model_usage_monthly
  for select using (true);

-- Server-only counter bump (service role). Revoked from clients so nobody can
-- inflate counts from the browser.
create or replace function public.bump_model_usage(
  p_month text, p_product text, p_source text, p_model text
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.model_usage_monthly (month, product, source, model, requests)
  values (p_month, p_product, p_source, p_model, 1)
  on conflict (month, product, source, model) do update
    set requests = public.model_usage_monthly.requests + 1,
        updated_at = now();
$$;

revoke execute on function public.bump_model_usage(text, text, text, text) from anon, authenticated;
