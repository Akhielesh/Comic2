-- Verification system tables.
--
-- The verification/auto-fix system (server/src/verification/*, server/src/jobs/
-- runVerification.ts, /api/admin/verification routes) reads/writes these three
-- tables, but they were never created in the DB — so the Admin → Verification
-- Center 500'd ("Could not find the table 'public.verification_checks'") and the
-- telemetry_failure_spike auto-fix check couldn't run. This creates them to match
-- exactly what the code expects (runner.ts, findingsTypes.ts, routes/verification.ts).
--
-- Admin-only: accessed through the service role behind requireAdmin, so RLS is on
-- with NO anon/authenticated policies (service role bypasses RLS).

create table if not exists public.verification_checks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  target_feature text not null,
  kind text not null check (kind in ('deterministic', 'ai_council')),
  config jsonb not null default '{}'::jsonb,
  schedule text,
  enabled boolean not null default true,
  auto_fix_enabled boolean not null default false,
  severity_floor text not null default 'high' check (severity_floor in ('low', 'med', 'high', 'critical')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_verification_checks_enabled on public.verification_checks (enabled);

create table if not exists public.verification_runs (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references public.verification_checks(id) on delete cascade,
  trigger text not null check (trigger in ('schedule', 'manual', 'ci', 'webhook')),
  status text not null default 'running' check (status in ('running', 'passed', 'failed', 'error')),
  summary jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists idx_verification_runs_check on public.verification_runs (check_id, started_at desc);
create index if not exists idx_verification_runs_started on public.verification_runs (started_at desc);

create table if not exists public.verification_findings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.verification_runs(id) on delete cascade,
  check_id uuid not null references public.verification_checks(id) on delete cascade,
  fingerprint text not null,
  title text not null,
  detail jsonb not null default '{}'::jsonb,
  severity text not null check (severity in ('low', 'med', 'high', 'critical')),
  confidence numeric not null default 1,
  council_votes jsonb,
  status text not null default 'open'
    check (status in ('open', 'confirmed', 'dismissed', 'fixing', 'resolved', 'wontfix')),
  github_issue_number integer,
  github_pr_number integer,
  fix_attempts integer not null default 0,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists idx_verification_findings_status on public.verification_findings (status, created_at desc);
create index if not exists idx_verification_findings_check on public.verification_findings (check_id, created_at desc);
-- Anti-spam dedup: at most one ACTIVE finding per fingerprint (runner.ts relies on this).
create unique index if not exists idx_verification_findings_active_fingerprint
  on public.verification_findings (fingerprint)
  where status in ('open', 'confirmed', 'fixing');

alter table public.verification_checks enable row level security;
alter table public.verification_runs enable row level security;
alter table public.verification_findings enable row level security;

revoke all on public.verification_checks from anon, authenticated;
revoke all on public.verification_runs from anon, authenticated;
revoke all on public.verification_findings from anon, authenticated;
