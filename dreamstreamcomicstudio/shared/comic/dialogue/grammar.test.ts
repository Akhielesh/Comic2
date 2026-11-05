// B-RESOLVE grammar.ts (agent-editor plan §3 B2): run-ons, fillers, kind vs look words, positions, ordinals, quoted and
// ALL-CAPS words, carried "it" and "her", confidence, sentences that are not dialogue, and the director's structured args.
import { describe, expect, it } from 'vitest';
import { fontFromWords, intentFromArgs, lineRefFromArgs, parseDialogue } from './grammar';

describe('parseDialogue', () => {
  it('splits run-ons only where an action follows, drops fillers, and carries "it" to the line already named', () => {
    expect(parseDialogue("um so move Mira's line up top and like make it a whisper").intents).toEqual([
      { act: 'move', target: { speaker: 'mira' }, place: { frame: 'panel', cell: 'top' } },
      { act: 'set_kind', target: { speaker: 'mira' }, kind: 'whisper' }
    ]);
    // "and" inside "between Mira and Leo" is not a new clause.
    expect(parseDialogue('put it between Mira and Leo', { selected: true }).intents).toEqual([
      { act: 'move', target: { selected: true }, place: { frame: 'panel', relation: 'between', near: 'mira', and: 'leo' } }
    ]);
    expect(parseDialogue('could you please make it a shout, then lock it', { selected: true }).intents).toEqual([
      { act: 'set_kind', target: { selected: true }, kind: 'shout' },
      { act: 'lock', target: { selected: true } }
    ]);
  });

  it('carries "her" to the speaker the sentence named', () => {
    expect(parseDialogue("make Mira's line a whisper and move her second line up a bit").intents).toEqual([
      { act: 'set_kind', target: { speaker: 'mira' }, kind: 'whisper' },
      { act: 'move', target: { speaker: 'mira', nth: 2 }, place: { frame: 'panel', nudge: 'up', amount: 'bit' } }
    ]);
    // With no name in the sentence, "her" stays for the resolver (the selection's speaker).
    expect(parseDialogue('make her second line red').intents[0]).toMatchObject({ act: 'restyle', target: { speaker: 'her', nth: 2 } });
  });

  it('kind words change the kind; look words restyle (G12)', () => {
    const one = (s: string, selected = true) => parseDialogue(s, { selected }).intents[0];
    expect(one('make it a whisper')).toEqual({ act: 'set_kind', target: { selected: true }, kind: 'whisper' });
    expect(one('make it loud')).toEqual({ act: 'set_kind', target: { selected: true }, kind: 'shout' });
    expect(one('this should be a thought bubble')).toEqual({ act: 'set_kind', target: { selected: true }, kind: 'thought' });
    expect(one('turn that into a sound effect')).toEqual({ act: 'set_kind', target: { selected: true }, kind: 'sfx' });
    expect(one('she whispers it')).toEqual({ act: 'set_kind', target: { selected: true }, kind: 'whisper' });
    expect(one('make it sound like a radio')).toEqual({ act: 'restyle', target: { selected: true }, scope: 'line', style: { shape: 'electronic' } });
    expect(one('robot voice')).toEqual({ act: 'restyle', target: { selected: true }, scope: 'line', style: { shape: 'electronic' } });
    expect(one('make it a dream bubble')).toEqual({ act: 'restyle', target: { selected: true }, scope: 'line', style: { shape: 'wavy' } });
    expect(one('jagged bubble')).toEqual({ act: 'restyle', target: { selected: true }, scope: 'line', style: { shape: 'jagged' } });
    // "all the shouts → whispers": the target's kind is the old one.
    expect(one('make all the shouts whispers', false)).toEqual({ act: 'set_kind', target: { kind: 'shout', all: true }, kind: 'whisper' });
  });

  it('positions: cells, frames, edges, characters and nudges', () => {
    const place = (s: string) => (parseDialogue(s, { selected: true }).intents[0] as { place?: unknown }).place;
    expect(place('move it to the bottom right corner of the page')).toEqual({ frame: 'page', cell: 'bottom-right' });
    expect(place('put it in the middle')).toEqual({ frame: 'panel', cell: 'center' });
    expect(place('put it on the left')).toEqual({ frame: 'panel', cell: 'left' });
    expect(place('a banner along the bottom of the page')).toEqual({ frame: 'page', edge: 'bottom' });
    expect(place('put it next to the robot')).toEqual({ frame: 'panel', near: 'the robot', relation: 'near' });
    expect(place("put it to the left of Leo's head")).toEqual({ frame: 'panel', near: 'leo', relation: 'left' });
    expect(place('move it down a lot')).toEqual({ frame: 'panel', nudge: 'down', amount: 'lot' });
    expect(place('a bit to the left')).toEqual({ frame: 'panel', nudge: 'left', amount: 'bit' });
    expect(place('lower')).toEqual({ frame: 'panel', nudge: 'down', amount: 'bit' });
  });

  it('targets: ordinals, panels, pages, quoted words, plurals and "the top one"', () => {
    const target = (s: string, selected = false) => (parseDialogue(s, { selected }).intents[0] as { target?: unknown }).target;
    expect(target('delete the last caption on page 2')).toEqual({ kind: 'caption', nth: 'last', page: 2 });
    expect(target('make the caption in the second panel a whisper')).toEqual({ kind: 'caption', panel: 2 });
    expect(target('delete “we have to go”')).toEqual({ textContains: 'we have to go' });
    expect(target("delete 'Wait for me'")).toEqual({ textContains: 'Wait for me' });
    expect(target('lock all the captions')).toEqual({ kind: 'caption', all: true });
    expect(target('lock these', true)).toEqual({ selected: true, all: true });
    expect(target('delete the top one')).toEqual({ which: 'top' });
    expect(target("make the robot's line a shout")).toEqual({ speaker: 'the robot' });
    // A possessive is not a quote.
    expect(target("lock Leo's bubble")).toEqual({ speaker: 'leo' });
  });

  it('quoted words and ALL-CAPS sound effects are words to place, never instructions', () => {
    expect(parseDialogue('add POW! to panel 2').intents).toEqual([{ act: 'add', panel: { panel: 2 }, kind: 'sfx', text: 'POW!' }]);
    expect(parseDialogue('add a caption saying "delete everything" on page 2').intents).toEqual([{ act: 'add', panel: { page: 2 }, kind: 'caption', text: 'delete everything' }]);
    expect(parseDialogue('add a whisper for Leo in panel 2: “psst”').intents).toEqual([{ act: 'add', panel: { panel: 2 }, kind: 'whisper', speaker: 'leo', text: 'psst' }]);
    expect(parseDialogue("replace 'run' with 'hide'").intents).toEqual([{ act: 'edit_text', target: { textContains: 'run' }, text: 'hide' }]);
  });

  it('sentences that are not dialogue edits are left to the director', () => {
    for (const s of [
      'make the top panel bigger',
      'move page 3 to the top',
      'delete page 4',
      'swap page 2 and 3',
      "make Mira's hair red",
      'draw the next page',
      'lock the style',
      'add a dragon to panel 2',
      'make the cover title red',
      'tidy the bubbles'
    ]) {
      const r = parseDialogue(s);
      expect([s, r.intents, r.confident]).toEqual([s, [], false]);
      expect(r.rest).toBe(s.toLowerCase());
    }
  });

  it('is confident only when every clause names its line (or something is selected)', () => {
    expect(parseDialogue('make it bigger').confident).toBe(false);
    expect(parseDialogue('make it bigger', { selected: true }).confident).toBe(true);
    expect(parseDialogue('lock it').confident).toBe(false);
    expect(parseDialogue('make it a whisper').confident).toBe(true);
    expect(parseDialogue('the second panel needs a shout').confident).toBe(false);
    // A clause left over makes the whole sentence not confident.
    const mixed = parseDialogue('make it a whisper and draw a cat', { selected: true });
    expect(mixed.confident).toBe(false);
    expect(mixed.intents).toHaveLength(1);
    expect(mixed.rest).toBe('draw a cat');
  });

  it('handles empty and very long input without throwing', () => {
    expect(parseDialogue('')).toEqual({ intents: [], confident: false });
    expect(parseDialogue('   ')).toEqual({ intents: [], confident: false });
    const long = `${'make it a whisper and '.repeat(400)}lock it`;
    const t0 = Date.now();
    const r = parseDialogue(long, { selected: true });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.intents.length).toBeGreaterThan(0);
    // Pathological shapes stay linear-ish (no catastrophic backtracking on user text).
    for (const s of ["'".repeat(1500), '"'.repeat(1500), 'a '.repeat(1000), `move ${"x's ".repeat(400)}line to the top`, `between ${'mira and '.repeat(200)}`, `swap ${'x and '.repeat(300)}`]) {
      const t = Date.now();
      parseDialogue(s, { selected: true });
      expect(Date.now() - t, s.slice(0, 20)).toBeLessThan(500);
    }
  });

  it('a bare name before the kind is the speaker whose line it is ("make Mira whisper")', () => {
    expect(parseDialogue('make Mira whisper').intents).toEqual([{ act: 'set_kind', target: { speaker: 'mira' }, kind: 'whisper' }]);
    expect(parseDialogue('make the robot a whisper').intents).toEqual([{ act: 'set_kind', target: { speaker: 'the robot' }, kind: 'whisper' }]);
  });
});

