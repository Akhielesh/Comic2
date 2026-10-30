import { describe, expect, it } from 'vitest';
import { harbourComic } from './__fixtures__/consistencyBooks';
import { CONSISTENCY_LIMITS, PRO_PAGE_LIMITS } from './limits';
import type { ComicDoc, Panel, PanelDirection } from './doc';
import {
  DIRECTION_DROP_ORDER,
  SHOT_LENSES,
  deriveDirection,
  directionPhrases,
  drawnCastIds,
  lensForShot,
  lintDirections,
  normalizeDirection,
  offPanelSpeakerIds,
  povViewerOf,
  undrawnSpeakers,
  type DirectionIssueKind
} from './directions';

const panel = (over: Partial<Panel> = {}): Panel => ({
  id: 'pn_1',
  n: 1,
  size: 'medium',
  shot: 'medium',
  action: 'Meera crouches at the gate.',
  castIds: ['c_meera'],
  lines: [],
  ...over
});

const withDirections = (dirs: Record<string, PanelDirection>, mutate?: (doc: ComicDoc) => void): ComicDoc =>
  harbourComic((doc) => {
    doc.pages = doc.pages.map((p) => ({ ...p, panels: p.panels.map((pn) => (dirs[pn.id] ? { ...pn, direction: dirs[pn.id] } : pn)) }));
    mutate?.(doc);
  });

const lintKinds = (doc: ComicDoc): DirectionIssueKind[] => lintDirections(doc).map((i) => i.kind);

describe('normalizeDirection — clipping', () => {
  it('clips every text and list to the contract limits', () => {
    const long = 'x'.repeat(500);
    const d = normalizeDirection(
      {
        composition: long,
        light: long,
        background: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        cast: { c_meera: { expression: long, holding: ['1', '2', '3', '4', '5', '6', '7', '8'], pos: 'left', depth: 'fg' } },
        by: 'writer'
      },
      panel()
    );
    expect(d.composition).toHaveLength(PRO_PAGE_LIMITS.directionTextChars);
    expect(d.light).toHaveLength(PRO_PAGE_LIMITS.directionTextChars);
    expect(d.background).toHaveLength(CONSISTENCY_LIMITS.directionBackground);
    expect(d.cast!.c_meera.expression).toHaveLength(PRO_PAGE_LIMITS.directionCastTextChars);
    expect(d.cast!.c_meera.holding).toHaveLength(PRO_PAGE_LIMITS.directionListItems);
    expect(d.by).toBe('writer');
  });

  it('is idempotent', () => {
    const raw = { lens: 'macro', cast: { c_meera: { pose: 'kneels' }, c_ravi: { pose: 'runs' } }, offPanel: ['c_meera', 'c_ravi'], by: 'writer' };
    const p = panel({ shot: 'establishing', lines: [{ id: 'l1', kind: 'speech', speakerId: 'c_guard', text: 'Halt!' }] });
    const once = normalizeDirection(raw, p);
    expect(normalizeDirection(once, p)).toEqual(once);
  });
});

describe('normalizeDirection — lens and shot', () => {
  it('a lens that fights the shot becomes the shot lens; a fitting one stays; a missing one is filled', () => {
    expect(normalizeDirection({ lens: 'wide' }, panel({ shot: 'close_up' })).lens).toBe('long');
    expect(normalizeDirection({ lens: 'macro' }, panel({ shot: 'establishing' })).lens).toBe('wide');
    expect(normalizeDirection({ lens: 'long' }, panel({ shot: 'medium' })).lens).toBe('long');
    expect(normalizeDirection({ light: 'dusk' }, panel({ shot: 'extreme_close_up' })).lens).toBe('macro');
    for (const shot of Object.keys(SHOT_LENSES) as (keyof typeof SHOT_LENSES)[]) expect(SHOT_LENSES[shot][0]).toBe(lensForShot(shot));
  });
});

describe('normalizeDirection — who is drawn and who is heard', () => {
  it('offPanel never lists someone drawn; an unseen speaker is always off-panel; unknown cast is dropped', () => {
    const doc = harbourComic();
    const p = panel({
      castIds: ['c_meera'],
      lines: [
        { id: 'l1', kind: 'speech', speakerId: 'c_ravi', text: 'Over here!' },
        { id: 'l2', kind: 'caption', text: 'Later.' },
        { id: 'l3', kind: 'speech', speakerId: 'c_meera', text: 'Coming.' }
      ]
    });
    const d = normalizeDirection({ offPanel: ['c_meera', 'c_ghost', 'c_guard'], cast: { c_meera: { expression: 'tense' }, c_ravi: { pose: 'waves' } } }, p, doc);
    expect(d.offPanel).toEqual(['c_guard', 'c_ravi']);
    expect(d.offPanel).not.toContain('c_meera');
    expect(Object.keys(d.cast!)).toEqual(['c_meera']);
    expect(undrawnSpeakers(p)).toEqual(['c_ravi']);
  });

  it('nothing valid left → a deterministic derived direction (the plan never fails)', () => {
    const p = panel({ shot: 'insert', castIds: [], lines: [{ id: 'l1', kind: 'whisper', speakerId: 'c_meera', text: 'Now.' }] });
    for (const raw of [undefined, null, 'garbage', 42, { lens: 'fisheye', pos: 'up' }]) {
      expect(normalizeDirection(raw, p)).toEqual({ lens: 'macro', offPanel: ['c_meera'], by: 'derived' });
    }
    expect(deriveDirection(panel())).toEqual({ lens: 'normal', by: 'derived' });
  });
});

