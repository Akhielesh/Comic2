-- Platform audit log (Epic F0). Append-only record of sensitive admin/security actions
-- (kill-switch toggles, checkpoint resolutions, role changes, deletes…). Service-role writes;
-- RLS on with NO select policy, so it's readable only via a trusted (admin) service-role path —
-- never by normal clients. Additive + non-destructive.

create table if not exists public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid,                 -- who did it (auth.users) — null for system actions
  action      text not null,        -- e.g. 'ventures.kill', 'ventures.checkpoint.resolve'
  target_type text,                 -- e.g. 'venture' | 'checkpoint'
  target_id   text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_log_actor_idx on public.audit_log (actor_id, created_at);
create index if not exists audit_log_action_idx on public.audit_log (action, created_at);

alter table public.audit_log enable row level security;
-- No SELECT/INSERT policy on purpose: only the service role (admin endpoints) reads/writes it.
