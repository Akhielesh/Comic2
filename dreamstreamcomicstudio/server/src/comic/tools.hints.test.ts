// Per-turn tool budget vs dialogue phrasing (agent-editor plan §0 spot-check 5, §3 B3, §4 0a).
//
// The director offers core tools plus the feature groups whose words appear in the turn (GROUP_HINTS), trimmed to
// MAX_TOOLS_PER_TURN. Before 0a, "move Mira's line to the top left" and "swap the order of these two lines" lost the
// whole lettering group: the lettering hint had no line / top / corner words, while breakdown's bare `left` and the
// timeline's move / swap made those groups hot and they took the budget. These tests run the REAL registry
// (toolGroups()) on two golden fixtures, exactly as director.ts builds a turn.

import { describe, expect, it } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc.js';
import type { StudioFocus } from '../../../shared/comic/events.js';
import { MAX_TOOLS_PER_TURN } from './extensions.js';
import { lakeDrawnDoc, sixPageDrawnDoc } from './golden/fixtures.js';
import { newSession, plannedDoc, testContext } from './orchestrator.fakes.js';
import { GROUP_HINTS, RESERVED_CORE_TOOLS, buildDirectorTools, buildTurnToolset, createDirectorTurn } from './tools.js';
import { toolGroups } from './tools/index.js';

/** The dialogue phrases of plan §0 spot-check 5 / §3 B4 (the first and fifth were trimmed before 0a). */
const PHRASES = [
  "move Mira's line to the top left",
  'make it a whisper',
  'turn that into a thought bubble',
  'put the narration in a caption box at the bottom',
  'swap the order of these two lines',
  'the second panel needs a shout',
  'the tail should point at the robot'
];

const FIXTURES: Record<string, () => ComicDoc> = { plannedDoc: () => plannedDoc(), lakeDrawnDoc };

const offered = (doc: ComicDoc, userText: string, focus?: StudioFocus) => {
  const ctx = testContext(newSession(doc));
  const set = buildTurnToolset(ctx, createDirectorTurn({ userText, ...(focus ? { focus } : {}) }), toolGroups());
  return { set, names: set.tools.map((t) => t.spec.function.name), core: buildDirectorTools(ctx).map((t) => t.spec.function.name) };
};

describe('dialogue phrases keep the lettering tools in the per-turn budget', () => {
  for (const [fixture, make] of Object.entries(FIXTURES)) {
    for (const phrase of PHRASES) {
      it(`${fixture}: "${phrase}" offers arrange_balloons`, () => {
        const { set, names } = offered(make(), phrase);
        expect(set.groups, phrase).toContain('lettering');
        // The lettering group is offered whole: placement, restyle and the comic-wide style tool together.
        expect(names, phrase).toEqual(expect.arrayContaining(['arrange_balloons', 'restyle_balloons', 'set_lettering_style']));
        expect(names.length).toBeLessThanOrEqual(MAX_TOOLS_PER_TURN);
      });
    }
  }
});

