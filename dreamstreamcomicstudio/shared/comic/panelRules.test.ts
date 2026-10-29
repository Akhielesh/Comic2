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
    expect(PLAN_POLICY).toEqual({ holdBackOverfull: true, clampStorybook: true });
    expect(RECURRING).toEqual({ minPages: 2, minPanels: 3 });
    expect([...OFF_PANEL_SHOTS].sort()).toEqual(['establishing', 'insert', 'pov']);
    expect([...QUIET_SHOTS].sort()).toEqual(['insert', 'pov']);
  });
});

describe('panelCountRule', () => {
  it('auto comics plan 3 (2–4; 5 for a fast near-silent sequence); storybooks 1–3; strips 3–4; webtoons 2–5', () => {
    expect(panelCountRule({ kind: 'comic', panelsPerPage: 'auto' })).toEqual({ typical: 3, min: 2, max: 4, fast: { panels: 5, maxWords: 12 } });
    expect(panelCountRule({ kind: 'manga', panelsPerPage: 'auto' }).max).toBe(4);
    expect(panelCountRule({ kind: 'storybook', panelsPerPage: 'auto' })).toEqual({ typical: 2, min: 1, max: 3 });
    expect(panelCountRule({ kind: 'strip', panelsPerPage: 'auto' })).toEqual({ typical: 3, min: 3, max: 4 });
    expect(panelCountRule({ kind: 'webtoon', panelsPerPage: 'auto' })).toEqual({ typical: 3, min: 2, max: 5 });
  });

  it('an explicit count is kept (2–6 in Format, up to 9 for old docs); a storybook above 3 is clamped to 3 with a note', () => {
    expect(panelCountRule({ kind: 'comic', panelsPerPage: 2 })).toMatchObject({ exact: 2 });
    expect(panelCountRule({ kind: 'comic', panelsPerPage: 6 })).toMatchObject({ exact: 6 });
    expect(panelCountRule({ kind: 'comic', panelsPerPage: 12 })).toMatchObject({ exact: 9 });
    expect(panelCountRule({ kind: 'storybook', panelsPerPage: 4 })).toEqual({ typical: 3, min: 3, max: 3, exact: 3, clampedFrom: 4 });
    expect(panelCountRule({ kind: 'storybook', panelsPerPage: 2 })).toMatchObject({ exact: 2 });
    expect(panelCountNote({ kind: 'storybook', panelsPerPage: 4 })).toBe(
      'Storybook pages hold at most 3 large panels, so new pages are planned with 3 (your format asks for 4). Pages already planned keep theirs.'
    );
    expect(panelCountNote({ kind: 'storybook', panelsPerPage: 3 })).toBeUndefined();
    expect(panelCountNote({ kind: 'comic', panelsPerPage: 6 })).toBeUndefined();
  });
});

describe('panelCountProblem', () => {
  it('flags 6 panels on auto, allows 5 only when the page carries ≤ 12 words', () => {
    const auto = { kind: 'comic' as const, panelsPerPage: 'auto' as const };
    expect(panelCountProblem(auto, panels(4, [line('a b c d e f g h i j k l m n o p')]))).toBeUndefined();
    expect(panelCountProblem(auto, panels(6))).toMatchObject({ max: 5 });
    expect(panelCountProblem(auto, panels(5, [line('Run!')]))).toBeUndefined();
    expect(panelCountProblem(auto, panels(5, [line('one two three four five six seven eight nine ten eleven twelve thirteen')]))).toMatchObject({ max: 4, words: 13 });
    // Sound effects are not words on the page.
    expect(panelCountProblem(auto, panels(5, [line('KRAKA-THOOM BOOM BOOM BOOM BOOM BOOM BOOM BOOM BOOM BOOM BOOM BOOM BOOM', 'sfx')]))).toBeUndefined();
    expect(panelCountProblem({ kind: 'storybook', panelsPerPage: 4 }, panels(4))).toMatchObject({ max: 3 });
    expect(panelCountProblem({ kind: 'storybook', panelsPerPage: 4 }, panels(3))).toBeUndefined();
    expect(panelCountProblem({ kind: 'comic', panelsPerPage: 4 }, panels(4))).toBeUndefined();
    expect(panelCountProblem({ kind: 'comic', panelsPerPage: 4 }, panels(5))).toMatchObject({ max: 4 });
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

  it('the fast-sequence exception binds in characters: 5 Japanese panels with 27 characters are flagged', () => {
    const auto = { kind: 'comic' as const, panelsPerPage: 'auto' as const };
    const ja = textUnitFor('ja');
    // Before units: one "word" on the page, so 5 panels always passed.
    expect(panelCountProblem(auto, panels(5, [line(JA_27)]))).toBeUndefined();
    expect(panelCountProblem(auto, panels(5, [line(JA_27)]), { unit: ja })).toMatchObject({ max: 4, words: 27, fastWords: 19 });
    expect(panelCountProblem(auto, panels(5, [line('走れ！')]), { unit: ja })).toBeUndefined();
    expect(pageWords([{ lines: [line(JA_27)] }, { lines: [line('走れ！')] }], ja)).toBe(30);
  });
});

describe('revisionPanelLimit (PD-2: the storybook clamp is for new pages)', () => {
  it('lets an existing storybook page keep up to its own count, never above the format', () => {
    const story4 = { kind: 'storybook' as const, panelsPerPage: 4 };
    expect(revisionPanelLimit(story4)).toBe(3);
    expect(revisionPanelLimit(story4, 2)).toBe(3);
    expect(revisionPanelLimit(story4, 4)).toBe(4);
    expect(revisionPanelLimit(story4, 7)).toBe(4);
    expect(revisionPanelLimit({ kind: 'comic', panelsPerPage: 4 }, 6)).toBe(4); // no clamp: the author's count holds
    expect(panelCountProblem(story4, panels(4), { existing: 4 })).toBeUndefined();
    expect(panelCountProblem(story4, panels(5), { existing: 4 })).toMatchObject({ max: 4 });
    expect(panelCountProblem(story4, panels(4))).toMatchObject({ max: 3 }); // a new page is still clamped
  });
});
