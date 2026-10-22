// Static layout guard for the whole Comic Studio UI (visualqa §6, cheap; jsdom can't measure).
//
// 1. `flex`/`inline-flex` + `truncate` on ONE element never shows an ellipsis: text runs inside
//    a flex container are anonymous flex items, so `text-overflow` doesn't apply (the CastCard
//    status-line bug, visualqa P1-4). Put `truncate` on an inner text span with `min-w-0`.
// 2. `min-[…]:` / `max-[…]:` arbitrary breakpoints THROW in this Tailwind config (the screens
//    map has raw queries; tailwind.config.cjs), so they must never appear.
//
// Violations fail with file:line. Known violations in files owned by other packages are
// allow-listed with their owner (reported in the wave notes) until those owners fix them.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..'); // components/comicstudio
const REPO = join(ROOT, '..', '..');

/** path (relative to components/comicstudio) + a substring of the offending class string → owner. */
const ALLOW: { file: string; includes: string; owner: string }[] = [
  { file: 'timeline/ui.tsx', includes: 'inline-flex max-w-full items-center gap-1 truncate rounded-full', owner: 'P1-TIMELINE' }
];

const DISPLAY_FLEX = /^(?:[\w-]+:)*!?(?:inline-)?flex$/;
const TRUNCATE = /^(?:[\w-]+:)*!?truncate$/;
const ARBITRARY_SCREEN = /(?:^|:)!?(?:min|max)-\[[^\]]*\]:/;
const LITERAL = /"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(full);
  }
  return out;
};

/** Blank out whole-line comments (keeps line numbers) so prose about classes isn't linted. */
const stripCommentLines = (src: string): string =>
  src
    .split('\n')
    .map((line) => {
      const t = line.trim();
      return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('{/*') ? '' : line;
    })
    .join('\n');

export interface LayoutLintHit {
  file: string;
  line: number;
  rule: 'flex-truncate' | 'arbitrary-screen';
  text: string;
}

/** Lint one source file's text (exported for the self-test below). */
export const lintSource = (file: string, src: string): LayoutLintHit[] => {
  const hits: LayoutLintHit[] = [];
  const code = stripCommentLines(src);
  for (const m of code.matchAll(LITERAL)) {
    const text = m[1] ?? m[2] ?? m[3] ?? '';
    if (!text.includes('flex') && !text.includes('min-[') && !text.includes('max-[')) continue;
    const tokens = text.split(/\s+/).filter(Boolean);
    const line = code.slice(0, m.index ?? 0).split('\n').length;
    if (tokens.some((t) => DISPLAY_FLEX.test(t)) && tokens.some((t) => TRUNCATE.test(t))) hits.push({ file, line, rule: 'flex-truncate', text });
    if (tokens.some((t) => ARBITRARY_SCREEN.test(t))) hits.push({ file, line, rule: 'arbitrary-screen', text });
  }
  return hits;
};

describe('layout lint (components/comicstudio/**/*.tsx)', () => {
  it('the rules catch the anti-patterns and spare the fixes', () => {
    expect(lintSource('x.tsx', `<span className="flex items-center gap-1 truncate text-[11px]">`)).toHaveLength(1);
    expect(lintSource('x.tsx', `cx('inline-flex truncate', a)`)[0]?.rule).toBe('flex-truncate');
    expect(lintSource('x.tsx', `<span className="min-w-0 flex-1 truncate">`)).toEqual([]);
    expect(lintSource('x.tsx', `<span className="flex min-w-0"><span className="min-w-0 truncate">`)).toEqual([]);
    expect(lintSource('x.tsx', `<p className="hidden min-[420px]:inline">`)[0]?.rule).toBe('arbitrary-screen');
    expect(lintSource('x.tsx', `<p className="min-w-[4rem] max-w-[16rem]">`)).toEqual([]);
    expect(lintSource('x.tsx', `// a "flex truncate" note in a comment`)).toEqual([]);
  });

  it('no element combines display flex with truncate, and no arbitrary min/max screens', () => {
    const files = walk(ROOT);
    expect(files.length).toBeGreaterThan(20);
    const hits: LayoutLintHit[] = [];
    const usedAllow = new Set<number>();
    for (const full of files) {
      const rel = relative(ROOT, full).split('\\').join('/');
      for (const hit of lintSource(rel, readFileSync(full, 'utf8'))) {
        const allowed = ALLOW.findIndex((a) => a.file === rel && hit.text.includes(a.includes));
        if (allowed >= 0) {
          usedAllow.add(allowed);
          continue;
        }
        hits.push(hit);
      }
    }
    const stale = ALLOW.filter((_, i) => !usedAllow.has(i));
    if (stale.length) console.warn(`[layoutLint] fixed — remove from ALLOW: ${stale.map((a) => `${a.file} (${a.owner})`).join(', ')}`);
    const report = hits.map((h) => `${relative(REPO, join(ROOT, h.file))}:${h.line}  [${h.rule}]  "${h.text}"`).join('\n');
    expect(hits, `Layout anti-patterns:\n${report}`).toEqual([]);
  });
});