describe('point-of-view panels and empty lines — the page prompt’s drawn cast', () => {
  const doc = harbourComic();
  const pov = panel({
    shot: 'pov',
    action: "From Ravi's view, Meera backs away from the gate.",
    castIds: ['c_meera', 'c_ravi'],
    lines: [
      { id: 'l1', kind: 'speech', speakerId: 'c_ravi', text: 'Stop!' },
      { id: 'l2', kind: 'speech', speakerId: 'c_guard', text: '   ' }
    ]
  });

  it('the named viewer is heard, not drawn: off-panel, no cast entry, no Who phrase', () => {
    expect(povViewerOf(doc, pov)?.id).toBe('c_ravi');
    expect(drawnCastIds(doc, pov)).toEqual(['c_meera']);
    expect(undrawnSpeakers(pov, doc)).toEqual(['c_ravi']);
    expect(offPanelSpeakerIds(doc, pov)).toEqual(['c_ravi']);
    const d = normalizeDirection({ cast: { c_meera: { pos: 'left' }, c_ravi: { pos: 'right', expression: 'angry' } }, by: 'writer' }, pov, doc);
    expect(d.offPanel).toEqual(['c_ravi']);
    expect(Object.keys(d.cast!)).toEqual(['c_meera']);
    expect(normalizeDirection(d, pov, doc)).toEqual(d);
    expect(deriveDirection(pov, doc)).toEqual({ lens: 'normal', offPanel: ['c_ravi'], by: 'derived' });
    // A stored direction that still directs the viewer (or lists a drawn character off-panel) never puts them in Who.
    const stored: PanelDirection = { cast: { c_meera: { pos: 'left' }, c_ravi: { pos: 'right', expression: 'angry' } }, offPanel: ['c_ravi', 'c_meera'] };
    const phrases = directionPhrases({ ...pov, direction: stored }, doc);
    expect(phrases.who.map((w) => w.text)).toEqual(['MEERA (left)']);
    expect(phrases.offPanel).toEqual([{ castId: 'c_ravi', name: 'RAVI' }]);
    // A POV shot that names nobody keeps its cast drawn.
    expect(drawnCastIds(doc, { ...pov, action: 'A blur of tarps and sacks.' })).toEqual(['c_meera', 'c_ravi']);
  });

  it('lint: the viewer marked off-panel is fine; directing the viewer is "not drawn"', () => {
    const doc2 = withDirections({ pg_2_p1: { offPanel: ['c_ravi'], cast: { c_meera: { pos: 'left' } } } }, (d) => {
      const p = d.pages[1].panels[0];
      d.pages[1].panels[0] = { ...p, shot: 'pov', action: "Through Ravi's eyes, Meera turns.", lines: [{ id: 'l1', kind: 'speech', speakerId: 'c_ravi', text: 'Wait.' }] };
    });
    expect(lintDirections(doc2)).toEqual([]);
    doc2.pages[1].panels[0].direction = { cast: { c_meera: { pos: 'left' }, c_ravi: { pos: 'left' } } };
    expect(lintKinds(doc2)).toEqual(['cast_not_drawn', 'speaker_unplaced']);
  });

  it('a line with no words never makes an off-panel voice', () => {
    const blank = panel({ castIds: [], lines: [{ id: 'l1', kind: 'speech', speakerId: 'c_ravi', text: ' \n ' }] });
    expect(undrawnSpeakers(blank)).toEqual([]);
    expect(undrawnSpeakers(blank, doc)).toEqual([]);
    expect(normalizeDirection(undefined, blank, doc)).toEqual({ lens: 'normal', by: 'derived' });
  });
});

