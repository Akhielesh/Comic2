-- Verification system tables (Phase 1).
--
-- Powers the self-verifying app: a council of free-only AI agents + deterministic
-- checks audit the catalog, pricing, free/paid labels, autorouter behaviour, and
-- output quality. Findings stored here drive the dashboard (Phase 2) and the
-- Claude-Code auto-resolve bridge (Phase 3).
--
-- Apply via Supabase: `supabase db push` locally, or via the MCP apply_migration tool.
-- Rollback: drop the three tables in reverse FK order (findings, runs, checks).

create extension if not exists pgcrypto;

-- ---------- verification_checks ----------
-- A check is an audit: deterministic or AI-council. Owner-editable.
create table if not exists verification_checks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  -- pricing|free_labeling|autorouter|cost_reconciliation|pricing_freshness|
  -- capability_tags|continuity|moderation|multi_provider_cost|custom
  target_feature text not null,
  kind text not null check (kind in ('deterministic', 'ai_council')),
  -- thresholds, council model ids, prompt template, tolerance, etc.
  config jsonb not null default '{}'::jsonb,
  -- cron expression (e.g. "0 3 * * *") or interval ("PT15M") or null = manual only.
  schedule text,
  enabled boolean not null default true,
  auto_fix_enabled boolean not null default false,
  severity_floor text not null default 'high' check (severity_floor in ('low','med','high','critical')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists verification_checks_enabled_idx on verification_checks (enabled) where enabled = true;
create index if not exists verification_checks_target_idx on verification_checks (target_feature);

-- ---------- verification_runs ----------
-- A single execution of a check.
create table if not exists verification_runs (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references verification_checks(id) on delete cascade,
  trigger text not null check (trigger in ('schedule', 'manual', 'ci', 'webhook')),
  status text not null check (status in ('running', 'passed', 'failed', 'error')),
  summary jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists verification_runs_check_started_idx on verification_runs (check_id, started_at desc);
create index if not exists verification_runs_status_idx on verification_runs (status);

-- ---------- verification_findings ----------
-- One finding = one actionable problem. Fingerprint dedupes "the same bug filed twice".
create table if not exists verification_findings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references verification_runs(id) on delete cascade,
  check_id uuid not null references verification_checks(id) on delete cascade,
  fingerprint text not null,
  title text not null,
  detail jsonb not null,
  severity text not null check (severity in ('low','med','high','critical')),
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  council_votes jsonb,
  status text not null default 'open' check (
    status in ('open','confirmed','dismissed','fixing','resolved','wontfix')
  ),
  github_issue_number int,
  github_pr_number int,
  fix_attempts int not null default 0,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Dedupe: there can only be ONE non-terminal finding per fingerprint. Closed/resolved/
-- dismissed/wontfix findings stick around for history but don't block new opens.
create unique index if not exists verification_findings_open_fp_uidx
  on verification_findings (fingerprint)
  where status in ('open','confirmed','fixing');

create index if not exists verification_findings_check_idx on verification_findings (check_id);
create index if not exists verification_findings_status_idx on verification_findings (status);
create index if not exists verification_findings_severity_idx on verification_findings (severity);

-- RLS: admin/service-role only. Findings can contain sensitive details about the live
-- system; we do not surface them to end users.
alter table verification_checks enable row level security;
alter table verification_runs enable row level security;
alter table verification_findings enable row level security;

-- (Policies intentionally omitted: only the service role bypasses RLS by default, which
-- means the verification system service has full access and end users cannot read or
-- write these tables. Add policies later if/when an admin-tier UI is implemented over
-- the user-facing auth flow.)

-- Updated-at trigger for verification_checks.
create or replace function verification_checks_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_verification_checks_updated_at on verification_checks;
create trigger trg_verification_checks_updated_at
  before update on verification_checks
  for each row execute function verification_checks_set_updated_at();

-- Helpful seed values (commented out — uncomment to bootstrap in non-prod):
-- insert into verification_checks (name, description, target_feature, kind, schedule, enabled, severity_floor)
-- values
--   ('Free label integrity', 'Every "free"-labelled model is genuinely free (not token-billed).',
--    'free_labeling', 'deterministic', '0 3 * * *', true, 'high'),
--   ('Autorouter free invariant', 'Free-only routing never returns a non-free id against the live catalog.',
--    'autorouter', 'deterministic', '0 3 * * *', true, 'critical'),
--   ('Pricing freshness', 'model_pricing_snapshots is < 24h and no REVIEW_REQUIRED rows linger.',
--    'pricing_freshness', 'deterministic', '0 3 * * *', true, 'med'),
--   ('Cost reconciliation', 'Persisted estimate ~ billed actual (within tolerance).',
--    'cost_reconciliation', 'deterministic', '0 4 * * *', true, 'med');
