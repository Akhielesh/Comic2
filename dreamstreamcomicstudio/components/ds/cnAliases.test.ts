// @vitest-environment node
/**
 * The cn rule (docs/design/design-system.md "Composing classes"): no class string in the app spells a Tailwind 3
 * alias that tailwind-merge 3.6 cannot dedupe against its modern name — `flex-shrink-*` / `flex-grow*` (use
 * `shrink-*` / `grow*`), `overflow-ellipsis` (`text-ellipsis`), `decoration-slice` / `decoration-clone`
 * (`box-decoration-slice` / `-clone`) — nor an arbitrary shadow without its type hint, `shadow-[var(…)]`
 * (write `shadow-[shadow:var(…)]`, as SHADOW_SOFT does). cn() keeps BOTH sides of such a pair, so a caller's
 * override silently loses to the CSS order instead of winning. The probe below proves the merge really keeps
 * both (if a future tailwind-merge learns them, it fails and this rule can go).
 *
 * Scope: every source file the design-system guards scan (components/**, App.tsx, qa/**; tests excluded),
 * literals only (class strings, attribute values, templates), so a comment that names an alias never counts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cn } from '../../lib/utils';
import { APP_ROOT, findInLiterals, listScannedFiles, VARIANT } from '../../tests/config/classLists';

/** One deprecated alias (any variant prefix); the shadow form is matched by its opening, `shadow-[var(`. */
export const CN_ALIAS = new RegExp(
  String.raw`(?<![\w-])${VARIANT}(?:(?:flex-shrink|flex-grow)(?:-\d+|-\[[^\]\s]+\])?(?![\w-])|overflow-ellipsis(?![\w-])|decoration-(?:slice|clone)(?![\w-])|shadow-\[var\()`,
  'g'
);

export function aliasesIn(source: string, fileName = 'file.tsx'): string[] {
  return findInLiterals(source, CN_ALIAS, (m) => m, fileName).map((h) => `${h.line}: ${h.match}`);
}

describe('the cn rule: no Tailwind 3 alias tailwind-merge cannot dedupe', () => {
  it('the probe: cn keeps both sides of each pair (why the rule exists)', () => {
    expect(cn('flex-shrink-0', 'shrink')).toBe('flex-shrink-0 shrink');
    expect(cn('flex-grow', 'grow-0')).toBe('flex-grow grow-0');
    expect(cn('overflow-ellipsis', 'text-clip')).toBe('overflow-ellipsis text-clip');
    expect(cn('decoration-slice', 'box-decoration-clone')).toBe('decoration-slice box-decoration-clone');
    expect(cn('shadow-[var(--ds-shadow-soft)]', 'shadow-none')).toBe('shadow-[var(--ds-shadow-soft)] shadow-none');
    // The modern spellings merge as they should.
    expect(cn('shrink-0', 'shrink')).toBe('shrink');
    expect(cn('text-ellipsis', 'text-clip')).toBe('text-clip');
    expect(cn('shadow-[shadow:var(--ds-shadow-soft)]', 'shadow-none')).toBe('shadow-none');
  });

  it('catches every alias in a class string, with a variant, and ignores comments and modern names (planted samples)', () => {
    const planted = [
      "const A = 'flex-shrink-0 px-2';",
      "const B = 'md:flex-grow';",
      "const C = 'hover:flex-grow-0 flex-shrink-[2]';",
      "const D = `truncate overflow-ellipsis ${x}`;",
      '<b className="decoration-slice">x</b>',
      '<b className="decoration-clone">x</b>',
      "const E = 'shadow-[var(--ds-shadow-soft)]';"
    ].join('\n');
    expect(aliasesIn(planted)).toEqual([
      '1: flex-shrink-0',
      '2: md:flex-grow',
      '3: hover:flex-grow-0',
      '3: flex-shrink-[2]',
      '4: overflow-ellipsis',
      '5: decoration-slice',
      '6: decoration-clone',
      '7: shadow-[var('
    ]);
    const clean = [
      '// flex-shrink-0 in a comment is not a class',
      "const A = 'shrink-0 grow basis-0 text-ellipsis box-decoration-slice shadow-[shadow:var(--ds-shadow-soft)] shadow-sm';",
      "const B = 'my-flex-shrink-0-thing';"
    ].join('\n');
    expect(aliasesIn(clean)).toEqual([]);
  });

  it('no file in the app uses one', () => {
    const files = listScannedFiles();
    expect(files.length).toBeGreaterThan(500);
    const offenders = files.flatMap((rel) => aliasesIn(readFileSync(path.join(APP_ROOT, rel), 'utf8'), rel).map((hit) => `${rel}:${hit}`));
    expect(offenders).toEqual([]);
  }, 60_000);
});
