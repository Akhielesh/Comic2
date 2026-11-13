// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Character } from '../doc.js';
import { lintLook, moodWordsIn, withoutMood } from './lookLint.js';

const here = dirname(fileURLToPath(import.meta.url));
/** The Ramayana golden case's cast cards (text only; the fixture P5-GOLD stores for the server tests). */
const caseCast = (): Character[] =>
  JSON.parse(readFileSync(join(here, '..', '..', '..', 'server', 'src', 'comic', '__fixtures__', 'ramayana-setu.doc.json'), 'utf8')).cast;
const card = (name: string) => caseCast().find((c) => c.name === name)!;

describe('withoutMood (the compile-time face, eyes and summary)', () => {
  it.each([
    ['serene calm smile', ''],
    ['monkey face with a wide, friendly grin', 'monkey face'],
    ['determined printed face with firm brows', 'printed face with firm brows'],
    ['focused architect expression', ''],
    ['calm and majestic with a white beard piece', 'majestic with a white beard piece'],
    ['kind eyes, warm smile', 'kind eyes'],
    ['round face with freckles and a warm smile', 'round face with freckles'],
    ['determined painted eyes', 'painted eyes']
  ])('%j → %j', (input, output) => {
    expect(withoutMood(input)).toBe(output);
  });

  it('leaves a text without mood words byte for byte (no tidying of what it does not change)', () => {
    for (const text of ['warm monkey-warrior face with sculpted jaw', '  sharp jaw,freckles ', 'noble painted eyes', '', 'black topknot hairpiece'])
      expect(withoutMood(text)).toBe(text);
    expect(withoutMood(undefined)).toBe('');
  });

  it('finds every mood word once, in order', () => {
    expect(moodWordsIn('serene calm smile, a calm look')).toEqual(['serene', 'calm', 'smile']);
    expect(moodWordsIn('sky-blue toy plastic')).toEqual([]);
  });
});

describe('lintLook (the free cast-card check)', () => {
  it("flags Lakshmana: the summary says green skin, the Skin field says warm tan", () => {
    const findings = lintLook(card('Lakshmana'));
    const contradiction = findings.filter((f) => f.rule === 'contradiction');
    expect(contradiction).toHaveLength(1);
    expect(contradiction[0]).toMatchObject({ field: 'skin', words: ['green', 'tan'] });
    expect(contradiction[0].text).toBe('Summary says green, skin says warm tan plastic: pick one, so every page draws the same Lakshmana.');
  });

  it("flags the Squirrel's stripes: a fixed field that says when it changes", () => {
    const findings = lintLook(card('Squirrel'));
    expect(findings).toEqual([
      expect.objectContaining({ rule: 'time', field: 'markings', words: ['after'] })
    ]);
    expect(findings[0].text).toMatch(/^Markings says "after": this sounds like a change over time\./);
  });

  it("flags a mood held in the face: Rama's serene calm smile and Sugriva's grin", () => {
    expect(lintLook(card('Rama'))).toEqual([expect.objectContaining({ rule: 'mood', field: 'face', words: ['serene', 'calm', 'smile'] })]);
    expect(lintLook(card('Sugriva')).map((f) => [f.rule, f.field, f.words])).toEqual([['mood', 'face', ['grin']]]);
  });

  it('says nothing about a clean card, a matching summary or a summary with no skin colour', () => {
    expect(lintLook(card('Hanuman'))).toEqual([]);
    const tan: Character = { ...card('Lakshmana'), look: { ...card('Lakshmana').look, summary: 'Tan-skinned plastic minifigure prince.', face: 'printed face' } };
    expect(lintLook(tan)).toEqual([]);
    expect(lintLook({ name: 'Nobody', look: { summary: '' } })).toEqual([]);
    // A partial or odd look never throws.
    expect(lintLook({ name: 'X', look: {} as Character['look'] })).toEqual([]);
  });

  it('reads hair and eyes the same way ("red-haired" against Hair "black")', () => {
    const c = { name: 'Mira', look: { summary: 'A red-haired girl with blue eyes.', hair: 'long black braid', eyes: 'blue' } };
    expect(lintLook(c).map((f) => [f.rule, f.field, f.words])).toEqual([['contradiction', 'hair', ['red', 'black']]]);
  });
});

describe('review follow-ups: lasting traits stay, colour families agree, ordinary words are not time words', () => {
  it.each([
    ['kind eyes that never smile', 'kind eyes'],
    ['permanent scowl and scarred brow', 'permanent scowl and scarred brow'],
    ['weathered face with deep laugh lines', 'weathered face with deep laugh lines'],
    ['smile lines around the eyes', 'smile lines around the eyes'],
    ['an always-frowning brow', 'an always-frowning brow']
  ])('withoutMood keeps a lasting trait: %j → %j', (input, output) => {
    expect(withoutMood(input)).toBe(output);
  });

  it('never empties a field that held more than its mood: the mood word alone goes', () => {
    for (const text of ['kind eyes that never smile', 'weathered face with deep laugh lines', 'gentle eyes'])
      expect(withoutMood(text).length, text).toBeGreaterThan(0);
    // A field that is only a mood still comes out empty (the panel gives the feeling).
    expect(withoutMood('serene calm smile')).toBe('');
  });

  it('laugh lines and a permanent scowl are not moods on the card', () => {
    expect(lintLook({ name: 'Old Sage', look: { summary: 'An old sage.', face: 'weathered face with deep laugh lines' } })).toEqual([]);
    expect(lintLook({ name: 'Guard', look: { summary: 'A guard.', face: 'permanent scowl and scarred brow' } })).toEqual([]);
  });

  it('one colour family is one colour (gold and golden, blond and blonde, blue and navy)', () => {
    expect(lintLook({ name: 'Hanuman', look: { summary: 'Golden-furred monkey with golden fur', hair: 'gold fur' } })).toEqual([]);
    expect(lintLook({ name: 'Girl', look: { summary: 'Blonde-haired girl', hair: 'blond ponytail' } })).toEqual([]);
    expect(lintLook({ name: 'Prince', look: { summary: 'Prince with dark blue skin', skin: 'navy' } })).toEqual([]);
    // A real contradiction still shows: Lakshmana's green against tan.
    expect(lintLook(card('Lakshmana')).some((f) => f.rule === 'contradiction')).toBe(true);
  });

  it('when, once and before are ordinary words in a fixed field, not a change over time', () => {
    expect(lintLook({ name: 'Sita', look: { summary: 'A princess.', outfit: 'a sari that flutters when she runs' } })).toEqual([]);
    expect(lintLook({ name: 'Rama', look: { summary: 'A prince.', props: 'a sword he draws once he is angry' } })).toEqual([]);
    // The Squirrel's stripes after the blessing still read as a change.
    expect(lintLook(card('Squirrel')).some((f) => f.rule === 'time')).toBe(true);
  });
});
