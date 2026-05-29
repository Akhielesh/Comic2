-- Security fix (applied 2026-05-29): close anon-key exposure on admin tables.
--
-- These 4 public tables had RLS disabled, so anyone holding the public anon key
-- (shipped in the browser bundle) could read/write them — most critically
-- user_roles (privilege escalation) and user_moderation_status (ban evasion).
--
-- They are only accessed server-side via the Supabase service role, which
-- bypasses RLS. Verified there are no client references and no SQL functions
-- (SECURITY DEFINER or INVOKER) that touch them, so enabling RLS with no
-- policies (deny-all to anon/authenticated) closes the hole with zero
-- functional impact. The service role continues to have full access.
--
-- Idempotent.
alter table public.billing_plan_entitlements   enable row level security;
alter table public.user_roles                  enable row level security;
alter table public.user_moderation_status      enable row level security;
alter table public.project_moderation_actions  enable row level security;
