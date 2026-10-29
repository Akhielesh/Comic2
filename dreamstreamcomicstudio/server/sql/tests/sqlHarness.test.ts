// @vitest-environment node
//
// Runs the psql harness (harness.mjs) from vitest: live_accounts_and_monitor.sql and
// live_security_v2.sql (twice — it must be idempotent) on a throwaway local Postgres with the
// Supabase stand-in, then every *.test.sql here. Skips, with the reason, where the Postgres
// server binaries aren't installed; GitHub's ubuntu runners and the dev container have them.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs script with no type declarations
import { runSqlHarness, testFiles } from './harness.mjs';

type HarnessResult = { ok: boolean; skipped?: string; results: { file: string; ok: boolean; output: string }[] };

const result: HarnessResult = runSqlHarness(testFiles());
const files: string[] = testFiles().map((f: string) => f.split('/').pop() as string);

describe('server/sql psql harness', () => {
  it.skipIf(!!result.skipped)(`applies the schema twice and passes ${files.join(', ')}`, () => {
    for (const r of result.results) {
      // On failure, show psql's own output (the failing ASSERT and its message).
      expect(r.ok, `${r.file}\n${r.output}`).toBe(true);
    }
    expect(result.results.map((r) => r.file.split('/').pop())).toEqual(files);
    // Each file ends with an \echo …_OK, reached only once every assertion above it has passed.
    for (const r of result.results) expect(r.output, r.file).toMatch(/_OK\b/);
  });

  it.runIf(!!result.skipped)('is skipped here (no Postgres)', () => {
    expect(result.skipped).toBeTruthy();
  });
});
