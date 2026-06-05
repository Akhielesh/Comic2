-- Waitlist / early-access + product-updates email capture.
--
-- Powers two public, logged-out flows on the marketing site:
--   * kind = 'updates' — "Want to stay updated?" newsletter capture.
--   * kind = 'access'  — "Request access" while new signups are invite-only.
--
-- Anyone (anon or authenticated) may add THEIR email to the list, but nobody
-- except the service role / admins can read it back — a visitor must never be
-- able to enumerate everyone who joined. We rely on the absence of a SELECT
-- policy to block reads under RLS.

create table if not exists public.waitlist_signups (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  kind text not null default 'updates' check (kind in ('updates', 'access')),
  source text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- One row per email per intent. A repeat submit surfaces as a unique violation
-- (23505) that the client treats as "already on the list".
create unique index if not exists idx_waitlist_email_kind
  on public.waitlist_signups (lower(email), kind);
create index if not exists idx_waitlist_created
  on public.waitlist_signups (created_at desc);

alter table public.waitlist_signups enable row level security;

-- Public, write-only insert. The CHECK constraint keeps junk out of the table
-- (basic shape + length) even though it ultimately lands server-side.
drop policy if exists waitlist_public_insert on public.waitlist_signups;
create policy waitlist_public_insert on public.waitlist_signups
  for insert to anon, authenticated
  with check (
    email is not null
    and char_length(email) <= 320
    and email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    and kind in ('updates', 'access')
  );

-- NOTE: intentionally no SELECT/UPDATE/DELETE policy for anon/authenticated.
-- Reads + exports happen through the service role (which bypasses RLS).