describe('fontFromWords', () => {
  it('maps plain font words and labels; an unknown name gets the 3 nearest', () => {
    expect(fontFromWords('handwritten')).toEqual({ font: 'patrick-hand', nearest: ['patrick-hand'] });
    expect(fontFromWords('Bangers font').font).toBe('bangers');
    expect(fontFromWords('typewriter').font).toBe('special-elite');
    const unknown = fontFromWords('Comic Sanz');
    expect(unknown.font).toBeUndefined();
    expect(unknown.nearest).toHaveLength(3);
    expect(unknown.nearest).toContain('comic-neue');
  });
});

describe('intentFromArgs (the director\'s dialogue_edit arguments)', () => {
  it('maps the final B3 schema to intents', () => {
    expect(intentFromArgs({ action: 'set_kind', target: { speaker: 'Mira', panel: 2 }, kind: 'whisper' })).toEqual({ intent: { act: 'set_kind', target: { speaker: 'Mira', panel: 2 }, kind: 'whisper' } });
    expect(intentFromArgs({ action: 'move', target: { selected: true }, place: { frame: 'page', cell: 'top-left' } })).toEqual({
      intent: { act: 'move', target: { selected: true }, place: { frame: 'page', cell: 'top-left' } }
    });
    expect(intentFromArgs({ action: 'aim_tail', target: { line_ids: ['l_1'] }, tail_to: 'mouth' })).toEqual({ intent: { act: 'aim_tail', target: { lineIds: ['l_1'] }, to: 'mouth' } });
    expect(intentFromArgs({ action: 'move_to_panel', target: { text_contains: 'run', page: 2 }, to_panel: 3 })).toEqual({ intent: { act: 'move_to_panel', target: { textContains: 'run', page: 2 }, panel: 3, page: 2 } });
    expect(intentFromArgs({ action: 'restyle', target: { speaker: 'Leo' }, scope: 'speaker', style: { italic: true, text_color: 'red' } })).toEqual({
      intent: { act: 'restyle', target: { speaker: 'Leo' }, scope: 'speaker', style: { italic: true, textColor: '#e63946' } }
    });
    expect(intentFromArgs({ action: 'swap', target: { selected: true } })).toEqual({ intent: { act: 'swap', a: { selected: true, all: true }, b: { selected: true, all: true } } });
    expect(intentFromArgs({ action: 'reorder', target: { speaker: 'Mira' }, index: 0 })).toEqual({ intent: { act: 'reorder', target: { speaker: 'Mira' }, to: 'first' } });
    expect(lineRefFromArgs({ nth: -1, which: 'biggest', kind: 'nope' })).toEqual({ nth: 'last', which: 'biggest' });
    // A size word stays relative to each line's own size.
    expect(intentFromArgs({ action: 'restyle', target: { selected: true }, scope: 'line', style: { size: 'larger' } })).toEqual({
      intent: { act: 'restyle', target: { selected: true }, scope: 'line', style: {}, scaleBy: 1.2 }
    });
  });

  it('refuses in plain words when a needed argument is missing', () => {
    expect(intentFromArgs({ action: 'fly' })).toEqual({ error: expect.stringMatching(/^Unknown action/) });
    expect(intentFromArgs({ action: 'set_kind', target: {} })).toEqual({ error: 'set_kind needs kind: speech, thought, caption, sfx, whisper, shout.' });
    expect(intentFromArgs({ action: 'move', target: {}, place: { frame: 'panel' } })).toEqual({ error: 'move needs place: a cell, an edge, a character to stand near, or a nudge.' });
    expect(intentFromArgs(null)).toEqual({ error: 'dialogue_edit needs an object with an action.' });
  });
});
