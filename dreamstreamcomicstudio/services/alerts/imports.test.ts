// @vitest-environment node
// The alert core never reaches the network and never pulls UI in (notify SPEC §6 NF-1): services/alerts/* imports
// nothing from components/** except the ds toast slot, and nothing that sends (the API client, Supabase, the db layer,
// telemetry: the Open count is handed in by the host). A new import here is a reviewed change.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const APP = path.resolve(DIR, '..', '..');
const SPECIFIER = /(?:\bimport\s[^'"]*?from\s*|\bimport\s*\(\s*|\bexport\s[^'"]*?from\s*|\bimport\s*)['"]([^'"]+)['"]/g;

const sources = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
const importsOf = (file: string): string[] => {
  const text = readFileSync(path.join(DIR, file), 'utf8');
  return [...text.matchAll(SPECIFIER)].map((m) => m[1]);
};
/** An import as a path relative to the app root ('components/ds/Toast'), or the bare package name. */
const resolved = (spec: string): string => (spec.startsWith('.') ? path.relative(APP, path.resolve(DIR, spec)).replace(/\\/g, '/') : spec);

const FORBIDDEN_SERVICES = /^services\/(?:apiClient|supabase[\w.-]*|db(?:\.|$)|db\/|telemetry|cloudSync|appSettings)/;

describe('services/alerts imports', () => {
  it('finds the core’s modules', () => {
    expect(sources).toEqual(expect.arrayContaining(['bus.ts', 'rules.ts', 'copy.ts', 'prefs.ts', 'chimeSpec.ts', 'audio.ts', 'chime.ts', 'tabBadge.ts', 'types.ts']));
  });

  for (const file of sources) {
    it(`${file}: no UI but the ds toast slot, nothing that sends`, () => {
      for (const spec of importsOf(file)) {
        const where = resolved(spec);
        if (where.startsWith('components/')) expect(where, `${file} imports ${spec}`).toBe('components/ds/Toast');
        expect(FORBIDDEN_SERVICES.test(where), `${file} imports ${spec}`).toBe(false);
        // Packages: React only (prefs.ts's hook); never an HTTP or storage client.
        if (!spec.startsWith('.')) expect(['react'], `${file} imports ${spec}`).toContain(spec);
      }
    });
  }
});