describe('GROUP_HINTS (0a)', () => {
  it('lettering wakes on dialogue, speech and position words', () => {
    const lettering = GROUP_HINTS.lettering!;
    for (const say of [
      "move Mira's line to the top left",
      'make Leo’s lines italic',
      'the dialogue is too long',
      'Leo said it first',
      'Leo says wait for me',
      'make it a speech bubble',
      'put it in the corner',
      'put it at the top of the page',
      'caption at the bottom',
      'no tail',
      'the tails cross',
      'whisper it',
      'too many whispers'
    ]) {
      expect(lettering.test(say), say).toBe(true);
    }
  });

  it('position words do not wake lettering on a page move', () => {
    const lettering = GROUP_HINTS.lettering!;
    for (const say of ['move page 3 to the top', 'put page 2 at the bottom', 'swap pages 2 and 3 and put them on top']) {
      expect(lettering.test(say), say).toBe(false);
    }
    // ...but a balloon placed "of the page" is still lettering.
    expect(lettering.test('put it at the top left of the page')).toBe(true);
  });

  it('page actions keep the timeline tools on a drawn multi-page book (breakdown and lettering yield)', () => {
    const cases: [string, string][] = [
      ['move page 3 to the top', 'move_page'],
      ['delete page 4', 'delete_page'],
      ['insert a page after page 3', 'insert_page'],
      ['duplicate page 2', 'duplicate_page']
    ];
    for (const [fixture, make] of Object.entries({ plannedDoc: () => plannedDoc(), sixPageDrawnDoc })) {
      for (const [say, tool] of cases) {
        const { set, names } = offered(make(), say);
        expect(set.groups, `${fixture}: ${say}`).toContain('timeline');
        expect(names, `${fixture}: ${say}`).toContain(tool);
      }
    }
    // The page word alone still wakes breakdown when no page action is named.
    expect(GROUP_HINTS.breakdown!.test('the second panel needs a shout')).toBe(true);
    expect(GROUP_HINTS.breakdown!.test('delete page 4')).toBe(false);
    expect(GROUP_HINTS.breakdown!.test('delete page 4 and tell me the cost')).toBe(true);
  });

  it("breakdown's `left` means what is left, never the left side", () => {
    const breakdown = GROUP_HINTS.breakdown!;
    for (const say of ['put it on the left', 'move it to the top left', 'left corner']) expect(breakdown.test(say), say).toBe(false);
    for (const say of ["what's left?", 'what’s left to draw', 'how many pages left', 'anything left to do']) expect(breakdown.test(say), say).toBe(true);
  });

  it('the timeline hint never starves lettering: both hot keeps lettering (lower priority number first)', () => {
    for (const [fixture, make] of Object.entries(FIXTURES)) {
      for (const say of ['swap the order of these two lines', "move Mira's line to the top left", 'move this line to panel 3']) {
        const { set } = offered(make(), say);
        expect(GROUP_HINTS.timeline!.test(say), say).toBe(true);
        expect(set.groups, `${fixture}: ${say}`).toContain('lettering');
      }
    }
  });

  it('selected balloons make the lettering group relevant even without a lettering word ("swap these two")', () => {
    for (const [fixture, make] of Object.entries(FIXTURES)) {
      const doc = make();
      const page = doc.pages.find((p) => p.panels.some((pn) => pn.lines.length))!;
      const lineIds = doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines.map((l) => l.id))).slice(0, 2);
      expect(lineIds.length, fixture).toBeGreaterThan(0);
      for (const say of ['swap these two', 'move it up a bit', 'send it back']) {
        expect(GROUP_HINTS.lettering!.test(say), say).toBe(false);
        const { names } = offered(make(), say, { pageId: page.id, lineIds });
        expect(names, `${fixture}: ${say}`).toContain('arrange_balloons');
      }
    }
  });
});

describe('reserved core slot for dialogue_edit (plan §3 B3)', () => {
  it('names dialogue_edit as a reserved core tool', () => {
    expect(RESERVED_CORE_TOOLS).toContain('dialogue_edit');
  });

  it('keeps one seat free for every reserved core tool the core list does not carry yet', () => {
    for (const make of Object.values(FIXTURES)) {
      for (const say of [...PHRASES, '', 'make the shouts red and move page 2 to the end', 'just switch it to GPT']) {
        const { names, core } = offered(make(), say);
        const missing = RESERVED_CORE_TOOLS.filter((n) => !core.includes(n)).length;
        expect(names.length, say).toBeLessThanOrEqual(MAX_TOOLS_PER_TURN - missing);
      }
    }
  });

  it('an explicit maxTools stays the whole budget (tests and callers that size the turn themselves)', () => {
    const ctx = testContext(newSession(plannedDoc()));
    const core = buildDirectorTools(ctx).length;
    const set = buildTurnToolset(ctx, createDirectorTurn({ userText: 'make it a whisper' }), toolGroups(), { maxTools: core + 3 });
    expect(set.groups).toEqual(['lettering']);
    expect(set.tools).toHaveLength(core + 3);
  });
});
