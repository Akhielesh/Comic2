-- telemetry_mask_capability_paths (gate finding S19, 2026-10-23)
--
-- An unlisted share slug (/c/<slug>, /api/comic/public/s/<slug>) and a classic share token
-- (/share/<token>, /api/shares/token/<token>) are READ CAPABILITIES. Until this release the client
-- telemetry `surface` (window.location.pathname) and the server_error path were stored raw, so rows
-- in telemetry_events / user_feedback can hold them (no retention purge; visible in the Admin
-- console). The backend now masks them on the way in (shared/capabilityPath.ts loggablePath, used
-- by server/src/services/telemetryStore.ts); this one-off scrub applies the same rules to the rows
-- already stored:
--   1. drop any query string / #fragment;
--   2. /c/<x> → /c/:slug, /api/comic/public/s/<x> → /api/comic/public/s/:slug (case-insensitive);
--   3. /share/<x> → /share/:token, /api/shares/token/<x> → /api/shares/token/:token;
--   4. inside `message` (telemetry_events) and `metadata` (both tables): the slug / token segment
--      of an absolute capability URL (an error's filename / stack frame can be the page URL).
-- An absolute URL keeps its origin. Ordinary paths (project ids, 'ai_chat' …) are untouched.
--
-- Idempotent: masked values start with ':' after the prefix, which the WHERE clauses exclude, and a
-- value without '?'/'#' is not touched by step 1. Guarded: a missing table or column is skipped.
-- No schema change. PROD STEP: apply AFTER the backend that masks on write is live (so no raw row
-- arrives after the scrub).

do $$
declare
  t text;
begin
  foreach t in array array['telemetry_events', 'user_feedback'] loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = t and column_name = 'surface'
    ) then
      continue;
    end if;

    -- 1. No query string or fragment (newsletter ?t=, OAuth ?code=, …).
    execute format(
      $sql$update public.%I set surface = split_part(split_part(surface, '?', 1), '#', 1)
            where surface ~ '[?#]'$sql$, t);

    -- 2. Share slugs.
    execute format(
      $sql$update public.%I
              set surface = regexp_replace(surface, '^(https?://[^/?#]*)?/+api/+comic/+public/+s/+[^/]+', '\1/api/comic/public/s/:slug', 'i')
            where surface ~* '^(https?://[^/?#]*)?/+api/+comic/+public/+s/+[^/:]'$sql$, t);
    execute format(
      $sql$update public.%I
              set surface = regexp_replace(surface, '^(https?://[^/?#]*)?/+c/+[^/]+', '\1/c/:slug', 'i')
            where surface ~* '^(https?://[^/?#]*)?/+c/+[^/:]'$sql$, t);

    -- 3. Classic share tokens.
    execute format(
      $sql$update public.%I
              set surface = regexp_replace(surface, '^(https?://[^/?#]*)?/+api/+shares/+token/+[^/]+', '\1/api/shares/token/:token', 'i')
            where surface ~* '^(https?://[^/?#]*)?/+api/+shares/+token/+[^/:]'$sql$, t);
    execute format(
      $sql$update public.%I
              set surface = regexp_replace(surface, '^(https?://[^/?#]*)?/+share/+[^/]+', '\1/share/:token', 'i')
            where surface ~* '^(https?://[^/?#]*)?/+share/+[^/:]'$sql$, t);
    -- 4. Capability URLs inside the free text the client sent: an error thrown by an inline or
    --    extension-injected script reports the PAGE URL (https://…/c/<slug>…) as its filename and
    --    stack frame, and some browser messages quote it. The backend masks these on write now
    --    (maskCapabilityUrls); stored rows get the slug / token segment of such URLs masked in
    --    `message` and anywhere in `metadata`. The match never contains a quote or a backslash, so
    --    it stays inside one JSON string and the jsonb stays valid. Everything else is untouched.
    if exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = t and column_name = 'message' and data_type = 'text'
    ) then
      execute format(
        $sql$update public.%I
                set message = regexp_replace(message, '(https?://[^/[:space:]"''\\<>()]+)/+(c|api/+comic/+public/+s)/+[^/:?#[:space:]"''\\<>()]+', '\1/\2/:slug', 'gi')
              where message ~* '(https?://[^/[:space:]"''\\<>()]+)/+(c|api/+comic/+public/+s)/+[^/:?#[:space:]"''\\<>()]'$sql$, t);
      execute format(
        $sql$update public.%I
                set message = regexp_replace(message, '(https?://[^/[:space:]"''\\<>()]+)/+(share|api/+shares/+token)/+[^/:?#[:space:]"''\\<>()]+', '\1/\2/:token', 'gi')
              where message ~* '(https?://[^/[:space:]"''\\<>()]+)/+(share|api/+shares/+token)/+[^/:?#[:space:]"''\\<>()]'$sql$, t);
    end if;
    if exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = t and column_name = 'metadata' and data_type = 'jsonb'
    ) then
      execute format(
        $sql$update public.%I
                set metadata = regexp_replace(metadata::text, '(https?://[^/[:space:]"''\\<>()]+)/+(c|api/+comic/+public/+s)/+[^/:?#[:space:]"''\\<>()]+', '\1/\2/:slug', 'gi')::jsonb
              where metadata::text ~* '(https?://[^/[:space:]"''\\<>()]+)/+(c|api/+comic/+public/+s)/+[^/:?#[:space:]"''\\<>()]'$sql$, t);
      execute format(
        $sql$update public.%I
                set metadata = regexp_replace(metadata::text, '(https?://[^/[:space:]"''\\<>()]+)/+(share|api/+shares/+token)/+[^/:?#[:space:]"''\\<>()]+', '\1/\2/:token', 'gi')::jsonb
              where metadata::text ~* '(https?://[^/[:space:]"''\\<>()]+)/+(share|api/+shares/+token)/+[^/:?#[:space:]"''\\<>()]'$sql$, t);
    end if;
  end loop;
end
$$;
