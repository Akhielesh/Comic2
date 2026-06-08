-- Telemetry + feedback capture.
--
-- Powers product observability and the feedback loop the team uses to refine the
-- AI Chat / Code Studio / Comic systems:
--   * telemetry_events — failed chats, client/server errors, app crashes, and
--     informative logs, each stamped with WHEN (created_at + client_ts), WHERE
--     (source + surface) and WHAT (metadata jsonb) so a flow can be reconstructed.
--   * user_feedback — explicit signals: like/dislike on a response or an error,
--     plus general platform feedback (category + sentiment + free-text comment),
--     including the disappointment the Universal Assistant auto-captures.
--
-- The client NEVER writes these tables directly. It POSTs to /api/telemetry, and
-- the SERVER persists with the service role after enriching each row with a server
-- timestamp, request id, ip and user agent. So, exactly like waitlist_signups,
-- these are write-only-by-service-role: RLS is enabled with NO anon/authenticated
-- policies and table privileges are revoked, leaving reads/writes to the service
-- role (server + Supabase dashboard / admin analytics) only. A visitor must never
-- be able to read back everyone else's errors or feedback.

create table if not exists public.telemetry_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  -- Groups a single flow (chat session id, or a per-tab client session id).
  session_id text,
  -- Coarse category: 'error' | 'chat_failed' | 'app_crash' | 'unhandled_rejection' | 'log' | …
  event_type text not null,
  severity text not null default 'info'
    check (severity in ('debug', 'info', 'warn', 'error', 'critical')),
  -- Product surface the signal came from: 'ai_chat' | 'code_studio' | 'universal_assistant' | …
  source text not null default 'unknown',
  -- App view / route, e.g. 'dashboard' or '/chat'.
  surface text,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  request_id text,
  ip text,
  user_agent text,
  -- When the event happened on the client (the server receive time is created_at).
  client_ts timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_telemetry_created on public.telemetry_events (created_at desc);
create index if not exists idx_telemetry_user on public.telemetry_events (user_id, created_at desc);
create index if not exists idx_telemetry_type on public.telemetry_events (event_type, created_at desc);
create index if not exists idx_telemetry_session on public.telemetry_events (session_id, created_at desc);
-- Fast "show me everything that failed" scans for the analytics/triage view.
create index if not exists idx_telemetry_failures on public.telemetry_events (created_at desc)
  where severity in ('error', 'critical');

create table if not exists public.user_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  session_id text,
  -- What is being rated: 'chat_response' | 'universal_assistant' | 'error' | 'app_crash' | 'studio' | 'platform'.
  target_type text not null,
  -- Id of the rated thing (message id, error id, …) when applicable.
  target_id text,
  vote text check (vote in ('like', 'dislike')),
  -- General-feedback category, e.g. 'AI response quality'.
  category text,
  sentiment text check (sentiment in ('positive', 'neutral', 'negative', 'frustrated')),
  comment text,
  source text not null default 'unknown',
  surface text,
  metadata jsonb not null default '{}'::jsonb,
  request_id text,
  ip text,
  user_agent text,
  client_ts timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_feedback_created on public.user_feedback (created_at desc);
create index if not exists idx_feedback_user on public.user_feedback (user_id, created_at desc);
create index if not exists idx_feedback_target on public.user_feedback (target_type, created_at desc);
-- Dislikes are the highest-signal rows for "what to fix next" — index them tightly.
create index if not exists idx_feedback_dislikes on public.user_feedback (created_at desc)
  where vote = 'dislike';

alter table public.telemetry_events enable row level security;
alter table public.user_feedback enable row level security;

-- Intentionally NO select/insert/update/delete policy for anon/authenticated:
-- only the service role (which bypasses RLS) may read or write. Revoke client
-- privileges as defense-in-depth on top of RLS so a misconfigured policy can
-- never expose the collected logs/feedback to other users.
revoke all on public.telemetry_events from anon, authenticated;
revoke all on public.user_feedback from anon, authenticated;
