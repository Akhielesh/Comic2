// Cover intro title reveal (reader.md §6.1): Latin titles reveal letter by letter inside whole words;
// complex scripts (Telugu, Hindi, …) reveal word by word so their shaping never breaks; screen readers
// get the title once, as text.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { CoverIntro, titleUnits } from './CoverIntro';

describe('titleUnits', () => {
  it('Latin: words of letters (spaces collapse, no empty words)', () => {
    expect(titleUnits('  The   Saffron Thief ')).toEqual([
      { word: 'The', letters: ['T', 'h', 'e'] },
      { word: 'Saffron', letters: ['S', 'a', 'f', 'f', 'r', 'o', 'n'] },
      { word: 'Thief', letters: ['T', 'h', 'i', 'e', 'f'] }
    ]);
  });

  it('Telugu / Hindi / decomposed accents: whole words, never split into code points', () => {
    expect(titleUnits('చిన్న దొంగ')).toEqual([
      { word: 'చిన్న', letters: null },
      { word: 'దొంగ', letters: null }
    ]);
    expect(titleUnits('छोटा चोर').every((u) => u.letters === null)).toBe(true);
    // "é" typed as e + combining acute is normalized to one letter.
    expect(titleUnits('Café')).toEqual([{ word: 'Café', letters: ['C', 'a', 'f', 'é'] }]);
  });
});

describe('CoverIntro', () => {
  it('the heading reads the title once for screen readers (letters are decorative)', () => {
    render(<CoverIntro title="The Saffron Thief" reduced={false} rtl={false} bookEl={null} onOpen={() => undefined} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('The Saffron Thief');
  });

  it('a Telugu title renders whole words (no lone vowel signs)', () => {
    render(<CoverIntro title="చిన్న దొంగ" reduced={false} rtl={false} bookEl={null} onOpen={() => undefined} />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveAccessibleName('చిన్న దొంగ');
    expect(h1.textContent).toContain('చిన్న');
  });
});
