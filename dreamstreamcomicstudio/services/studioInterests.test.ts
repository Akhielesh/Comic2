// @vitest-environment node
// The register-interest studio list is ONE constant shared by the form, the API and the database.
// This pins the parts that can drift apart: the SQL CHECK / cleanup / summary in
// server/sql/register_interest_2026_11.sql, and the API deploy watching the file it bundles.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  STUDIO_INTERESTS,
  STUDIO_INTEREST_IDS,
  formatStudioInterestList,
  isStudioInterestId,
  sanitizeStudioInterests,
  studioInterestLabel
} from './studioInterests';

const APP = fileURLToPath(new URL('..', import.meta.url));
const SQL = readFileSync(path.join(APP, 'server/sql/register_interest_2026_11.sql'), 'utf8');
/** The executable SQL: `--` comments removed, whitespace collapsed. */
const executable = SQL.split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join(' ')
  .replace(/\s+/g, ' ');

describe('STUDIO_INTERESTS', () => {
  it('lists the current studios plus "future studios", and nothing retired', () => {
    expect(STUDIO_INTEREST_IDS).toEqual(['comic_studio', 'stream_studio', 'chat_studio', 'atlas_studio', 'future_studios']);
    // Code Studio was retired on 2026-10-22 (ADR 0005); "Dashboards" was never a studio.
    expect(STUDIO_INTEREST_IDS).not.toContain('code_studio');
    expect(STUDIO_INTEREST_IDS).not.toContain('dashboards');
  });

  it('has unique snake_case ids and a label and blurb for each', () => {
    expect(new Set(STUDIO_INTEREST_IDS).size).toBe(STUDIO_INTEREST_IDS.length);
    for (const s of STUDIO_INTERESTS) {
      expect(s.id).toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(s.label.trim()).not.toBe('');
      expect(s.blurb.trim()).not.toBe('');
    }
  });

  it('sanitizes to known ids, deduped, in canonical order', () => {
    expect(sanitizeStudioInterests(['future_studios', 'code_studio', 'comic_studio', 'comic_studio', 42, null])).toEqual([
      'comic_studio',
      'future_studios'
    ]);
    expect(sanitizeStudioInterests('comic_studio')).toEqual([]);
    expect(sanitizeStudioInterests(undefined)).toEqual([]);
    expect(isStudioInterestId('atlas_studio')).toBe(true);
    expect(isStudioInterestId('Atlas Studio')).toBe(false);
  });

  it('formats labels for messages', () => {
    expect(studioInterestLabel('chat_studio')).toBe('Chat Studio');
    expect(formatStudioInterestList([])).toBe('');
    expect(formatStudioInterestList(['comic_studio'])).toBe('Comic Studio');
    expect(formatStudioInterestList(['comic_studio', 'atlas_studio'])).toBe('Comic Studio and Atlas Studio');
    expect(formatStudioInterestList(['comic_studio', 'chat_studio', 'future_studios'])).toBe('Comic Studio, Chat Studio and Future studios');
  });
});

