// @vitest-environment node
/**
 * The Atlas skin's transitional accent shim (docs/design/atlas-skin.md, "The transitional shim").
 * Comic Studio files still hard-code the terracotta literal in Tailwind utilities (`bg-[#D97757]/10`,
 * `text-[#D97757]`, `focus-visible:ring-[#D97757]/45`, …). Until Phase D1 rewrites them, the block at
 * the END of index.css maps every such utility to the accent / accent-soft / ring tokens under
 * `[data-ds-skin="atlas"]`. This test:
 *   (d) FAILS when a literal utility in the source tree has no rule in the shim (and when a solid
 *       accent fill lacks its on-accent text companion);
 *   records — never fails on — how many files still carry the literal in any form (classes, inline
 *   styles, SVG fills), so D1 can watch the count fall; when it reaches zero the shim must be gone.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LITERAL, SHIM_END, SHIM_START, declarationsFor, escapeClass, parseUtility, renderShim, scanLiteral, selectorFor, selectorParts } from '../../scripts/design/atlas-skin-shim.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const css = readFileSync(path.join(ROOT, 'index.css'), 'utf8');
const { utilities, files } = scanLiteral(ROOT);

const shimBlock = (): string | null => {
  const start = css.indexOf(SHIM_START);
  const end = css.indexOf(SHIM_END);
  return start >= 0 && end > start ? css.slice(start, end + SHIM_END.length) : null;
};

describe('Atlas skin — (d) the shim covers every literal accent utility in the tree', () => {
  const block = shimBlock();

  it('finds the literal utilities (the scanner sees the forms Tailwind can emit)', () => {
    expect(utilities.length).toBeGreaterThan(0);
    expect(utilities).toEqual([...new Set(utilities)].sort());
    for (const u of utilities) expect(u).toMatch(/^[A-Za-z0-9:/().-]*\[#D97757\](\/(\d{1,3}|\[0?\.\d+\]))?$/);
  });

  it('is the last block of index.css, clearly labelled', () => {
    expect(block, 'the transitional shim block exists while literals remain').not.toBeNull();
    expect(css.trimEnd().endsWith(SHIM_END)).toBe(true);
    expect(block).toContain('DELETE this whole block');
  });

  it.each(utilities)('has a rule for %s', (token) => {
    expect(block).toContain(`${selectorFor(token)} {`);
  });

  it('solid or strong accent fills also fix hard-coded white text (dark Atlas ink is light)', () => {
    for (const token of utilities) {
      const { onAccent } = declarationsFor(token);
      if (!onAccent) continue;
      const { prefix, target, suffix } = selectorParts(token);
      expect(block, token).toContain(`[data-ds-skin="atlas"] ${prefix}${target}.text-white${suffix} { color: var(--ds-on-accent); }`);
    }
    expect(block).toContain('[data-ds-skin="atlas"] .bg-\\[var\\(--ds-accent\\)\\].text-white,');
  });

  it('is exactly what the generator prints (regenerate: node scripts/design/atlas-skin-shim.mjs)', () => {
    expect(block).toBe(renderShim(utilities));
  });

  it('maps utilities to the semantic tokens, never to a hue', () => {
    for (const token of utilities) {
      const { onAccent: _onAccent, ...decls } = declarationsFor(token);
      for (const value of Object.values(decls)) {
        expect(String(value), token).toMatch(/var\(--ds-(accent|accent-soft|hover|active|ring|ink|on-accent)\)/);
        expect(String(value), token).not.toContain(LITERAL);
      }
    }
  });

  it('escapes Tailwind class names the way Tailwind does', () => {
    expect(escapeClass('bg-[#D97757]/10')).toBe('bg-\\[\\#D97757\\]\\/10');
    expect(escapeClass('bg-[#D97757]/[0.07]')).toBe('bg-\\[\\#D97757\\]\\/\\[0\\.07\\]');
    expect(selectorFor('hover:bg-[#D97757]/10')).toBe('[data-ds-skin="atlas"] .hover\\:bg-\\[\\#D97757\\]\\/10:hover');
    expect(selectorFor('peer-checked:bg-[#D97757]')).toBe('[data-ds-skin="atlas"] .peer:checked ~ .peer-checked\\:bg-\\[\\#D97757\\]');
    expect(selectorFor('group-hover/place:ring-[#D97757]/40')).toBe('[data-ds-skin="atlas"] .group\\/place:hover .group-hover\\/place\\:ring-\\[\\#D97757\\]\\/40');
    expect(parseUtility('focus-visible:ring-[#D97757]/45')).toEqual({ variants: ['focus-visible'], kind: 'ring', tint: 45 });
    expect(parseUtility('bg-[#D97757]/[0.07]').tint).toBe(7);
    expect(() => selectorFor('dark:bg-[#D97757]')).toThrow(/no selector mapping/);
    expect(() => declarationsFor('shadow-[#D97757]')).toThrow(/no token mapping/);
  });
});

describe('Atlas skin — the literal count (recorded for Phase D1, not a failure)', () => {
  it('records the files that still carry the terracotta literal', () => {
    const comic = files.filter((f) => f.startsWith('components/comicstudio/')).length;
    // eslint-disable-next-line no-console
    console.log(
      `[atlas-skin shim] ${files.length} files still carry ${LITERAL} (${comic} under components/comicstudio) across ${utilities.length} literal utilities. ` +
        'Phase D1 rewrites them to the --ds-* tokens; delete the shim block and scripts/design/atlas-skin-shim.mjs when this reaches 0.'
    );
    expect(files.every((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))).toBe(true);
    expect(utilities.length === 0 ? null : shimBlock(), 'the shim must go when the last literal goes').toSatisfy((b: string | null) => (utilities.length === 0 ? b === null : b !== null));
  });
});
