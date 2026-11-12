// @vitest-environment node
/**
 * The DS-1c overlay sources (components/ds/{Dialog,AlertDialog,Menu,Popover,Tooltip,Toast}.tsx) and their QA scene
 * (qa/app/scenes/ds-overlays.tsx) hold the design-system rules, so DS-0's app-wide guards find nothing at integration:
 * no hex, no raw z-index (layers come from Z), no local cx, no legacy kit, no raw hue ink, no spelled duration, no
 * stacked inks, no hand-rolled eyebrow; every --ds-* token they read exists; and every motion, ease and radius token
 * they spell keeps a var() fallback (lead note).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as design from '../chat/studioDesign';
import { findCompetingInks, findHandRolledOverlines } from '../../tests/config/classLists';
import { APP_ROOT } from '../../tests/config/cssTokens';

const FILES = ['Dialog', 'AlertDialog', 'Menu', 'Popover', 'Tooltip', 'Toast'].map((n) => `components/ds/${n}.tsx`).concat('qa/app/scenes/ds-overlays.tsx');
const source = (rel: string) => readFileSync(path.join(APP_ROOT, rel), 'utf8');

describe('the overlay sources hold the design-system rules', () => {
  const HUES = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
  const RULES: Array<[string, RegExp]> = [
    ['hex colour literal', /#[0-9a-fA-F]{3,8}\b/g],
    ['local cx', /\b(?:const|let|var|function)\s+cx\b|import\s*\{[^}]*\bcx\b[^}]*\}/g],
    ['raw z-index class', /(?<![\w-])-?z-(?:\[|\d)/g],
    ['legacy kit', /border-black|shadow-comic|font-comic|(?<![A-Za-z0-9_])brand-(?:yellow|blue|red|black)\b|font-display/g],
    ['raw hue text colour', new RegExp(String.raw`(?<![\w-])(?:[\w\-[\]&:()>.*]+:)?text-(?:${HUES})-\d{2,3}`, 'g')],
    ['spelled duration or delay', /(?<![\w-])(?:[\w-]+:)*(?:duration|delay)-(?:\d|\[\d)|(?<![\w-])animate-\[/g],
    ['a motion, ease or radius token read without a var() fallback', /var\(--ds-(?:motion|ease|radius)[\w-]*\)/g]
  ];

  it.each(FILES)('%s', (rel) => {
    const text = source(rel);
    const hits = RULES.flatMap(([name, re]) => [...text.matchAll(re)].map((m) => `${name}: ${m[0]}`));
    expect(hits).toEqual([]);
    expect(findCompetingInks(text, design as unknown as Record<string, unknown>, rel)).toEqual([]);
    expect(findHandRolledOverlines(text, rel)).toEqual([]);
  });

  it('the fallback rule catches a bare read and passes a guarded one (planted)', () => {
    const rule = RULES.at(-1)![1];
    expect('duration-[var(--ds-motion-fast)]'.match(rule)).not.toBeNull();
    expect('rounded-[var(--ds-radius-control)]'.match(rule)).not.toBeNull();
    expect('duration-[var(--ds-motion-fast,120ms)] ease-[var(--ds-ease,ease)] rounded-[var(--ds-radius-control,8px)]'.match(rule)).toBeNull();
  });

  it('every --ds-* token they read exists in index.css', () => {
    const css = source('index.css');
    const used = new Set<string>();
    for (const rel of FILES) for (const m of source(rel).matchAll(/var\((--ds-[\w-]+)[,)]/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(8);
    expect([...used].filter((token) => !new RegExp(`${token}\\s*:`).test(css))).toEqual([]);
  });
});
