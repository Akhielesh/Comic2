// Per-turn tool budget vs dialogue phrasing (agent-editor plan §0 spot-check 5, §3 B3, §4 0a).
//
// The director offers core tools plus the feature groups whose words appear in the turn (GROUP_HINTS), trimmed to
// MAX_TOOLS_PER_TURN. Before 0a, "move Mira's line to the top left" and "swap the order of these two lines" lost the
// whole lettering group: the lettering hint had no line / top / corner words, while breakdown's bare `left` and the
// timeline's move / swap made those groups hot and they took the budget. These tests run the REAL registry
// (toolGroups()) on two golden fixtures, exactly as director.ts builds a turn.

import { describe, expect, it } from 'vitest';
import { LAKE_MODEL, makeLakeComic } from '../../../shared/comic/__fixtures__/lakeComic.js';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities.js';
import type { ComicDoc } from '../../../shared/comic/doc.js';
import type { StudioFocus } from '../../../shared/comic/events.js';
import { MAX_TOOLS_PER_TURN } from './extensions.js';
import { lakeDrawnDoc, sixPageDrawnDoc } from './golden/fixtures.js';
import { newSession, plannedDoc, testContext } from './orchestrator.fakes.js';
import { GROUP_HINTS, RESERVED_CORE_TOOLS, buildDirectorTools, buildTurnToolset, createDirectorTurn } from './tools.js';
import { toolGroups } from './tools/index.js';
import { LANGUAGE_HINT_RE } from './tools/languageAsk.js';
import { isLanguageAsk } from './tools/i18n.js';

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

/**
 * A drawn, model-locked five-page book whose pages have versions: its timeline group is 7 tools (move/insert/duplicate/
 * delete_page, list_versions, use_version, set_book), so core + timeline fills the budget and any other hot group with a
 * lower priority number (lettering 20, breakdown 10) trims the WHOLE timeline. The page-action guards must hold here.
 */
