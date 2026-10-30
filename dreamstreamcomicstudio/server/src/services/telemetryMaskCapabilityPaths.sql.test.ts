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
    expect(updates).toEqual(['surface', 'surface', 'surface', 'surface', 'surface', 'message', 'message', 'metadata', 'metadata']);
    // The free-text step is guarded by the column's type too (text / jsonb).
    expect(SQL).toMatch(/column_name = 'message' and data_type = 'text'/);
    expect(SQL).toMatch(/column_name = 'metadata' and data_type = 'jsonb'/);
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

  describe('step 4: capability URLs inside message / metadata (an error filename or stack frame)', () => {
    /** SQL string literal → JS RegExp source: '' → ', [:space:] → \s (backslashes are literal: standard_conforming_strings). */
    const re = (lit: string, flags: string) => new RegExp(lit.replace(/''/g, "'").replace(/\[:space:\]/g, '\\s'), flags);
    const FREE = [
      ...SQL.matchAll(/set (message|metadata) = regexp_replace\((?:message|metadata::text), '((?:[^']|'')+)', '([^']+)', 'gi'\)(?:::jsonb)?\s*where (?:message|metadata::text) ~\* '((?:[^']|'')+)'/g)
    ].map((m) => ({ column: m[1], pattern: re(m[2], 'gi'), replacement: m[3].replace(/\\(\d)/g, '$$$1'), guard: re(m[4], 'i') }));
    const scrubText = (column: string, value: string) => {
      let v = value;
      for (const rule of FREE) if (rule.column === column && rule.guard.test(v)) v = v.replace(rule.pattern, rule.replacement);
      return v;
    };

    it('has the four statements (slug + token, for each column)', () => {
      expect(FREE.map((r) => r.column)).toEqual(['message', 'message', 'metadata', 'metadata']);
    });

    it('masks every capability URL, keeps the jsonb valid and everything else as it was; a second run is a no-op', () => {
      const page = `https://comics.dreamstreamstudio.ai/c/${SLUG}?lang=hi`;
      const metadata = {
        filename: page,
        lineno: 110,
        stack: `Error: boom\n    at ${page}:110:5\n    at https://comics.dreamstreamstudio.ai/assets/index-Ab12.js:1:2`,
        nested: { u: 'run@HTTPS://DreamStreamStudio.ai/Share/tok_abc123XYZ:3:9 "q"', api: `https://dreamstreamstudio.ai/api/comic/public/s/${SLUG}/event` },
        other: 'b "quoted" \\ back https://openrouter.ai/api/v1/x?y=1'
      };
      const once = scrubText('metadata', JSON.stringify(metadata));
      const parsed = JSON.parse(once) as typeof metadata;
      expect(once).not.toContain(SLUG);
      expect(once).not.toContain('tok_abc123XYZ');
      expect(parsed.filename).toBe('https://comics.dreamstreamstudio.ai/c/:slug?lang=hi');
      expect(parsed.stack).toContain('https://comics.dreamstreamstudio.ai/assets/index-Ab12.js:1:2');
      expect(parsed.nested.u).toBe('run@HTTPS://DreamStreamStudio.ai/Share/:token:3:9 "q"');
      expect(parsed.nested.api).toBe('https://dreamstreamstudio.ai/api/comic/public/s/:slug/event');
      expect(parsed.other).toBe(metadata.other);
      expect(scrubText('metadata', once)).toBe(once);

      const message = `URL '${page}' cannot be created; see https://dreamstreamstudio.ai/api/shares/token/tok_abc123XYZ`;
      const masked = scrubText('message', message);
      expect(masked).toBe("URL 'https://comics.dreamstreamstudio.ai/c/:slug?lang=hi' cannot be created; see https://dreamstreamstudio.ai/api/shares/token/:token");
      expect(scrubText('message', masked)).toBe(masked);
      for (const plain of ['Script error.', 'https://x.test/c/', 'see /c/not-a-url', 'https://dreamstreamstudio.ai/?view=read&id=11111111-2222-3333-4444-555555555555']) {
        expect(scrubText('message', plain)).toBe(plain);
      }
    });
  });
});
