// @vitest-environment node
// Static guard for server/sql/contact_messages.sql (CONTACT-1, N4 migration rule): the table is service-role
// only — RLS on, no client policy, every anon / authenticated privilege revoked and none granted back — and
// its length checks are the caps the route and the store enforce. The psql harness test
// (server/sql/tests/contact_messages.test.sql) applies the file twice and checks the same on a real Postgres.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTACT_EMAIL_MAX, CONTACT_EMAIL_MIN, CONTACT_MESSAGE_MAX } from './contactStore.js';

const raw = readFileSync(resolve(__dirname, '../../sql/contact_messages.sql'), 'utf8');
// Statements only: comments may mention policies and grants in prose.
const sql = raw
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')
  .toLowerCase();

describe('server/sql/contact_messages.sql', () => {
  it('creates public.contact_messages idempotently, owned by an auth user', () => {
    expect(sql).toContain('create table if not exists public.contact_messages');
    expect(sql).toMatch(/user_id uuid not null references auth\.users\(id\) on delete cascade/);
    expect(sql).toMatch(/created_at timestamptz not null default now\(\)/);
    expect(sql).toMatch(/handled_at timestamptz[ ,)]/);
    expect(sql).not.toMatch(/\bdrop table\b|\btruncate\b|\bdelete from\b/);
  });

  it('enables row level security', () => {
    expect(sql).toContain('alter table public.contact_messages enable row level security');
  });

  it('revokes everything from anon and authenticated and grants them nothing back', () => {
    expect(sql).toMatch(/revoke all on table public\.contact_messages from public, anon, authenticated/);
    const grants = [...sql.matchAll(/grant [^;]+ on table public\.contact_messages to ([^;]+);/g)].map((m) => m[1].trim());
    expect(grants).toEqual(['service_role']);
  });

  it('adds no policy (so no client can read or write a row)', () => {
    expect(sql).not.toMatch(/create policy/);
  });

  it('checks the same caps the route enforces', () => {
    expect(sql).toContain(`check (char_length(email) between ${CONTACT_EMAIL_MIN} and ${CONTACT_EMAIL_MAX})`);
    expect(sql).toContain(`check (char_length(message) between 1 and ${CONTACT_MESSAGE_MAX})`);
  });

  it('indexes newest-first reads and per-user history', () => {
    expect(sql).toContain('on public.contact_messages (created_at desc)');
    expect(sql).toContain('on public.contact_messages (user_id, created_at desc)');
  });

  it('says it is additive, safe to re-run and goes on before the server deploy', () => {
    expect(raw).toMatch(/Additive and idempotent: safe to re-run/);
    expect(raw).toMatch(/Apply BEFORE the server deploy/);
  });
});
