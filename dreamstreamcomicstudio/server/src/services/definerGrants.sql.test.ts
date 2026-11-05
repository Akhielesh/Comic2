// @vitest-environment node
// SECURITY-PLAN §2.6: re-running the repo's SQL (or building a fresh database from it) must never
// re-open what production has locked. Production applied definer_lockdown_billing_2026_11.sql
// (migration 20261105012658): six SECURITY DEFINER functions that trust their arguments are
// service-role only. These tests pin that file byte for byte, and check every other server/sql
// file: no grant of those functions (or of resolve_email_from_username) to a client role, and
// every file that creates one revokes PUBLIC as well (a new function is PUBLIC-executable by
// default). They also pin the shape agreed for public.username_available and the read-only
// telemetry size function. There is no database in CI, so this reads the statements statically.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SQL_DIR = path.join(APP_ROOT, 'server/sql');

/** The executable SQL: `--` comments removed, whitespace collapsed, lower-cased. */
const executableSql = (raw: string): string =>
  raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();

const sqlFiles = readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql'));
const read = (f: string) => readFileSync(path.join(SQL_DIR, f), 'utf8');

const LOCKED = [
  'billing_settle_tokens',
  'billing_try_reserve_tokens',
  'billing_release_reserved_tokens',
  'free_tier_try_consume_model_usage',
  'bump_model_usage',
  'admin_reset_user'
] as const;

describe('definer_lockdown_billing_2026_11.sql (applied to production as 20261105012658)', () => {
  const file = path.join(SQL_DIR, 'definer_lockdown_billing_2026_11.sql');

  it('is committed verbatim — the exact bytes production ran', () => {
    expect(existsSync(file)).toBe(true);
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe('e56228a7a276f90e005bd1a6d178b5d02e4caf91461a25244b935985c191917c');
  });

  it('the 2026-06 file it supersedes says so', () => {
    expect(read('security_hardening_definer_lockdown_2026_06.sql').split('\n')[0]).toMatch(/^-- SUPERSEDED by definer_lockdown_billing_2026_11\.sql/);
  });
});

describe('no repo SQL re-opens a locked function', () => {
  it.each(sqlFiles)('%s grants no locked function (or the username→email resolver) to a client role', (f) => {
    const sql = executableSql(read(f));
    for (const fn of [...LOCKED, 'resolve_email_from_username']) {
      const grants = sql.match(new RegExp(`grant [^;]*on function public\\.${fn}\\b[^;]*;`, 'g')) ?? [];
      for (const g of grants) expect([f, g]).toEqual([f, expect.not.stringMatching(/\bto [^;]*\b(anon|authenticated|public)\b/)]);
    }
  });

  it.each(sqlFiles)('%s: every locked function it (re)creates is revoked from public, anon and authenticated after its last definition', (f) => {
    const sql = executableSql(read(f));
    for (const fn of LOCKED) {
      const created = sql.lastIndexOf(`create or replace function public.${fn}(`);
      if (created < 0) continue;
      const after = sql.slice(created);
      expect([f, fn, after]).toEqual([f, fn, expect.stringMatching(new RegExp(`revoke (all|execute) on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated;`))]);
      expect([f, fn, after]).toEqual([f, fn, expect.stringMatching(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`))]);
    }
  });

  it('the resolver files keep it callable by the server only, and say why the live grant is untouched', () => {
    for (const f of ['supabase_auth_profile_migration.sql', 'auth_signup_policy_min_age_8.sql']) {
      const raw = read(f);
      const sql = executableSql(raw);
      expect(sql).toContain('revoke all on function public.resolve_email_from_username(text) from public;');
      expect(sql).toContain('grant execute on function public.resolve_email_from_username(text) to service_role;');
      expect(raw).toMatch(/revoked only\s+-- in SECURITY-PLAN §2\.5a/);
    }
  });
});

describe('username_available_2026_11.sql (sign-up availability without an email)', () => {
  const raw = existsSync(path.join(SQL_DIR, 'username_available_2026_11.sql')) ? read('username_available_2026_11.sql') : '';
  const sql = executableSql(raw);

  it('returns a boolean only: STABLE, SECURITY DEFINER, empty search_path, schema-qualified, no email', () => {
    expect(sql).toContain('create or replace function public.username_available(p_username text) returns boolean language sql stable security definer set search_path = \'\' as $$');
    const body = sql.slice(sql.indexOf('as $$') + 5, sql.indexOf('$$;'));
    expect(body).toContain('from public.profiles p');
    expect(body).toContain('lower(p.username) = lower(trim(p_username))');
    expect(body).not.toContain('email');
    expect(body).toMatch(/nullif\(trim\(p_username\), ''\) is not null/); // a blank name is never "available"
  });

  it('revokes PUBLIC before granting anon, authenticated (sign-up is signed out) and service_role', () => {
    const revoke = sql.indexOf('revoke all on function public.username_available(text) from public;');
    const grant = sql.indexOf('grant execute on function public.username_available(text) to anon, authenticated, service_role;');
    expect(revoke).toBeGreaterThan(0);
    expect(grant).toBeGreaterThan(revoke);
  });
});

describe('telemetry_table_bytes_2026_11.sql (the size the telemetry store checks)', () => {
  const sql = executableSql(read('telemetry_table_bytes_2026_11.sql'));

  it('is read-only and server-only, and deletes nothing', () => {
    expect(sql).toContain("create or replace function public.telemetry_table_bytes() returns bigint language sql stable security definer set search_path = ''");
    expect(sql).toContain("pg_total_relation_size('public.telemetry_events') + pg_total_relation_size('public.user_feedback')");
    expect(sql).toContain('revoke all on function public.telemetry_table_bytes() from public, anon, authenticated;');
    expect(sql).toContain('grant execute on function public.telemetry_table_bytes() to service_role;');
    expect(sql).not.toMatch(/\b(delete|truncate|drop|cron\.)/);
  });
});
