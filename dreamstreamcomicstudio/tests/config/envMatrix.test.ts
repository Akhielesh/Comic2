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
import { LIVE_FLAG_DEFAULTS, liveCapsFromEnv } from '../../shared/comic/capabilities';

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

  it('keeps the build-time design-skin kill switch in the map (bridge D5)', () => {
    expect(firstCells.some((c) => c.includes('VITE_DS_SKIN_EVERYWHERE'))).toBe(true);
  });

  it('maps every variable the admin image spend reads, each in exactly one row (S2a: ST-A, ST-4)', () => {
    // The names come from the code, so a renamed or new variable fails here until the map follows.
    const adminSpend = readFileSync(path.join(ROOT, 'server/src/comic/library/adminSpend.ts'), 'utf8');
    const config = readFileSync(path.join(ROOT, 'server/src/config.ts'), 'utf8');
    const read = [...adminSpend.matchAll(/export const \w+_ENV = '([A-Z0-9_]+)'/g)].map((m) => m[1]);
    expect(read.sort()).toEqual(['COMIC_ADMIN_SPEND_KEY', 'COMIC_LIBRARY_MONTHLY_CAP_USD', 'DREAMSTREAMSTUDIO_MODELTEST']);
    expect(config).toContain('process.env.COMIC_LIBRARY_PRESET_BOARD');
    for (const name of [...read, 'COMIC_LIBRARY_PRESET_BOARD']) {
      const rows = firstCells.filter((c) => c.split(/[\s/→,]+/).includes(name));
      expect(rows, name).toHaveLength(1);
    }
  });

  it('maps every Program 5 server flag, each in exactly one row (R01: P5-TRUTH, P5-QC)', () => {
    // The names come from p5Flags.ts, so a renamed or new flag fails here until the map follows.
    const flags = readFileSync(path.join(ROOT, 'server/src/comic/p5Flags.ts'), 'utf8');
    const block = flags.slice(flags.indexOf('export const P5_FLAG_ENV'), flags.indexOf('} as const'));
    const read = [...block.matchAll(/:\s*'([A-Z0-9_]+)'/g)].map((m) => m[1]);
    expect(read.sort()).toEqual(['COMIC_QC_V2', 'COMIC_RUN_CHAINS', 'COMIC_STORY_FIXES']);
    for (const name of read) {
      const rows = firstCells.filter((c) => c.split(/[\s/→,`]+/).includes(name));
      expect(rows, name).toHaveLength(1);
    }
    // CARD_LINT_STAGE is a code constant, and the map says so (off means a redeploy).
    expect(firstCells.some((c) => c.includes('not an env var') && c.includes('CARD_LINT_STAGE'))).toBe(true);
  });

  it('keeps the live Worker’s Phase 0 variables in the map', () => {
    for (const name of ['ALLOWED_ORIGINS', 'DEVICE_TOKEN_JWK', 'ACT_TOKEN_KEY', 'SECURITY_HOOK_SECRET', 'OPS_KEY', 'APNS_KEY_P8', 'PUSH_IOS_VIA', 'RL_WS', 'CSP_REPORTS']) {
      expect(firstCells.some((c) => c.includes(name)), name).toBe(true);
    }
  });
});

/** The backend `vars` of api-proxy/wrangler.jsonc (its comments are whole lines; strings hold "https://"). */
const wranglerVars = (): Record<string, string> => {
  const raw = readFileSync(path.join(ROOT, 'api-proxy/wrangler.jsonc'), 'utf8');
  const json = raw
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  return (JSON.parse(json) as { vars: Record<string, string> }).vars;
};

describe('Comic Studio stages set in production vars (R00)', () => {
  const vars = wranglerVars();

  it('COMIC_STEER is admins (P5-D3): an admin can steer a running turn, anyone else cannot', () => {
    expect(LIVE_FLAG_DEFAULTS.steer).toBe('off');
    expect(vars.COMIC_STEER).toBe('admins');
    expect(liveCapsFromEnv(vars, true).liveAgent.steer).toBe(true);
    expect(liveCapsFromEnv(vars, false).liveAgent.steer).toBe(false);
    // The matrix row says so.
    const row = text.split('\n').find((l) => l.startsWith('| `COMIC_STEER` |')) ?? '';
    expect(row).toContain('**production: `admins`**');
  });

  it('the truer-pages fixes are admins first: story fixes and the longer page check are set, scene chains are not', () => {
    expect(vars.COMIC_STORY_FIXES).toBe('admins');
    expect(vars.COMIC_QC_V2).toBe('admins');
    expect(vars.COMIC_RUN_CHAINS).toBeUndefined();
    const rowOf = (name: string) => text.split('\n').find((l) => l.startsWith(`| \`${name}\` |`)) ?? '';
    for (const name of ['COMIC_STORY_FIXES', 'COMIC_QC_V2']) expect(rowOf(name), name).toContain('**production: `admins`**');
    expect(rowOf('COMIC_RUN_CHAINS')).toContain('| unset (`off`) |');
    expect(rowOf('COMIC_RUN_CHAINS')).not.toContain('**production:');
  });

  it('sets no other live-agent stage: the queue, conflicts, dialogue fast path and Pro editor follow their code defaults', () => {
    for (const name of ['COMIC_LIVE_QUEUE', 'COMIC_CONFLICT_GUARD', 'COMIC_DIALOGUE_FAST', 'COMIC_PRO_EDITOR_V2']) expect(vars[name], name).toBeUndefined();
    // SF-3: the recorded production value of the Pro editor flag is the code default, admins.
    expect(LIVE_FLAG_DEFAULTS.proEditorV2).toBe('admins');
    const row = text.split('\n').find((l) => l.startsWith('| `COMIC_PRO_EDITOR_V2` |')) ?? '';
    expect(row).toContain('recorded 2026-11-13');
  });
});
