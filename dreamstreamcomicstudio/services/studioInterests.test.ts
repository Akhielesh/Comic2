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
    // Nothing grants client roles anything on the table.
    expect(executable).not.toMatch(/grant [a-z, ]+ on (table )?public\.waitlist_signups to (anon|authenticated)/i);
  });
});

describe('deploy', () => {
  it('the API deploy workflow watches this file (the backend container bundles it)', () => {
    const yml = readFileSync(path.join(APP, '..', '.github/workflows/deploy-api-proxy.yml'), 'utf8');
    expect(yml).toContain("- 'dreamstreamcomicstudio/services/studioInterests.ts'");
  });
});
