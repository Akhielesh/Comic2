// B-RESOLVE resolve.ts (agent-editor plan §3 B2): selection wins, scope widens only when empty, 2–5 ask "Which line?",
// more than 5 ask to tap the balloon, plurals apply to every match (confirming first when big), none says what exists.
import { describe, expect, it } from 'vitest';
import type { Line, Resolution } from './types';
import { askForResolution, lineChipLabel, lineHits, resolveLineRef, whichLineChoices, type PluralLineRef } from './resolve';
import { dialogueDoc, line, panel } from './__fixtures__/dialogueDoc';

const ids = (r: Resolution): string[] =>
  r.status === 'lines' || r.status === 'confirm' ? r.lines.map((h) => h.lineId) : r.status === 'which' ? r.candidates.map((h) => h.lineId) : [];

describe('resolveLineRef', () => {
  const doc = dialogueDoc();

  it('selection wins: deixis, or no other target, means the selected balloons', () => {
    expect(resolveLineRef(doc, { selected: true }, { lineIds: ['l_leo1'], pageId: 'pg_1', panelN: 3 })).toMatchObject({ status: 'lines', lines: [{ lineId: 'l_leo1', panelN: 2, speakerId: 'c_leo' }] });
    // No other target at all: still the selection, even though the focus panel has other lines.
    expect(ids(resolveLineRef(doc, {}, { lineIds: ['l_bolt1'], pageId: 'pg_1', panelN: 2 }))).toEqual(['l_bolt1']);
    // A named target is not the selection.
    expect(ids(resolveLineRef(doc, { speaker: 'Leo' }, { lineIds: ['l_bolt1'], pageId: 'pg_1' }))).toEqual(['l_leo1']);
  });

  it('a singular word with 2 or more selected asks; a plural applies to all of them', () => {
    const two = { lineIds: ['l_mira1', 'l_leo1'] };
    expect(resolveLineRef(doc, { selected: true }, two)).toMatchObject({ status: 'which' });
    expect(ids(resolveLineRef(doc, { selected: true }, two))).toEqual(['l_mira1', 'l_leo1']);
    expect(resolveLineRef(doc, { selected: true, all: true } as PluralLineRef, two)).toMatchObject({ status: 'lines' });
    // A kind narrows the selection; nothing left is said honestly.
    expect(ids(resolveLineRef(doc, { selected: true, kind: 'whisper', all: true } as PluralLineRef, { lineIds: ['l_mira1', 'l_mira2'] }))).toEqual(['l_mira2']);
    const none = resolveLineRef(doc, { selected: true, kind: 'shout' }, two);
    expect(none.status).toBe('none');
    expect(none.status === 'none' && none.note).toMatch(/None of the selected balloons/);
  });

  it('scope widens only when empty: focus panel → focus page → recent pages → whole comic', () => {
    // Panel 3 has no Leo; page 1 does.
    expect(ids(resolveLineRef(doc, { speaker: 'Leo' }, { pageId: 'pg_1', panelN: 3 }))).toEqual(['l_leo1']);
    // The focus panel has Mira's line, so her two lines in panel 2 are never considered.
    expect(ids(resolveLineRef(doc, { speaker: 'Mira' }, { pageId: 'pg_1', panelN: 3 }))).toEqual(['l_mira3']);
    // Page 2 has no whisper; a recently touched page 1 does.
    expect(ids(resolveLineRef(doc, { kind: 'whisper' }, { pageId: 'pg_2', panelN: 1, recentPageIds: ['pg_1'] }))).toEqual(['l_mira2']);
    // No focus at all: the whole comic.
    expect(ids(resolveLineRef(doc, { kind: 'thought' }))).toEqual(['l_p2leo']);
    // Leo speaks on both pages; from page 2's view only page 2 counts.
    expect(ids(resolveLineRef(doc, { speaker: 'Leo' }, { pageId: 'pg_2' }))).toEqual(['l_p2leo']);
  });

  it('2–5 matches ask "Which line?" with quoted candidates and a balloon picture each', () => {
    const r = resolveLineRef(doc, { speaker: 'Mira' }, { pageId: 'pg_1' });
    expect(r.status).toBe('which');
    expect(ids(r)).toEqual(['l_mira1', 'l_mira2', 'l_mira3']);
    const choices = whichLineChoices(doc, r.status === 'which' ? r.candidates : []);
    expect(choices.map((c) => c.label)).toEqual([
      'P1 · panel 2 · MIRA PATEL: “We have to go”',
      'P1 · panel 2 · MIRA PATEL: “Quietly now”',
      'P1 · panel 3 · MIRA PATEL: “Bolt, quiet!”'
    ]);
    expect(choices[0].visual).toEqual({ kind: 'balloon', pageId: 'pg_1', lineId: 'l_mira1' });
    expect(choices[0].reply).toBe('The one on page 1, panel 2: “We have to go”');
    const ask = askForResolution(doc, r)!;
    expect(ask.question).toBe('Which line?');
    expect(ask.options).toHaveLength(3);
    // A caption is named by its kind, not a speaker.
    expect(lineChipLabel(doc, lineHits(doc)[0])).toBe('P1 · panel 1 · CAPTION: “The lab, midnight.”');
  });

  it('more than 5 matches ask to tap the balloon, with an Open page chip', () => {
    const crowded = dialogueDoc((d) => {
      d.pages[1].panels.push(panel('pn_6', 3, ['c_leo'], Array.from({ length: 6 }, (_, i): Line => line(`l_x${i}`, 'speech', `Line ${i}`, 'c_leo'))));
    });
    const r = resolveLineRef(crowded, { speaker: 'Leo' }, { pageId: 'pg_2' });
    expect(r).toEqual({ status: 'tap', count: 7, pageId: 'pg_2' });
    const ask = askForResolution(crowded, r)!;
    expect(ask.question).toMatch(/Tap the balloon on the page, then say it again/);
    expect(ask.followUps).toEqual([{ label: 'Open page 2', client: { type: 'open_page', pageId: 'pg_2' } }]);
  });

  it('plural words apply to every match across the comic; above 20 lines or 3 pages they confirm first', () => {
    expect(resolveLineRef(doc, { kind: 'speech', all: true } as PluralLineRef, { pageId: 'pg_1', panelN: 2 })).toMatchObject({ status: 'lines' });
    expect(ids(resolveLineRef(doc, { kind: 'speech', all: true } as PluralLineRef, { pageId: 'pg_1', panelN: 2 }))).toEqual(['l_mira1', 'l_leo1', 'l_bolt1', 'l_mira3', 'l_p2mira']);
    const big = dialogueDoc((d) => {
      d.pages[1].panels.push(panel('pn_6', 3, ['c_leo'], Array.from({ length: 8 }, (_, i): Line => line(`l_x${i}`, 'speech', `Line ${i}`, 'c_leo'))));
      d.pages[1].panels.push(panel('pn_7', 4, ['c_leo'], Array.from({ length: 8 }, (_, i): Line => line(`l_y${i}`, 'speech', `More ${i}`, 'c_leo'))));
    });
    const r = resolveLineRef(big, { kind: 'speech', all: true } as PluralLineRef);
    expect(r.status).toBe('confirm');
    expect(r.status === 'confirm' && [r.lines.length, r.pages]).toEqual([21, 2]);
    expect(askForResolution(big, r)!.question).toBe("That changes 21 lines on 2 pages. Go ahead? It's free and undoable.");
    // A bare plural ("these", "all of them") without a selection never reaches the whole comic.
    expect(ids(resolveLineRef(doc, { all: true } as PluralLineRef, { pageId: 'pg_2', panelN: 2 }))).toEqual(['l_p2leo']);
    expect(resolveLineRef(doc, { all: true } as PluralLineRef).status).toBe('none');
  });

  it('quoted words, ordinals and "which" narrow', () => {
    expect(ids(resolveLineRef(doc, { textContains: 'wait' }))).toEqual(['l_leo1']);
    expect(ids(resolveLineRef(doc, { textContains: '“Bolt, quiet”' }))).toEqual(['l_mira3']);
    // "her second line", "the last one"
    expect(ids(resolveLineRef(doc, { speaker: 'Mira', nth: 2 }, { pageId: 'pg_1' }))).toEqual(['l_mira2']);
    expect(ids(resolveLineRef(doc, { speaker: 'Mira', nth: 'last' }, { pageId: 'pg_1' }))).toEqual(['l_mira3']);
    // Her second line in panel 3 does not exist there, so the page answers.
    expect(ids(resolveLineRef(doc, { speaker: 'Mira', nth: 2 }, { pageId: 'pg_1', panelN: 3 }))).toEqual(['l_mira2']);
    // The top speech balloon of panel 2 is Mira's (y 0.53, pinned) — Leo's sits lower.
    expect(ids(resolveLineRef(doc, { kind: 'speech', panel: 2, which: 'top' }, { pageId: 'pg_1' }))).toEqual(['l_mira1']);
    expect(ids(resolveLineRef(doc, { panel: 'last' }, { pageId: 'pg_2', panelN: 1 }))).toEqual(['l_p2leo']);
    // "her": the selected line's speaker.
    expect(ids(resolveLineRef(doc, { speaker: 'her', kind: 'whisper' }, { lineIds: ['l_mira3'], pageId: 'pg_1' }))).toEqual(['l_mira2']);
  });

  it('nothing matched: an honest inventory of what exists', () => {
    const r = resolveLineRef(doc, { kind: 'shout' }, { pageId: 'pg_1' });
    expect(r).toEqual({ status: 'none', note: 'No shouts matched — nothing was changed. Page 1 has caption ×1, speech ×4, whisper ×1, sound effect ×1.' });
    const nobody = resolveLineRef(doc, { speaker: 'Zelda' });
    expect(nobody.status === 'none' && nobody.note).toBe("There's no character called “Zelda”. The cast is Mira Patel, Leo, Bolt and Asha Patel. Nothing was changed.");
    const silent = resolveLineRef(doc, { speaker: 'Asha' });
    expect(silent.status === 'none' && silent.note).toMatch(/Asha Patel has no lines yet\.$/);
    const page = resolveLineRef(doc, { page: 7 });
    expect(page.status === 'none' && page.note).toBe("There's no page 7: the comic has 2 pages. Nothing was changed.");
  });

  it('explicit line ids are exact and every one applies', () => {
    expect(ids(resolveLineRef(doc, { lineIds: ['l_sfx', 'l_cap', 'gone'] }))).toEqual(['l_cap', 'l_sfx']);
    expect(resolveLineRef(doc, { lineIds: ['gone'] }).status).toBe('none');
  });
});
