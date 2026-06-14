-- ============================================================================
-- Account Connectors framework — schema (UP migration)
-- ============================================================================
--
-- A user-account connector framework: end users connect THEIR OWN third-party
-- accounts (Gmail, Drive, Calendar, Sheets, YouTube) and shared API-key services
-- (Google Maps, YouTube public data). Normalized data feeds chat context/RAG,
-- structured analysis, and dashboard generation.
--
-- This is DISTINCT from the existing "data connectors" (docs/DATA_CONNECTORS.md),
-- which are operator-keyed data-source APIs (weather/finance/news) wired as chat
-- tools. That system is untouched; this one adds per-user OAuth + API-key
-- account connections. The two never share tables.
--
-- DESIGN PRINCIPLES
--   * Designed up-front for ALL connectors so a new connector needs ZERO schema
--     changes — connector-specific fields live in JSONB `payload`.
--   * Tokens are stored SEPARATELY from connection metadata and ENCRYPTED AT REST
--     (AES-256-GCM via server/src/lib/secureStore.ts). The credentials table is
--     deny-all to clients; only the service role reads it.
--   * Status is modeled with CHECK constraints (project convention — no CREATE TYPE).
--   * Idempotent (CREATE ... IF NOT EXISTS); safe to re-apply. Reversible via
--     account_connectors_down.sql.
--
-- Apply to Supabase project "Comic" (ref bdjfmxfmhqhzvgrhbbzm) via
-- apply_migration (name: account_connectors_framework).
-- ============================================================================

-- Reuse the shared updated_at trigger fn (defined in
-- supabase_auth_profile_migration.sql). Re-declare idempotently so this file can
-- be applied standalone on a fresh project.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 1. connectors — catalog / enablement. Code (the ConnectorRegistry) is the
--    source of truth for which connectors EXIST; this table persists per-connector
--    enablement + admin config and is upserted from code at startup. Not secret;
--    served to clients only through the API, so kept service-role-only.
-- ----------------------------------------------------------------------------
create table if not exists public.connectors (
  id           text primary key,                       -- stable connector id, e.g. 'gmail'
  display_name text not null,
  category     text not null,                           -- 'google_workspace' | 'maps' | 'media' | ...
  auth_type    text not null check (auth_type in ('user_oauth', 'api_key')),
  enabled      boolean not null default true,           -- admin enablement (hide without code change)
  config       jsonb not null default '{}'::jsonb,      -- admin overrides (scopes, defaults)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.connectors enable row level security;
-- Catalog is delivered via the API (server merges code metadata + this row), so no
-- direct client access is required.
revoke all on public.connectors from anon, authenticated;

drop trigger if exists trg_connectors_touch_updated_at on public.connectors;
create trigger trg_connectors_touch_updated_at
before update on public.connectors
for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- 2. user_connections — one row per (user, connector, connected account).
--    Metadata only; NEVER tokens. A user may connect the same connector for
--    several accounts (e.g. two Gmail inboxes), hence the composite uniqueness.
-- ----------------------------------------------------------------------------
create table if not exists public.user_connections (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  connector_id       text not null,
  -- 'connected' | 'disconnected' | 'error' | 'expired' | 'syncing'
  status             text not null default 'connected'
                       check (status in ('connected', 'disconnected', 'error', 'expired', 'syncing')),
  auth_type          text not null check (auth_type in ('user_oauth', 'api_key')),
  account_identifier text not null default '',          -- e.g. the connected Google email; '' for shared api_key
  account_label      text,                              -- friendly display name
  granted_scopes     text[] not null default '{}',
  last_error         text,                              -- surfaced to the reconnect prompt
  metadata           jsonb not null default '{}'::jsonb,
  last_sync_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id, connector_id, account_identifier)
);

create index if not exists user_connections_user_idx
  on public.user_connections (user_id, updated_at desc);
create index if not exists user_connections_connector_idx
  on public.user_connections (connector_id);
create index if not exists user_connections_status_idx
  on public.user_connections (status);
create index if not exists user_connections_user_connector_idx
  on public.user_connections (user_id, connector_id);

alter table public.user_connections enable row level security;
-- Owner-isolated: a user may read their own connections directly (defense in depth);
-- all writes go through the server (service role bypasses RLS).
drop policy if exists user_connections_owner on public.user_connections;
create policy user_connections_owner on public.user_connections
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop trigger if exists trg_user_connections_touch_updated_at on public.user_connections;
create trigger trg_user_connections_touch_updated_at
before update on public.user_connections
for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- 3. connection_credentials — encrypted secrets, stored SEPARATELY from the
--    connection metadata. Deny-all to clients; only the service role reads it.
--    `encrypted_*` columns hold AES-256-GCM ciphertext||authTag (base64) + iv,
--    exactly like user_api_keys / user_settings.
-- ----------------------------------------------------------------------------
create table if not exists public.connection_credentials (
  id                 uuid primary key default gen_random_uuid(),
  connection_id      uuid not null references public.user_connections(id) on delete cascade,
  user_id            uuid not null references auth.users(id) on delete cascade,
  -- 'oauth2' (access/refresh tokens) | 'api_key' (a single shared/user key)
  token_type         text not null default 'oauth2' check (token_type in ('oauth2', 'api_key')),
  encrypted_access   text,                              -- access token OR api key (ciphertext)
  access_iv          text,
  encrypted_refresh  text,                              -- refresh token (ciphertext), oauth only
  refresh_iv         text,
  access_expires_at  timestamptz,                       -- when the access token expires
  scope              text,                              -- space-delimited granted scope
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (connection_id)
);

