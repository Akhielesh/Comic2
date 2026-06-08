-- Transactional email system: a send LOG (observability + hard-cap accounting), a marketing
-- SUPPRESSION list (the working unsubscribe), and newsletter DOUBLE OPT-IN columns on the
-- existing waitlist table. Apply after server/sql/waitlist_signups.sql.
--
-- Like the waitlist table, these are service-role only: anon/authenticated get NO access, so
-- the collected addresses + delivery metadata can never be read or enumerated from the client.

-- 1) Send log — one row per send ATTEMPT. The mailer writes it 'queued' then patches the
--    outcome. Drives the cost guardrail (count of status='sent' this day/month) and the
--    read-receipt pixel (opened_at).
create table if not exists public.email_log (
  id uuid primary key default gen_random_uuid(),
  to_email text not null,
  template text not null,
  kind text not null default 'essential' check (kind in ('essential', 'marketing')),
  status text not null default 'queued'
    check (status in ('queued', 'sent', 'failed', 'suppressed', 'rate_limited', 'skipped')),
  message_id text,
  error text,
  user_id uuid,
  request_id text,
  opened_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_email_log_created on public.email_log (created_at desc);
create index if not exists idx_email_log_to on public.email_log (lower(to_email), created_at desc);
create index if not exists idx_email_log_sent on public.email_log (status, created_at desc);

alter table public.email_log enable row level security;
-- No client policies → only the service role (server) can read/write. Defense-in-depth:
revoke all on public.email_log from anon, authenticated;

-- 2) Marketing suppression list. The mailer refuses to send 'marketing' mail to any address
--    here; ESSENTIAL (account/security/transactional) mail intentionally ignores it.
create table if not exists public.email_suppressions (
  email text not null,
  scope text not null default 'marketing' check (scope in ('marketing', 'all')),
  reason text,
  created_at timestamptz not null default now(),
  primary key (email, scope)
);

alter table public.email_suppressions enable row level security;
revoke all on public.email_suppressions from anon, authenticated;

-- 3) Newsletter double opt-in, layered onto the existing write-only waitlist table.
--    A subscribe sets confirm_token + confirmed=false and emails the confirm link; clicking
--    it flips confirmed=true and clears the token. Unsubscribe stamps unsubscribed_at.
alter table public.waitlist_signups
  add column if not exists confirmed boolean not null default false,
  add column if not exists confirm_token text,
  add column if not exists confirmed_at timestamptz,
  add column if not exists unsubscribed_at timestamptz;
