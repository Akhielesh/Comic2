-- My comics' listing copy on comic_docs (docs/features/my-comics.md §1).
--
-- APPLY TO: Supabase project "Comic" — via the Supabase MCP `apply_migration` (name: comic_docs_listing) or the SQL
-- editor. Additive and idempotent: safe to re-run. The app works before and after it: until the column exists, My
-- comics reads the same values from paths inside `doc` (services/comicWorkspaceActivity.ts STAGE_DOC_SELECT).
--
-- Why: any jsonb operator on a stored `doc` (docs run to several MB, DOC_LIMITS.docBytesMax) fetches and decompresses
-- the whole document, once per path. My comics reads every comic's stage and "Needs you" in one list read, so reading
-- them from `doc` decompressed each of the account's comics several times on every open. `listing` is a small copy
-- (well under 1 kB, stored in the row itself) of what that read needs, kept in step with `doc` by a trigger:
--   activity   doc -> 'workspaceActivity': the summary the server writes on every save (shared/comic/workspaceActivity.ts:
--              coarse keys and counts only);
--   gate, plan, draft, lastCard
--              the four scalars the list reads "Needs you" from in a doc saved before summaries existed.
-- No text, prices, prompts or paths. The owner reads it through the existing comic_docs select policy; only the trigger
-- writes it (clients have no write grants on comic_docs).
--
-- The backfill at the end rewrites every row once (row locks only, no table lock). On a very large table, run it in a
-- quiet moment; re-running it touches only rows still without a listing.

alter table public.comic_docs add column if not exists listing jsonb;

-- Every insert and update derives the listing from the doc being written, so it never drifts from it (a value passed for
-- `listing` itself is replaced). JSON nulls for the paths a doc does not have. A trigger runs whoever writes, so no API
-- role needs (or gets) to call this.
create or replace function public.comic_docs_keep_listing()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.listing := jsonb_build_object(
    'activity', new.doc -> 'workspaceActivity',
    'gate', new.doc -> 'gate' ->> 'status',
    'plan', new.doc ->> 'planStatus',
    'draft', new.doc -> 'directorDraft' ->> 'status',
    'lastCard', new.doc -> 'conversation' -> -1 -> 'cards' -> 0 ->> 'type'
  );
  return new;
end;
$$;

revoke all on function public.comic_docs_keep_listing() from public, anon, authenticated;

drop trigger if exists comic_docs_keep_listing on public.comic_docs;
create trigger comic_docs_keep_listing
  before insert or update on public.comic_docs
  for each row execute function public.comic_docs_keep_listing();

-- Rows written before this file: rewriting a row runs the trigger, which fills its listing (the doc's stored bytes are
-- kept as they are, and `updated_at` is left alone, so the list's order holds).
update public.comic_docs set doc = doc where listing is null;
