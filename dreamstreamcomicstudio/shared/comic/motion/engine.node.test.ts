// @vitest-environment node
//
// PE-MOTION-ENGINE runs anywhere (master plan §2.5 "Evaluator ... pure, runs in Node"): the server sanitizer
// (PE-SERVER) imports budget.ts and the preset schemas, and the MP4 export and the editor preview share the evaluator.
// This file runs in plain Node: no document, no window, no clock. The source scan keeps it that way.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, type ComicDoc, type Page } from '../doc';
import * as motion from './index';

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE = ['beats', 'easing', 'presets', 'sample', 'reduced', 'budget'];

const nodeDoc = (): { doc: ComicDoc; page: Page } => {
  const doc = createEmptyDoc('proj_node', 'Node', 1);
  doc.format = { ...doc.format, lettering: 'overlay', language: 'ur' };
  const page: Page = {
    id: 'pg_1',
    n: 1,
    summary: '',
    layout: 'Row 1: two panels.',
    panels: [
      { id: 'p1', n: 1, size: 'large', shot: 'wide', action: '', castIds: [], lines: [{ id: 'l1', kind: 'speech', text: 'سلام دوست' }] },
      { id: 'p2', n: 2, size: 'medium', shot: 'close_up', action: '', castIds: [], lines: [{ id: 'l2', kind: 'caption', text: 'چلو چاند تک' }] }
    ],
    render: { status: 'ready', history: [], asset: { path: 'p1.png', source: 'generated', at: 1 } },
    balloons: [],
    motion: {
      clips: [
        { id: 'mc_1', target: { k: 'line', id: 'l1' }, role: 'enter', preset: 'ink-wipe', at: { anchor: 'reveal', ms: 0 } },
        { id: 'mc_2', target: { k: 'panel', id: 'p2' }, role: 'emphasis', preset: 'jitter', at: { anchor: 'panel', ms: 100 }, repeat: 2 },
        { id: 'mc_3', target: { k: 'line', id: 'l2' }, role: 'loop', preset: 'blink', at: { anchor: 'page', ms: 0 } }
      ],
      camera: [{ panelId: 'p1', move: 'push' }]
    }
  };
  doc.pages = [page];
  return { doc, page };
};

describe('the motion engine in plain Node', () => {
  it('has no DOM to lean on, and still plays a page: beats, poses, camera, poster, budgets', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
    const { doc, page } = nodeDoc();
    const beats = motion.pageBeats(doc, page);
    expect(beats.panels.map((p) => p.panelId)).toEqual(['p1', 'p2']);
    const at = motion.lineRevealMs(beats, 'l1')! + 300;
    const poses = motion.sampleAt(doc, page, beats, at, { seed: 3 });
    expect(poses.get('line:l1')).toMatchObject({ mask: 'wipe', dir: 'rtl' });
    expect(JSON.stringify([...motion.sampleAt(doc, page, beats, at, { seed: 3 })])).toBe(JSON.stringify([...poses]));
    expect(motion.cameraAt(doc, page, beats, at)?.move).toBe('push');
    expect([...motion.posterPoses(doc, page).keys()]).toEqual(['line:l1']);
    expect(motion.reducedSampleAt(doc, page, beats, at).get('line:l1')!.reveal).toBe(1);
    expect(motion.pageFlashCheck(page).ok).toBe(true);
    expect(motion.motionBudgetReport(doc).ok).toBe(true);
    expect(motion.presetParamIssues(motion.MOTION_PRESETS.jitter.params, { amount: 1 })).toEqual([{ key: 'amount', reason: 'range' }]);
  });

  it('source scan: the engine modules read no DOM, no clock, no randomness, no network, and import only shared code', () => {
    const files = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const name of ENGINE) expect(files, name).toContain(`${name}.ts`);
    const banned = [
      /\bdocument\b/,
      /\bwindow\b/,
      /\bnavigator\b/,
      /\brequestAnimationFrame\b/,
      /\bperformance\b/,
      /\bDate\.now\b/,
      /\bnew Date\b/,
      /\bMath\.random\b/,
      /\bsetTimeout\b/,
      /\bsetInterval\b/,
      /\bfetch\(/,
      /\blocalStorage\b/,
      /\bgetComputedStyle\b/
    ];
    for (const name of ENGINE) {
      const src = readFileSync(join(here, `${name}.ts`), 'utf8');
      // Comments may name what the code never touches; the scan reads code only.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (const re of banned) expect(re.test(code), `${name}.ts uses ${re}`).toBe(false);
      for (const m of src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) {
        const spec = m[1];
        expect(spec.startsWith('./') || spec.startsWith('../'), `${name}.ts imports ${spec}`).toBe(true);
        expect(spec, `${name}.ts imports ${spec}`).not.toMatch(/components|services|react|server/);
        // Node16 resolution on the server: every relative import names its .js file.
        expect(spec.endsWith('.js'), `${name}.ts imports ${spec} without .js`).toBe(true);
      }
    }
  });

  it('PE-SERVER’s imports exist under stable names', () => {
    for (const name of [
      'clipFlashHz',
      'pageFlashCheck',
      'pageMotionBytes',
      'docMotionBytes',
      'motionBytes',
      'motionBudgetReport',
      'MOTION_PRESETS',
      'CAMERA_MOVES',
      'motionPresetOf',
      'cameraMoveOf',
      'presetParamSchema',
      'cameraParamSchema',
      'presetParamIssues',
      'resolvePresetParams',
      'playableClip',
      'isKnownMotionPreset',
      'isKnownEase'
    ])
      expect(typeof (motion as Record<string, unknown>)[name], name).not.toBe('undefined');
  });
});
