// @vitest-environment node
// S19 scrub for rows stored before the backend masked telemetry surfaces on write. There is no
// database in CI, so this pins server/sql/telemetry_mask_capability_paths.sql statically: it is
// guarded and idempotent, touches only `surface` of the two telemetry tables, and its regexes —
// run here with the same semantics (anchored, case-insensitive, non-participating group → '') —
// produce exactly what the write-path helper (shared/capabilityPath.ts loggablePath) produces.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loggablePath } from '../../../shared/capabilityPath.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RAW = readFileSync(path.join(APP_ROOT, 'server/sql/telemetry_mask_capability_paths.sql'), 'utf8');
const SQL = RAW.split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

/** Every `set surface = regexp_replace(surface, '<pattern>', '<replacement>', 'i') where surface ~* '<guard>'`. */
const RULES = [...SQL.matchAll(/regexp_replace\(surface, '([^']+)', '([^']+)', 'i'\)\s*where surface ~\* '([^']+)'/g)].map((m) => ({
  pattern: new RegExp(m[1], 'i'),
  replacement: m[2].replace(/\\(\d)/g, '$$$1'),
  guard: new RegExp(m[3], 'i')
}));

/** The scrub applied to one stored value, statement by statement (as Postgres runs them). */
const scrub = (value: string): string => {
  let v = /[?#]/.test(value) ? value.split('?')[0].split('#')[0] : value;
  for (const rule of RULES) if (rule.guard.test(v)) v = v.replace(rule.pattern, rule.replacement);
  return v;
};

const SLUG = 'Ab3dEf6hIj9kLm2nP';

describe('telemetry_mask_capability_paths.sql (S19)', () => {
  it('is guarded, idempotent-by-construction and only rewrites `surface` of the telemetry tables', () => {
    expect(SQL).toMatch(/foreach t in array array\['telemetry_events', 'user_feedback'\]/);
    expect(SQL).toMatch(/to_regclass\(format\('public\.%I', t\)\) is null/);
    expect(SQL).toMatch(/column_name = 'surface'/);
    const updates = [...SQL.matchAll(/update public\.%I\s+set (\w+)\s*=/g)].map((m) => m[1]);
    expect(updates).toEqual(['surface', 'surface', 'surface', 'surface', 'surface']);
    expect(SQL).not.toMatch(/\b(delete|drop|truncate|alter|grant|revoke)\b/i);
    expect(RULES).toHaveLength(4);
  });

  it.each([
    `/c/${SLUG}`,
    `/c/${SLUG}/my-title?lang=hi`,
    `/c/${SLUG}/embed#p3`,
    `/C/${SLUG}`,
    `/api/comic/public/s/${SLUG}/report?x=1`,
    `/API/Comic/Public/S/${SLUG}/event`,
    '/share/0123456789abcdef0123456789abcdef',
    '/api/shares/token/tok_abc123XYZ?x=1',
    '/api/newsletter/confirm?t=NEWSLETTERTOKEN',
    `https://comics.dreamstreamstudio.ai/c/${SLUG}?lang=te`,
    '/api/comic/projects/11111111-2222-3333-4444-555555555555/stream',
    '/api/comic/public/library',
    '/comics',
    '/',
    'ai_chat'
  ])('%s matches the write-path mask and a second run is a no-op', (stored) => {
    const once = scrub(stored);
    expect(once).toBe(loggablePath(stored));
    expect(scrub(once)).toBe(once);
    expect(once).not.toContain(SLUG);
  });
});
