// shared/comic/panelRules.ts: fewer, larger panels (plan §4.1 table, §5.1 PANEL_LIMITS).
import { describe, expect, it } from 'vitest';
import type { Line, Panel } from './doc';
import {
  OFF_PANEL_SHOTS,
  PANEL_LIMITS,
  PLAN_POLICY,
  QUIET_SHOTS,
  RECURRING,
  minAreaFor,
  pageWords,
  panelCountNote,
  panelCountProblem,
  panelCountRule,
  panelWords
} from './panelRules';

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
