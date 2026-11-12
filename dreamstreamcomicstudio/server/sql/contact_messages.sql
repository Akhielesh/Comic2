-- Settings › Contact messages (CONTACT-1).
--
-- One row per message a signed-in person sends from Settings › Contact. The browser NEVER touches this
-- table: it POSTs to the authenticated, rate-limited /api/contact route (server/src/routes/contact.ts),
-- and the server writes the row with the service role (server/src/services/contactStore.ts). Admins read
-- it through GET /api/admin/contact-messages (Settings › Admin › Analytics › Contact) and mark a message
-- handled through POST /api/admin/contact-messages/:id/handled.
--
-- Access, on the user_feedback pattern (server/sql/telemetry_feedback.sql) and the N4 migration rule
-- (docs/infrastructure/SECURITY_FINDINGS.md):
--   * RLS ON with NO policies: anon and authenticated can neither read nor write a row;
--   * every client privilege revoked (Supabase grants anon / authenticated full privileges on new tables
--     in public by default), so a policy added by mistake still exposes nothing;
--   * the service role (the server, the Supabase dashboard) reads and writes.
--
-- Additive and idempotent: safe to re-run; nothing is dropped or rewritten. Apply BEFORE the server deploy
-- that ships /api/contact (until it is applied, every send answers 503 and nothing is stored).
-- Inspect first:
--   select column_name, data_type from information_schema.columns where table_name = 'contact_messages';

do $guard$
begin
  if to_regclass('auth.users') is null then
    raise exception 'contact_messages.sql needs auth.users (apply on the Supabase project, not a bare Postgres)';
  end if;
end;
$guard$;

-- ── 1. Table ─────────────────────────────────────────────────────────────────────────────────

create table if not exists public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The reply-to address the person typed (it may differ from their sign-in address).
  email text not null check (char_length(email) between 3 and 320),
  message text not null check (char_length(message) between 1 and 5000),
  created_at timestamptz not null default now(),
  -- Set by an admin once the message has been answered; null = still open.
  handled_at timestamptz
);

-- Newest first for the admin reader; (user_id, created_at) for a person's own history and account deletion.
create index if not exists contact_messages_created_idx on public.contact_messages (created_at desc);
create index if not exists contact_messages_user_created_idx on public.contact_messages (user_id, created_at desc);

-- ── 2. Access: service role only ─────────────────────────────────────────────────────────────

alter table public.contact_messages enable row level security;

-- Intentionally NO select / insert / update / delete policy for anon or authenticated.
revoke all on table public.contact_messages from public, anon, authenticated;
grant select, insert, update, delete on table public.contact_messages to service_role;