const lockedLakeDoc = () => makeLakeComic((d) => (d.imageModel = { modelId: LAKE_MODEL, lockedAt: 1, origin: 'first_render' }));
const TIMELINE_PAGE_TOOLS = ['move_page', 'insert_page', 'duplicate_page', 'delete_page', 'use_version'];

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

  it('position words do not wake lettering when a page is the object of the sentence', () => {
    const lettering = GROUP_HINTS.lettering!;
    for (const say of [
      'move page 3 to the top',
      'put page 2 at the bottom',
      'swap pages 2 and 3 and put them on top',
      'move the second page to the top',
      'move the last page to the top',
      'can you move my third page to the top of the book?',
      'duplicate the top page',
      'delete the page at the bottom',
      'restore the previous version of the top page',
      'remove page 4 from the bottom of the book'
    ]) {
      expect(lettering.test(say), say).toBe(false);
    }
    // ...but a page named as the frame ("of / on / in / at the page") is still a balloon placement.
    for (const say of ['put it at the top left of the page', 'put the caption at the bottom of page 3', 'move it to the top of page 2', 'put it in the corner on this page']) {
      expect(lettering.test(say), say).toBe(true);
    }
  });

  it('page actions keep the timeline tools on a drawn multi-page book (breakdown and lettering yield)', () => {
    const cases: [string, string][] = [
      ['move page 3 to the top', 'move_page'],
      ['delete page 4', 'delete_page'],
      ['insert a page after page 3', 'insert_page'],
      ['duplicate page 2', 'duplicate_page']
    ];
    for (const [fixture, make] of Object.entries({ plannedDoc: () => plannedDoc(), sixPageDrawnDoc, lockedLakeDoc })) {
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

describe('page actions on a drawn book with a 7-tool timeline (lettering yields)', () => {
  it('the fixture really carries the 7-tool timeline that fills the budget', () => {
    const ctx = testContext(newSession(lockedLakeDoc()));
    const turn = createDirectorTurn({ userText: 'x' });
    const timeline = toolGroups().find((g) => g.id === 'timeline')!;
    expect(timeline.when?.(ctx, turn) ?? true).toBe(true);
    expect(timeline.tools(ctx, turn)).toHaveLength(7);
  });

  // "top / bottom" here are about the book: before the PAGE_OBJECT guard these woke lettering (priority 20, ahead of the
  // timeline's 30), and core 21 + lettering 3 + timeline 7 = 31 is over the budget, so every page tool was trimmed.
  for (const say of [
    'move the second page to the top',
    'move the last page to the top',
    'duplicate the top page',
    'delete the page at the bottom',
    'restore the previous version of the top page',
    'remove page 4 from the bottom of the book'
  ]) {
    it(`"${say}" offers move_page / delete_page / duplicate_page / use_version`, () => {
      const { set, names } = offered(lockedLakeDoc(), say);
      expect(set.groups, say).toContain('timeline');
      expect(names, say).toEqual(expect.arrayContaining(TIMELINE_PAGE_TOOLS));
    });
  }

  it('a selected balloon does not turn a page action into a lettering turn', () => {
    const doc = lockedLakeDoc();
    const page = doc.pages.find((p) => p.panels.some((pn) => pn.lines.length))!;
    const focus: StudioFocus = { pageId: page.id, lineIds: [page.panels.flatMap((pn) => pn.lines)[0].id] };
    for (const [say, tool] of [
      ['delete page 4', 'delete_page'],
      ['move page 3 to the end', 'move_page'],
      ['duplicate page 2', 'duplicate_page'],
      ['insert a page after page 3', 'insert_page']
    ] as const) {
      const { set, names } = offered(lockedLakeDoc(), say, focus);
      expect(set.groups, say).toContain('timeline');
      expect(names, say).toContain(tool);
    }
    // ...while a sentence about the selection itself still offers the balloon tools.
    for (const say of ['swap these two', 'move it up a bit', 'move it to the top of page 2']) {
      const { set, names } = offered(lockedLakeDoc(), say, focus);
      expect(set.groups, say).toContain('lettering');
      expect(names, say).toContain('arrange_balloons');
    }
  });
});

describe('lettering AND a page action in one sentence, on a drawn unlocked book (B-TOOL review)', () => {
  // plannedDoc grown to 4 drawn pages, model not locked: its timeline group is 5 tools. Core (22, dialogue_edit in it)
  // + lettering 3 + timeline 5 = 30 exactly; a 23rd core tool (offer_next, before the fix) trimmed the whole timeline.
  const drawnFourPages = () => {
    const doc = plannedDoc();
    const extra = JSON.parse(JSON.stringify(doc.pages[2]).replace(/_3(?=["_])/g, '_4'));
    extra.n = 4;
    doc.pages.push(extra);
    for (const p of doc.pages) p.render = { ...p.render, status: 'ready', asset: { path: `${p.id}.png` } } as typeof p.render;
    return doc;
  };
  for (const say of ['delete page 4 and fix the speech bubble', 'swap pages 2 and 3 and move the balloon up', 'move page 2 after page 3 and make the caption bigger']) {
    it(`"${say}" offers both the timeline and lettering`, () => {
      const ctx = testContext(newSession(drawnFourPages()), { caps: { ...DEFAULT_CAPS, admin: true } });
      const set = buildTurnToolset(ctx, createDirectorTurn({ userText: say }), toolGroups());
      const names = set.tools.map((t) => t.spec.function.name);
      expect(set.groups, say).toEqual(expect.arrayContaining(['timeline', 'lettering']));
      expect(names, say).toEqual(expect.arrayContaining(['delete_page', 'move_page', 'arrange_balloons', 'restyle_balloons', 'dialogue_edit']));
      expect(names.length).toBeLessThanOrEqual(MAX_TOOLS_PER_TURN);
    });
  }
});

describe('a language ask on a drawn book keeps the language tools (GROUP_HINTS.i18n from the language-ask words)', () => {
  // Before: the i18n hint listed 21 language names by hand. "make an Indonesian version" and "in my mother tongue please"
  // matched none, so on a book with pages the language group sorted behind the hot timeline and the cap trimmed it whole.
  const ASKS = ['make an Indonesian version', 'in my mother tongue please', 'can we get it in Bahasa Indonesia', 'una edición en español', 'add Hindi subtitles'];
  const DRAWN: Record<string, () => ComicDoc> = { sixPageDrawnDoc, lockedLakeDoc };

  it('the hint is the one list in tools/languageAsk.ts, and every language ask wakes it', () => {
    expect(GROUP_HINTS.i18n).toBe(LANGUAGE_HINT_RE);
    for (const ask of [...ASKS, 'add telugu and hindi versions', 'translate the book into Hindi', 'हिंदी version भी बनाओ', '日本語でお願い']) {
      expect(GROUP_HINTS.i18n!.test(ask), ask).toBe(true);
    }
    // A bare "version" is a take, not a language: it does not seat the language group first.
    for (const say of ['use version 2 of page 3', 'restore the previous version of page 2', 'make the hero taller', 'polish the dialogue']) {
      expect(GROUP_HINTS.i18n!.test(say), say).toBe(false);
    }
  });

  for (const [fixture, make] of Object.entries(DRAWN)) {
    for (const ask of ASKS) {
      it(`${fixture}: "${ask}" offers translate_comic`, () => {
        const { set, names } = offered(make(), ask);
        expect(set.groups, ask).toContain('i18n');
        expect(names, ask).toEqual(expect.arrayContaining(['translate_comic', 'read_translation']));
        expect(names.length).toBeLessThanOrEqual(MAX_TOOLS_PER_TURN);
      });
    }
  }

  // Page-shaped asks that name a language are still the timeline's: the hint does not take their seats.
  for (const [say, tool] of [
    ['put page 3 before page 2 in the Hindi version', 'move_page'],
    ['restore the previous version of page 2 in Hindi', 'use_version'],
    ['delete page 3 of the Indonesian edition', 'delete_page'],
    ['make the Hindi edition a square book', 'set_book']
  ] as const) {
    it(`lockedLakeDoc: "${say}" keeps ${tool}`, () => {
      expect(isLanguageAsk(say), say).toBe(false);
      const { set, names } = offered(lockedLakeDoc(), say);
      expect(set.groups, say).toContain('timeline');
      expect(names, say).toContain(tool);
    });
  }
});

describe('reserved core slot for dialogue_edit (plan §3 B3)', () => {
  it('dialogue_edit took its reserved seat: a core tool now, so nothing is reserved any more (wave 2 B-TOOL)', () => {
    const ctx = testContext(newSession(plannedDoc()));
    expect(buildDirectorTools(ctx).map((t) => t.spec.function.name)).toContain('dialogue_edit');
    expect(RESERVED_CORE_TOOLS).toEqual([]);
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
