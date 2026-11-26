-- token_ledger_entries: an index for the text-rate read (docs/features/pricing.md § Text rates).
--
-- Planning, style directions and translation are quoted from what they really cost: the server reads the newest
-- settled ledger rows whose metadata carries a `textOp` tag (server/src/comic/models/textRates.ts
-- createSupabaseTextRatesDb: entry_type SETTLE / BYOK_SETTLED, created_at in the last 30 days, metadata->textOp not
-- null, newest first, at most 1000), once per 10 minutes per awake server and on each wake. The table's only
-- created_at index leads with user_id, which a read across everyone cannot use, so without this index that read is a
-- sequential scan of the whole ledger; once it outgrows its 5 s timeout the quotes quietly fall back to the constants.
--
-- The index holds only tagged rows (a small share of the ledger), newest first. Its predicate is the one condition
-- the read states as a literal (PostgREST sends the entry types as a parameter, which a partial index predicate
-- cannot be matched against in a generic plan), so the planner can always use it; entry_type is filtered on the few
-- rows it returns. Additive and idempotent: nothing is dropped or rewritten, and the server works the same with or
-- without it (only faster with it).
--
-- Apply AFTER server/sql/token_billing_foundation.sql. On a large ledger, build it without blocking writes instead:
-- run `create index concurrently if not exists …` (the same statement with CONCURRENTLY) on its own, outside a
-- transaction.

do $guard$
begin
  if to_regclass('public.token_ledger_entries') is null then
    raise exception 'token_ledger_text_ops.sql needs public.token_ledger_entries: apply server/sql/token_billing_foundation.sql first';
  end if;
end;
$guard$;

create index if not exists idx_token_ledger_text_ops
  on public.token_ledger_entries (created_at desc)
  where (metadata -> 'textOp') is not null;

comment on index public.idx_token_ledger_text_ops is
  'Text-operation rows of the usage ledger, newest first: the read behind observed planning, style and translation rates (docs/features/pricing.md).';

-- Read-only post-apply checks:
--   select indexname, indexdef from pg_indexes where tablename = 'token_ledger_entries' and indexname = 'idx_token_ledger_text_ops';
--   explain select user_id, provider_cost_usd, metadata, created_at from public.token_ledger_entries
--    where entry_type in ('SETTLE', 'BYOK_SETTLED') and created_at >= now() - interval '30 days'
--      and (metadata -> 'textOp') is not null
--    order by created_at desc limit 1000;
--   -- expect: Index Scan using idx_token_ledger_text_ops
