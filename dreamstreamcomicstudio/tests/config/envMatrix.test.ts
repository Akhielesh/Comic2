// @vitest-environment node
/**
 * docs/infrastructure/ENV_MATRIX.md is the authoritative env-var → consumer map: the runbooks and the
 * Phase 0 owner checklist send the owner there. A paragraph dropped into the middle of a table turns
 * every row after it into paragraph text (GFM ends a table at the first line that isn't a row), so
 * those variables silently fall out of the map. Parse it the way GitHub renders it and check that
 * every row-looking line is in a table.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FILE = 'docs/infrastructure/ENV_MATRIX.md';
const text = readFileSync(path.join(ROOT, FILE), 'utf8');

type Node = { type: string; children?: Node[]; value?: string; position?: { start: { line: number }; end: { line: number } } };
const tree = unified().use(remarkParse).use(remarkGfm).parse(text) as unknown as Node;

/** Line numbers (1-based) covered by GFM table nodes. */
const tableLines = new Set<number>();
const cellText = (n: Node): string => (n.value ?? '') + (n.children ?? []).map(cellText).join('');
const firstCells: string[] = [];
(function walk(n: Node) {
  if (n.type === 'table' && n.position) {
    for (let l = n.position.start.line; l <= n.position.end.line; l++) tableLines.add(l);
    for (const row of n.children ?? []) firstCells.push(cellText(row.children?.[0] ?? { type: 'text' }));
  }
  for (const c of n.children ?? []) walk(c);
})(tree);

describe(`${FILE} renders every variable inside a table`, () => {
  it('has no table row that GitHub would render as paragraph text', () => {
    const stray = text
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line, n }) => /^\|\s*\S/.test(line) && !tableLines.has(n))
      .map(({ line, n }) => `${n}: ${line.slice(0, 60)}`);
    expect(stray).toEqual([]);
  });

  it('keeps the live Worker’s Phase 0 variables in the map', () => {
    for (const name of ['ALLOWED_ORIGINS', 'DEVICE_TOKEN_JWK', 'ACT_TOKEN_KEY', 'SECURITY_HOOK_SECRET', 'OPS_KEY', 'APNS_KEY_P8', 'PUSH_IOS_VIA', 'RL_WS', 'CSP_REPORTS']) {
      expect(firstCells.some((c) => c.includes(name)), name).toBe(true);
    }
  });
});
