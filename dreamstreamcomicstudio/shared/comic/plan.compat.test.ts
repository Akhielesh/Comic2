// B4 back-compat proof: every existing shared/comic/plan.ts export, called the way today's callers call it (no new
// options), returns byte for byte what it returned before B4 — on plain books AND on books that already carry Ship 2
// data (scenes, a ledger, directions, consistency settings, stamped parts). plan.golden.json was written from plan.ts
// as it was before B4 changed it (see the commit that adds it); a deliberate change to an existing quote needs a new
// golden and a reason.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planCompatCases } from './__fixtures__/planCompat';

const golden = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'plan.golden.json'), 'utf8')) as Record<string, unknown>;

describe('plan.ts existing callers stay byte-identical', () => {
  const cases = planCompatCases();
  const want = golden;

  it('covers the same cases as the golden', () => {
    expect(Object.keys(cases)).toEqual(Object.keys(want));
    expect(Object.keys(cases).length).toBeGreaterThan(150);
  });

  for (const key of Object.keys(want)) {
    it(key, () => {
      expect(JSON.stringify(cases[key])).toBe(JSON.stringify(want[key]));
    });
  }
});
