-- ============================================================================
-- Account Connectors framework — REVERSIBLE DOWN migration
-- ============================================================================
--
-- Drops everything account_connectors.sql created, in FK-safe order. Idempotent
-- (IF EXISTS). The shared touch_updated_at() function is left in place because it
-- is used by other tables (profiles, recipes, …) — only the triggers we added are
-- removed implicitly by dropping their tables.
--
-- WARNING: dropping these tables deletes all stored connections, encrypted tokens,
-- sync cursors and normalized items. Users will have to reconnect. Run only to
-- fully roll the feature back.
-- ============================================================================

drop table if exists public.connector_items cascade;
drop table if exists public.connector_sync_state cascade;
drop table if exists public.connector_oauth_state cascade;
drop table if exists public.connection_credentials cascade;
drop table if exists public.user_connections cascade;
drop table if exists public.connectors cascade;