create index if not exists connection_credentials_user_idx
  on public.connection_credentials (user_id);
create index if not exists connection_credentials_expiry_idx
  on public.connection_credentials (access_expires_at)
  where access_expires_at is not null;

alter table public.connection_credentials enable row level security;
-- Secrets: no client access at all. Service role bypasses RLS.
revoke all on public.connection_credentials from anon, authenticated;

drop trigger if exists trg_connection_credentials_touch_updated_at on public.connection_credentials;
create trigger trg_connection_credentials_touch_updated_at
before update on public.connection_credentials
for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- 4. connector_sync_state — resumable per-connection sync bookkeeping. The
--    `cursor` JSONB carries connector-specific resume tokens (Gmail historyId,
--    Drive pageToken, Calendar syncToken, …) so a sync is idempotent + resumable.
-- ----------------------------------------------------------------------------
create table if not exists public.connector_sync_state (
  id                 uuid primary key default gen_random_uuid(),
  connection_id      uuid not null references public.user_connections(id) on delete cascade,
  user_id            uuid not null references auth.users(id) on delete cascade,
  cursor             jsonb not null default '{}'::jsonb,  -- page token / historyId / syncToken
  -- 'idle' | 'syncing' | 'error' | 'done'
  status             text not null default 'idle' check (status in ('idle', 'syncing', 'error', 'done')),
  last_sync_at       timestamptz,
  last_full_sync_at  timestamptz,
  last_error         text,
  items_synced       integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (connection_id)
);

create index if not exists connector_sync_state_user_idx
  on public.connector_sync_state (user_id);
create index if not exists connector_sync_state_status_idx
  on public.connector_sync_state (status);

alter table public.connector_sync_state enable row level security;
drop policy if exists connector_sync_state_owner on public.connector_sync_state;
create policy connector_sync_state_owner on public.connector_sync_state
  for select using (auth.uid() = user_id);
-- Writes are server-only (service role). No insert/update/delete policy for clients.

drop trigger if exists trg_connector_sync_state_touch_updated_at on public.connector_sync_state;
create trigger trg_connector_sync_state_touch_updated_at
before update on public.connector_sync_state
for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- 5. connector_items — the NORMALIZED store. Hybrid model: typed core columns the
--    three consumers (RAG/analysis/dashboard) actually filter & sort on, plus a
--    JSONB `payload` for connector-specific fields. A new connector adds rows with
--    its own payload shape and needs NO schema change.
--    `kind` is the unified internal model: document | record | event.
-- ----------------------------------------------------------------------------
create table if not exists public.connector_items (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.user_connections(id) on delete cascade,
  connector_id  text not null,
  kind          text not null check (kind in ('document', 'record', 'event')),
  external_id   text not null,                          -- id within the source system
  title         text,
  snippet       text,                                   -- short preview / RAG snippet
  content_text  text,                                   -- fuller text for search (optional)
  url           text,
  author        text,
  occurred_at   timestamptz,                            -- message date / event start / file mtime
  payload       jsonb not null default '{}'::jsonb,     -- connector-specific normalized fields
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (connection_id, kind, external_id)             -- idempotent upsert key
);

create index if not exists connector_items_user_idx
  on public.connector_items (user_id, occurred_at desc nulls last);
create index if not exists connector_items_connection_idx
  on public.connector_items (connection_id, occurred_at desc nulls last);
create index if not exists connector_items_user_kind_idx
  on public.connector_items (user_id, kind, occurred_at desc nulls last);
-- Full-text search for RAG retrieval. to_tsvector(regconfig, ...) is IMMUTABLE, so
-- it can back a GIN expression index (no extension required).
create index if not exists connector_items_fts_idx
  on public.connector_items
  using gin (to_tsvector('english',
    coalesce(title, '') || ' ' || coalesce(snippet, '') || ' ' || coalesce(content_text, '')));

alter table public.connector_items enable row level security;
drop policy if exists connector_items_owner on public.connector_items;
create policy connector_items_owner on public.connector_items
  for select using (auth.uid() = user_id);
-- Writes are server-only (service role); clients read via the scoped retrieval API.

drop trigger if exists trg_connector_items_touch_updated_at on public.connector_items;
create trigger trg_connector_items_touch_updated_at
before update on public.connector_items
for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- 6. connector_oauth_state — transient PKCE + CSRF state for the OAuth handshake.
--    The random `state` nonce is the CSRF token (unguessable, one-time, expiring);
--    the PKCE code_verifier is stored ENCRYPTED and never leaves the server. The
--    callback (a public route — a browser redirect carries no bearer token) looks
--    the row up to recover the originating user_id. Deny-all to clients.
-- ----------------------------------------------------------------------------
create table if not exists public.connector_oauth_state (
  state               text primary key,                 -- random base64url nonce
  user_id             uuid not null references auth.users(id) on delete cascade,
  connector_id        text not null,
  encrypted_verifier  text not null,                    -- PKCE code_verifier (ciphertext)
  verifier_iv         text not null,
  redirect_uri        text not null,
  scopes              text[] not null default '{}',
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null
);

create index if not exists connector_oauth_state_expiry_idx
  on public.connector_oauth_state (expires_at);
create index if not exists connector_oauth_state_user_idx
  on public.connector_oauth_state (user_id);

alter table public.connector_oauth_state enable row level security;
revoke all on public.connector_oauth_state from anon, authenticated;
