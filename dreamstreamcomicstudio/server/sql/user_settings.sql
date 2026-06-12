-- The per-account settings snapshot (preferences + per-studio settings + chat
-- personalization). One row per user; the payload is a single encrypted blob.
--
-- HISTORY: this table predates this file (it was created out-of-band, which is why
-- cloud sync silently failed on fresh environments — nothing defined it). The
-- snapshot used to be encrypted in the BROWSER with a hardcoded secret shipped in
-- the public bundle (services/crypto.ts), and the client read/wrote rows directly.
-- Both are replaced: the server now encrypts with a server-only secret
-- (server/src/lib/secureStore.ts) and is the only reader/writer, via
-- GET/PUT /api/account/settings. Legacy client-encrypted rows are decrypted once on
-- read and re-encrypted server-side on the next write.

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  encrypted_data text not null,
  iv text not null,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

-- Owner-only policy kept for any straggler clients deployed before the server-side
-- move; new clients never touch the table directly.
drop policy if exists user_settings_owner on public.user_settings;
create policy user_settings_owner on public.user_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- HARDENING — APPLIED 2026-06-12 (migration
-- harden_user_settings_and_user_api_keys_revoke_client_access): the service role
-- bypasses RLS and remains the only reader/writer, so direct client access was
-- revoked entirely, like harden_user_api_keys.sql did for key writes. The same
-- migration also revoked SELECT on user_api_keys (rows are ciphertext; this just
-- removes the table from the anon/authenticated GraphQL schema).
--
--   revoke select, insert, update, delete on public.user_settings from anon, authenticated;
--   revoke select on public.user_api_keys from anon, authenticated;
