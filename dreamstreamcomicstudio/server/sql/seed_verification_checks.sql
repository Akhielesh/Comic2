-- Seed the built-in verification checks as DB rows.
--
-- The nightly runner (server/src/jobs/runVerification.ts via .github/workflows/
-- verification.yml) loads ENABLED rows from verification_checks. With none present it
-- falls back to "smoke mode", which runs the built-ins but SKIPS DB persistence — so no
-- findings land in the dashboard and the confirm → auto-fix path never engages. Seeding
-- the built-ins as real rows activates the full pipeline (persisted runs + findings +
-- dashboard + per-check auto-fix toggle).
--
-- Idempotent: only inserts a built-in not already present (matched on config->>'builtin'),
-- so it's safe to re-run and won't disturb checks already configured (e.g. an existing
-- telemetry_failure_spike with auto-fix enabled). New rows default to auto_fix_enabled =
-- false — detection + dashboard only; enable auto-fix per check from the dashboard when
-- you want the pipeline to file GitHub issues.

insert into public.verification_checks (name, description, target_feature, kind, config, enabled, auto_fix_enabled, severity_floor)
select v.builtin, v.description, v.target_feature, 'deterministic',
       jsonb_build_object('builtin', v.builtin), true, false, v.severity_floor
from (values
  ('free_label_integrity',      'free_labeling',        'high',     'Every model labelled "free" in the live catalog is actually free_verified.'),
  ('autorouter_free_invariant', 'autorouter',           'critical', 'Under free-only, the autorouter never returns a non-free model id (or throws clearly).'),
  ('pricing_freshness',         'pricing_freshness',    'med',      'Live pricing catalog is recent and free of REVIEW_REQUIRED rows.'),
  ('cost_reconciliation',       'cost_reconciliation',  'med',      'Persisted estimate per generation is within tolerance of the billed actual.'),
  ('multi_provider_cost',       'multi_provider_cost',  'med',      'NVIDIA models stay free_verified; Pixazo image models with per-image cost are not labelled free.'),
  ('telemetry_failure_spike',   'custom',               'high',     'Recurring user-facing failures captured in telemetry_events exceed a threshold.')
) as v(builtin, target_feature, severity_floor, description)
where not exists (
  select 1 from public.verification_checks c where c.config->>'builtin' = v.builtin
);
