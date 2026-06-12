-- Invite delivery log: one row per (invite, recipient email). Records WHO an invite
-- was emailed to, WHEN (first + last), HOW OFTEN (resends bump send_count), and by
-- which path ('admin' email console, user 'referral', or an automatic 'resend' when
-- an already-invited person tries to register again).
--
-- Why a dedicated table instead of email_log: email_log is a transport audit (it never
-- stores the invite code), so it can't answer "does this email hold a pending invite?"
-- or "which of MY referral invites were accepted?". This table closes that gap and is
-- the backbone for:
--   • the register-intent flow ("you already have access — follow the email instructions"),
--   • the admin invite timeline (sent → joined),
--   • per-user referral stats ("invited X, Y joined").
--
-- Like the other invite tables: service-role only. Emails are stored lowercase so the
-- unique constraint is genuinely case-insensitive.

create table if not exists public.access_invite_sends (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid not null references public.access_invites(id) on delete cascade,
  code text not null,
  to_email text not null,
  -- The admin or referring user who triggered the send (auth.users id; null for system resends).
  sent_by uuid,
  kind text not null default 'admin' check (kind in ('admin', 'referral', 'resend')),
  send_count integer not null default 1,
  first_sent_at timestamptz not null default now(),
  last_sent_at timestamptz not null default now(),
  unique (invite_id, to_email)
);

create index if not exists idx_invite_sends_email on public.access_invite_sends (to_email, last_sent_at desc);
create index if not exists idx_invite_sends_invite on public.access_invite_sends (invite_id);

alter table public.access_invite_sends enable row level security;
-- No client policies → only the service role (server) can read/write.
revoke all on public.access_invite_sends from anon, authenticated;
