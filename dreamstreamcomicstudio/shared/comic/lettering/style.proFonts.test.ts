// Collisions B-2: DRAWN_FONTS = FONT_IDS ∪ PRO_FONT_IDS, imported from proFonts.ts (PE-FONTS fills it in parallel). This
// file runs style.ts against a FULL Pro font list (mocked); style.pro.test.ts runs it against today's empty one. Before
// PE-LETTER a Pro face was never drawable and never accepted, whatever proFonts.ts held.

import { describe, expect, it, vi } from 'vitest';

vi.mock('./proFonts', () => ({
  PRO_FONT_IDS: ['bungee', 'creepster'],
  isProFontId: (v: unknown) => v === 'bungee' || v === 'creepster'
}));

const { resolveLetterStyle, sanitizeLetterStylePatch } = await import('./style');
const { createEmptyDoc } = await import('../doc');

describe('Pro fonts from proFonts.ts draw and are accepted with the opt-in', () => {
  it('a shipped Pro face is a client write only with {allowPro: true}', () => {
    expect(sanitizeLetterStylePatch({ font: 'bungee' })).toBeUndefined();
    expect(sanitizeLetterStylePatch({ font: 'bungee' }, { allowPro: true })).toEqual({ font: 'bungee' });
    expect(sanitizeLetterStylePatch({ font: 'papyrus' }, { allowPro: true })).toBeUndefined();
  });

  it('the cascade draws a shipped Pro face and still skips one that is not shipped', () => {
    const doc = createEmptyDoc('d', 'D', 1);
    const l = { id: 'l', kind: 'speech' as const, text: 'Hi' };
    expect(resolveLetterStyle(doc, { ...l, style: { font: 'creepster' as never } }).font).toBe('creepster');
    expect(resolveLetterStyle(doc, { ...l, style: { font: 'not-shipped' as never } }).font).toBe('comic-neue');
  });
});
