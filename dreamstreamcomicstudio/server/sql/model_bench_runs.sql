-- Model bench run history (persistence for server/src/services/modelBenchRunner.ts).
--
-- Every in-app bench run (admin Models → Bench) is saved here when it finishes, so
-- results survive restarts/redeploys and the UI can list past tests, reopen any of
-- them, and export one run or all runs combined. One row per run; the per-model
-- per-phase records ride along as JSONB (a full ~300-model 3-phase run is ~400KB —
-- fine for a row, and runs are written once, read rarely, never updated row-by-row).

create table if not exists public.model_bench_runs (
  id uuid primary key,
  started_at timestamptz not null,
  finished_at timestamptz,
  state text not null check (state in ('done', 'error')), -- running runs stay in memory only
  options jsonb not null default '{}'::jsonb,
  planned integer not null default 0,
  tested integer not null default 0,
  healthy integer not null default 0,
  spend_usd numeric not null default 0,
  anomaly_count integer not null default 0,
  error text,
  results jsonb not null default '[]'::jsonb,   -- BenchRecord[]
  anomalies jsonb not null default '[]'::jsonb, -- string[]
  created_at timestamptz not null default now()
);

create index if not exists model_bench_runs_started_idx on public.model_bench_runs (started_at desc);

-- Server-only data (admin API reads it through the backend): RLS on with NO
-- policies — anon/authenticated clients can't touch it; the backend uses the
-- service-role key (bypasses RLS).
alter table public.model_bench_runs enable row level security;
revoke all on public.model_bench_runs from anon, authenticated;
