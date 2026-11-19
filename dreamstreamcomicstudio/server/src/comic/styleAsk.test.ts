// @vitest-environment node
// styleLooksAsk (stylepick SC-0): an ask to SEE drawn looks of this comic (a look noun plus a count or a see/draw
// verb, typos included) versus a WHICH-look question, an ask to browse the free presets, words about looks already
// there, a lettering style, or words about other things.
import { describe, expect, it } from 'vitest';
import { styleLooksAsk } from './styleAsk.js';

describe('styleLooksAsk', () => {
  it.each([
    ['generate 3 of the best style options for this', 3, false],
    ['egernate 3 styles of the ebst styling iptiosn u think', 3, false],
    ['show me some looks', 3, false],
    ['draw 6 different art styles', 6, false],
    ['can you make a couple of style options', 2, false],
    ['10 looks please', 6, true],
    ['try a few looks for this comic', 3, false],
    ['Generate three looks.', 3, false],
    ['show me looks', 3, false],
    ['genrate 4 stlyes', 4, false],
    ['draw 1 look', 2, true],
    ['which 2 styles would suit it best? draw them', 2, false],
    ['explore several looks', 3, false],
    // A negation counts only right before the verb or the noun, in the same comma-separated part.
    ['generate 3 looks without text', 3, false],
    ['3 looks with no speech bubbles', 3, false],
    ['draw 4 styles, no need to be fancy', 4, false],
    ["I don't like these, show me 3 new looks", 3, false],
    // A drawing verb makes looks named with "the" an ask, and keeps the count.
    ['generate the 5 best styles for this', 5, false],
    ['draw a set of 5 looks', 5, false]
  ])('%s → %i looks', (text, count, clamped) => {
    expect(styleLooksAsk(text)).toEqual({ count, clamped });
  });

  it.each([
    'what style is this',
    'which style suits this story?',
    'make the text bigger',
    'give me 3 options for the ending',
    '3 variations of the cover',
    '2 versions of page 2',
    'change the lettering style',
    '3 balloon styles',
    'use the noir look',
    'I like this look',
    'make her look older',
    'it looks great, draw page 2',
    'make the style darker',
    'what styles can you show me?',
    'draw page 2 in a different style',
    'style it like a noir film',
    "don't draw any new styles yet",
    // Browsing the free presets is not an ask to draw.
    'show me the free styles',
    'show me the preset styles',
    'can I see the styles in the library',
    'show me your looks',
    'let me see the available styles',
    'show me the looks you have',
    // Words about looks already there.
    'none of the 3 looks work',
    'which of the 3 styles is best?',
    'the 2 styles you drew are too dark',
    'mix the 2 styles',
    'combine those two looks',
    'I picked 2 styles already, lock the first',
    // A verb in a negated part never makes a later which-question an ask.
    "don't draw yet. which styles fit?",
    '',
    '   '
  ])('%s → no', (text) => {
    expect(styleLooksAsk(text)).toBeNull();
  });

  it('is total on odd input', () => {
    expect(styleLooksAsk(undefined as unknown as string)).toBeNull();
    expect(styleLooksAsk('looks '.repeat(5000))).toBeNull();
  });
});