describe('server/sql/register_interest_2026_11.sql agrees with the shared list', () => {
  const arrays = [...executable.matchAll(/array\[([^\]]*)\]::text\[\]/g)].map((m) =>
    [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  );

  it('every studio array literal in the file is exactly the shared list (CHECK, cleanup, …)', () => {
    expect(arrays.length).toBeGreaterThanOrEqual(4);
    for (const list of arrays) expect(list).toEqual([...STUDIO_INTEREST_IDS]);
  });

  it('caps the array at the list length', () => {
    expect(executable).toContain(`cardinality(product_interests) <= ${STUDIO_INTEREST_IDS.length}`);
  });

  it('is additive and idempotent where it touches structure', () => {
    expect(executable).not.toMatch(/drop (table|column|policy)/i);
    expect(executable).toMatch(/add column if not exists product_interests text\[\] not null default '\{\}'::text\[\]/);
    expect(executable).toMatch(/drop constraint if exists waitlist_signups_product_interests_known/);
    expect(executable).toMatch(/create index if not exists idx_email_log_to_template/);
  });

  it('keeps the summary and retention functions service-role only', () => {
    for (const fn of ['waitlist_interest_summary', 'waitlist_interest_retention']) {
      expect(executable).toContain(`revoke all on function public.${fn}() from public, anon, authenticated;`);
      expect(executable).toContain(`grant execute on function public.${fn}() to service_role;`);
    }
    // Client roles get nothing on the table but INSERT of the four columns the offline fallback
    // writes (services/waitlist.ts): never a table-wide grant, never confirmed / token / picks.
    expect(executable).not.toMatch(/grant [a-z, ]+ on (table )?public\.waitlist_signups to (anon|authenticated)/i);
    expect(executable).toContain('revoke insert, references, trigger on public.waitlist_signups from anon, authenticated;');
    const grants = [...executable.matchAll(/grant ([^;]+) on (?:table )?public\.waitlist_signups to ([^;]+);/gi)].map((m) => `${m[1]} → ${m[2]}`);
    expect(grants).toEqual(['insert (email, kind, source, metadata) → anon, authenticated']);
    expect(executable.indexOf('revoke insert, references, trigger')).toBeLessThan(executable.indexOf('grant insert (email'));
  });

  /** The policy's WITH CHECK condition, one clause per entry. */
  const policyClauses = (): string[] => {
    const start = executable.indexOf('alter policy waitlist_public_insert');
    const policy = executable.slice(start, executable.indexOf(');', start));
    return policy
      .slice(policy.indexOf('with check (') + 'with check ('.length)
      .split(' and ')
      .map((c) => c.trim());
  };

  it('the client insert policy requires a lowercase address and default values', () => {
    const policy = policyClauses().join(' and ');
    for (const clause of [
      'email = lower(email)',
      'confirmed = false',
      'confirm_token is null',
      'confirm_sent_at is null',
      'confirmed_at is null',
      'unsubscribed_at is null',
      'cardinality(product_interests) = 0',
      'feedback is null'
    ]) {
      expect(policy).toContain(clause);
    }
  });

  // No subscription oracle through a direct client INSERT (the unique index used to answer 23505
  // for a listed address). The trigger runs BEFORE the policy and the NOT NULL checks, so it must
  // judge a row by exactly the policy's condition: anything looser or stricter answers a new
  // address and a listed one differently again (checked against Postgres in PGlite, 2026-11-05).
  it('the client-insert trigger applies exactly the policy’s condition, for client roles only', () => {
    const fn = executable.slice(executable.indexOf('create or replace function public.waitlist_client_insert()'));
    expect(fn).toMatch(/^create or replace function public\.waitlist_client_insert\(\) returns trigger language plpgsql security definer set search_path = '' as/);
    const condition = fn.slice(fn.indexOf('if (') + 'if ('.length, fn.indexOf(') is not true then return new;'));
    const triggerClauses = condition.split(' and ').map((c) => c.trim().replace(/\bnew\./g, ''));
    expect(triggerClauses).toEqual(policyClauses());
    // Rows that pass are written with ON CONFLICT DO NOTHING and the client's own insert skipped,
    // so a listed and an unlisted address get the same answer (and the same row count).
    expect(fn).toContain('insert into public.waitlist_signups values (new.*) on conflict do nothing; return null; end;');
    expect(executable).toContain('revoke all on function public.waitlist_client_insert() from public, anon, authenticated;');
    expect(executable).toContain(
      "create or replace trigger waitlist_client_insert before insert on public.waitlist_signups for each row when (current_user in ('anon', 'authenticated')) execute function public.waitlist_client_insert();"
    );
    // After the grants are narrowed (section 7), so the definer path never widens what a client may set.
    expect(executable.indexOf('create or replace trigger waitlist_client_insert')).toBeGreaterThan(executable.indexOf('alter policy waitlist_public_insert'));
  });

  it('retention never keeps a row forever on a planted future timestamp, and keeps this month’s confirm log', () => {
    const retention = executable.slice(executable.indexOf('create or replace function public.waitlist_interest_retention()'));
    for (const col of ['confirm_sent_at', 'created_at', 'unsubscribed_at']) {
      expect(retention).toContain(`case when w.${col} <= now() + interval '1 minute' then w.${col} end`);
    }
    // The monthly email cap and the confirmation budget count rows since the 1st (UTC).
    expect(retention).toContain(
      "l.created_at < least( now() - interval '30 days', date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' );"
    );
    expect(executable).toContain("update public.waitlist_signups set confirm_sent_at = null where confirm_sent_at > now() + interval '1 minute';");
  });
});

describe('deploy', () => {
  it('the API deploy workflow watches this file (the backend container bundles it)', () => {
    const yml = readFileSync(path.join(APP, '..', '.github/workflows/deploy-api-proxy.yml'), 'utf8');
    expect(yml).toContain("- 'dreamstreamcomicstudio/services/studioInterests.ts'");
  });
});
