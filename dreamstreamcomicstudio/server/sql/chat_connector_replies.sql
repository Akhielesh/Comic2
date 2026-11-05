-- Connected-account privacy (Google Limited Use), finding C1a in docs/infrastructure/SECURITY_FINDINGS.md.
--
-- The chat client sends its history back as plain text, so a reply that was answered from the user's
-- Gmail, Drive or Calendar cannot be told apart when it comes back. The backend records a SHA-256 of
-- every reply that actually carried connected-account content (server/src/ai/privacy/replyProvenance.ts)
-- and recognises it in later history, so a later turn on a free model is refused instead of sending that
-- content to a free endpoint.
--
--   * Only the hash of the normalised reply text is stored, never the text.
--   * Service role only: RLS on with no policy, every client privilege revoked. The backend scopes every
--     read and write by the authenticated user's id.
--   * Bounded: record_chat_connector_reply keeps the newest p_keep rows per user (default 2,000) and
--     drops rows older than p_ttl_days (default 365) for that user on every write.
--   * Idempotent: safe to apply twice.

create table if not exists public.chat_connector_replies (
  user_id uuid not null references auth.users (id) on delete cascade,
  reply_hash text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, reply_hash),
  constraint chat_connector_replies_hash_hex check (reply_hash ~ '^[0-9a-f]{64}$')
);

create index if not exists chat_connector_replies_user_recent_idx
  on public.chat_connector_replies (user_id, created_at desc);

alter table public.chat_connector_replies enable row level security;
revoke all on table public.chat_connector_replies from public, anon, authenticated;
grant select, insert, update, delete on table public.chat_connector_replies to service_role;

-- Record one reply hash for a user (refreshing its time when it is already known) and prune that
-- user's rows to the newest p_keep, dropping anything older than p_ttl_days.
create or replace function public.record_chat_connector_reply(
  p_user_id uuid,
  p_reply_hash text,
  p_keep int default 2000,
  p_ttl_days int default 365
) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_user_id is null or p_reply_hash is null or p_reply_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'record_chat_connector_reply: a user id and a 64-character hex hash are required';
  end if;

  insert into public.chat_connector_replies (user_id, reply_hash)
  values (p_user_id, p_reply_hash)
  on conflict (user_id, reply_hash) do update set created_at = now();

  delete from public.chat_connector_replies r
   where r.user_id = p_user_id
     and (
       r.created_at < now() - make_interval(days => greatest(coalesce(p_ttl_days, 365), 1))
       or r.reply_hash in (
         select k.reply_hash
           from public.chat_connector_replies k
          where k.user_id = p_user_id
          order by k.created_at desc, k.reply_hash
         offset greatest(coalesce(p_keep, 2000), 1)
       )
     );
end;
$$;

revoke all on function public.record_chat_connector_reply(uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.record_chat_connector_reply(uuid, text, int, int) to service_role;

-- Verify after applying:
--    select relrowsecurity from pg_class where relname = 'chat_connector_replies';                      -- true
--    select grantee, privilege_type from information_schema.role_table_grants
--     where table_name = 'chat_connector_replies' and grantee in ('anon', 'authenticated');           -- no rows
--    select has_function_privilege('authenticated', 'public.record_chat_connector_reply(uuid,text,int,int)', 'execute'); -- false