describe('lintDirections', () => {
  it('panels without a direction never lint (I8)', () => {
    expect(lintDirections(harbourComic())).toEqual([]);
  });

  it('names a lens that fights the shot, someone drawn and off-panel, and directions for someone not drawn or unknown', () => {
    const doc = withDirections({
      pg_1_p1: { lens: 'macro', offPanel: ['c_meera'], cast: { c_ravi: { pose: 'leans' }, c_ghost: { pose: 'floats' } } }
    });
    doc.pages[0].panels[0].shot = 'establishing';
    expect(lintKinds(doc)).toEqual(['lens_shot', 'offpanel_drawn', 'cast_not_drawn', 'unknown_cast']);
    const [lens, both] = lintDirections(doc);
    expect(lens.text).toBe('Panel 1 on page 1 is an establishing shot but asks for a macro lens.');
    expect(both).toMatchObject({ severity: 'major', castId: 'c_meera', panel: 1, n: 1 });
  });

  it('names an unseen speaker not marked off-panel and two people in one spot', () => {
    const doc = withDirections({
      pg_2_p1: { cast: { c_meera: { pos: 'left', depth: 'fg' }, c_ravi: { pos: 'left', depth: 'fg' } } },
      pg_2_p3: { light: 'dusk' }
    });
    doc.pages[1].panels[2].lines = [{ id: 'l1', kind: 'speech', speakerId: 'c_meera', text: 'Wait!' }];
    expect(lintDirections(doc).map((i) => i.text)).toEqual([
      'MEERA and RAVI stand in the same spot in panel 1 on page 2 (left, foreground).',
      "MEERA speaks in panel 3 on page 2 but isn't drawn there or marked as an off-panel voice."
    ]);
  });

  it('names an item held against the ledger: held by someone else, or a gone prop', () => {
    const doc = withDirections(
      {
        pg_2_p1: { cast: { c_meera: { holding: ['the lantern'] } } },
        pg_3_p1: { cast: { c_meera: { holding: ['old kite'] } } }
      },
      (d) => {
        d.pages[0].continuity = { cast: { c_ravi: { holding: ['Lantern'] } }, props: { kite: 'torn' } };
        d.pages[1].continuity = { props: { kite: null } };
      }
    );
    expect(lintDirections(doc).map((i) => [i.kind, i.text])).toEqual([
      ['holding_ledger', 'Panel 1 on page 2 shows MEERA holding “the lantern”, but RAVI holds it from page 1.'],
      ['holding_ledger', 'Panel 1 on page 3 shows MEERA holding “old kite”, but “kite” is gone from page 2.']
    ]);
  });
});

describe('directionPhrases', () => {
  const doc = harbourComic();
  const rich: PanelDirection = {
    lens: 'long',
    composition: 'low angle over her shoulder',
    light: 'cold blue dusk',
    palette: 'one red kite',
    focus: 'the recessed plate',
    background: ['wet steps', 'a broken oar', 'gulls'],
    cast: {
      c_meera: { expression: 'wide-eyed', pose: 'crouching', gaze: 'at the plate', holding: ['the lantern'], pos: 'left', depth: 'fg' },
      c_ravi: { gaze: 'the sea', pos: 'right' }
    },
    offPanel: ['c_guard'],
    by: 'writer'
  };
  const p = panel({ castIds: ['c_meera', 'c_ravi'], direction: rich });

  it('builds Who, Detail, camera and off-panel words', () => {
    expect(directionPhrases(p, doc)).toEqual({
      camera: 'long lens; low angle over her shoulder',
      who: [
        {
          castId: 'c_meera',
          text: 'MEERA (left, foreground): wide-eyed, crouching, looking at the plate, holding the lantern',
          place: 'left, foreground',
          state: 'wide-eyed, crouching, looking at the plate, holding the lantern'
        },
        { castId: 'c_ravi', text: 'RAVI (right): looking at the sea', place: 'right', state: 'looking at the sea' }
      ],
      detail: ['background: wet steps, a broken oar, gulls', 'light: cold blue dusk', 'palette accent: one red kite', 'focus: the recessed plate'],
      offPanel: [{ castId: 'c_guard', name: 'GATE GUARD' }]
    });
  });

  it('drops gaze → extra background → composition → pose, in that order', () => {
    expect(DIRECTION_DROP_ORDER).toEqual(['gaze', 'background', 'composition', 'pose']);
    const lv = (drop: number) => directionPhrases(p, doc, { drop });
    expect(lv(1).who[0].text).toBe('MEERA (left, foreground): wide-eyed, crouching, holding the lantern');
    expect(lv(1).detail[0]).toBe('background: wet steps, a broken oar, gulls');
    expect(lv(2).detail[0]).toBe('background: wet steps');
    expect(lv(2).camera).toBe('long lens; low angle over her shoulder');
    expect(lv(3).camera).toBe('long lens');
    expect(lv(3).who[0].text).toBe('MEERA (left, foreground): wide-eyed, crouching, holding the lantern');
    expect(lv(4).who[0].text).toBe('MEERA (left, foreground): wide-eyed, holding the lantern');
    expect(lv(99)).toEqual(lv(4));
    // Each level is no longer than the one before.
    for (let i = 1; i <= 4; i += 1) expect(JSON.stringify(lv(i)).length).toBeLessThan(JSON.stringify(lv(i - 1)).length);
  });

  it('a panel without a direction adds nothing (I8)', () => {
    expect(directionPhrases(panel(), doc)).toEqual({ who: [], detail: [], offPanel: [] });
  });
});
