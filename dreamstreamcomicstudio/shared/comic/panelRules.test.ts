// shared/comic/panelRules.ts: fewer, larger panels (plan §4.1 table, §5.1 PANEL_LIMITS).
import { describe, expect, it } from 'vitest';
import type { Line, Panel } from './doc';
import {
  OFF_PANEL_SHOTS,
  PANEL_LIMITS,
  PLAN_POLICY,
  QUIET_SHOTS,
  RECURRING,
  BALLOON_BASE,
  WORD_COST,
  countText,
  minAreaFor,
  pageWords,
  panelCountNote,
  panelCountProblem,
  panelCountRule,
  panelWords,
  revisionPanelLimit,
  scaledLimit,
  textBudget,
  textUnitFor,
  unitCount,
  wordBudget
} from './panelRules';
import * as density from './density';

const line = (text: string, kind: Line['kind'] = 'speech'): Line => ({ id: `ln_${text.length}_${kind}`, kind, text });
const panels = (n: number, lines: Line[] = []): Pick<Panel, 'lines'>[] => Array.from({ length: n }, (_, i) => ({ lines: i === 0 ? lines : [] }));

describe('PANEL_LIMITS', () => {
  it('carries the contract numbers other packages read', () => {
    expect(PANEL_LIMITS).toMatchObject({
      autoTypical: 3,
      autoMax: 5,
      storybookMax: 3,
      codeMax: 9,
      minArea: 0.15,
      minInsertArea: 0.08,
      fitRoomy: 0.18,
      fitTarget: 0.22,
      fitHard: 0.3,
      fitHardKids: 0.25,
      wordsCap: 40,
      coverCap: 0.3,
      coverCapKids: 0.25
    });
    expect(PANEL_LIMITS.uiChoices).toEqual([2, 3, 4, 5, 6]);
    expect(PLAN_POLICY).toEqual({ holdBackOverfull: true, clampStorybook: false });
    expect(RECURRING).toEqual({ minPages: 2, minPanels: 3 });
    expect([...OFF_PANEL_SHOTS].sort()).toEqual(['establishing', 'insert', 'pov']);
    expect([...QUIET_SHOTS].sort()).toEqual(['insert', 'pov']);
  });
});

describe('adaptive panel counts', () => {
  it.each(['comic', 'manga', 'storybook', 'strip', 'webtoon'] as const)('allows scene-driven counts for %s, regardless of density preference', (kind) => {
    for (const preferred of ['auto', 2, 6] as const) {
      const format = { kind, panelsPerPage: preferred };
      expect(panelCountRule(format)).toMatchObject({ min: 1, max: 9 });
      expect(panelCountRule(format).exact).toBeUndefined();
      expect(panelCountNote(format)).toBeUndefined();
      for (const n of [1, 3, 6, 9]) expect(panelCountProblem(format, panels(n, [line('Dialogue follows the scene.')]))).toBeUndefined();
      expect(panelCountProblem(format, panels(10))).toMatchObject({ max: 9 });
    }
  });
});

describe('minAreaFor / words', () => {
  it('a silent insert or close-up may be small (0.08); anything with words or a wider shot needs 0.15', () => {
    expect(minAreaFor({ shot: 'insert', lines: [] })).toBe(0.08);
    expect(minAreaFor({ shot: 'close_up', lines: [line('POP', 'sfx')] })).toBe(0.08);
    expect(minAreaFor({ shot: 'close_up', lines: [line('Wait.')] })).toBe(0.15);
    expect(minAreaFor({ shot: 'medium', lines: [] })).toBe(0.15);
    expect(panelWords({ lines: [line('Two words'), line('Three more words', 'caption'), line('BANG', 'sfx')] })).toBe(5);
    expect(pageWords([{ lines: [line('a b')] }, { lines: [line('c')] }])).toBe(3);
  });
});

describe('word budget home (no density.ts ↔ lettering/layout.ts cycle)', () => {
  it('wordBudget and its oracle live in panelRules and density re-exports the very same bindings', () => {
    expect(density.wordBudget).toBe(wordBudget);
    expect(density.BALLOON_BASE).toBe(BALLOON_BASE);
    expect(density.WORD_COST).toBe(WORD_COST);
    expect([0.084, 0.144, 0.221, 0.451].map((a) => wordBudget(a))).toEqual([11, 20, 32, 40]);
  });
});

describe('text units (Japanese and Chinese count characters)', () => {
  // Synthetic lines (no production text).
  const JA_27 = 'この荷台にはナンバーがない。朝から誰も降ろしていない。'; // 27 non-space characters
  const ZH = '你好，世界';

  it('counts graphemes for char-unit languages and scales the English limits by perLine ÷ 25', () => {
    const ja = textUnitFor('ja');
    expect(ja).toMatchObject({ unit: 'chars', noun: 'character', k: 1.6 });
    expect(textUnitFor('zh-Hans')).toMatchObject({ unit: 'chars', k: 1.2 });
    expect(textUnitFor('en')).toMatchObject({ unit: 'words', noun: 'word', k: 1 });
    expect(textUnitFor(undefined)).toMatchObject({ unit: 'words', k: 1 });
    expect(countText(JA_27, ja)).toBe(27);
    expect(countText('朝 から', ja)).toBe(3); // whitespace is not a character on the page
    expect(countText(ZH, textUnitFor('zh-Hans'))).toBe(5);
    expect(countText(JA_27)).toBe(1); // the English word count sees one "word" — the bug the unit fixes
    expect(scaledLimit(PANEL_LIMITS.quietShotMaxWords, ja)).toBe(19);
    expect(scaledLimit(PANEL_LIMITS.fastSequenceWords)).toBe(12);
    expect(textBudget(0.084, 1, ja)).toBe(17);
    expect(textBudget(0.451, 1, ja)).toBe(64);
    expect(textBudget(0.221)).toBe(32);
    expect(unitCount(1, ja)).toBe('1 character');
    expect(unitCount(29)).toBe('29 words');
    expect(panelWords({ lines: [line(JA_27), line('ドン', 'sfx')] }, ja)).toBe(27);
  });

  it('does not impose a count cap based on script or word count', () => {
    expect(panelCountProblem({ kind: 'comic', panelsPerPage: 'auto' }, panels(5, [line('あいうえお'.repeat(8))]), { unit: textUnitFor('ja') })).toBeUndefined();
  });
});

describe('revisionPanelLimit (PD-2: the storybook clamp is for new pages)', () => {
  it('keeps the same technical capacity for new and revised pages', () => {
    expect(revisionPanelLimit({ kind: 'storybook', panelsPerPage: 2 }, 4)).toBe(9);
    expect(revisionPanelLimit({ kind: 'comic', panelsPerPage: 'auto' })).toBe(9);
  });
});
