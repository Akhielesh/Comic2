-- Public model catalog cache (harvest + platform-key refresh).
--
-- Why: the OpenRouter model list is public, but NVIDIA Build's /models requires an
-- authenticated call. To show NVIDIA (and any future auth-gated source) on the PUBLIC,
-- logged-out models page, we cache the PUBLIC model metadata returned by any successful
-- authenticated fetch — a platform key (scheduled refresh) or a logged-in user's BYOK key.
--
-- We never store the API key. Only the public model metadata (the same data on
-- build.nvidia.com / openrouter.ai) is cached. Listing models costs no generation credits.
--
-- Access: server-only via the service role (the public page hits our API, not the DB
-- directly), so RLS is enabled with NO anon/public policies = deny-all for anon; the
-- service role bypasses RLS.

create table if not exists public.model_catalog_cache (
  source                 text        not null,
  model_id               text        not null,
  payload                jsonb       not null,
  supports_image_output  boolean     not null default false,
  is_free                boolean     not null default false,
  last_seen_at           timestamptz not null default now(),
  primary key (source, model_id)
);

create index if not exists idx_model_catalog_cache_source on public.model_catalog_cache (source);
create index if not exists idx_model_catalog_cache_last_seen on public.model_catalog_cache (last_seen_at);

alter table public.model_catalog_cache enable row level security;
-- Intentionally no policies: anon/authenticated have no direct access; the service role
-- (server) bypasses RLS and is the only reader/writer.
