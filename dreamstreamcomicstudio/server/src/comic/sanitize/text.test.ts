// @vitest-environment node
// P2-GATE L5: text is cleaned where it ENTERS the doc, so the live doc never holds what jsonb rejects.
import { describe, expect, it } from 'vitest';
import { clipText, enteredText, storableText } from './text.js';

describe('storableText', () => {
  it('removes NULs and lone surrogates, keeps whole pairs and every other character', () => {
    expect(storableText('Spice\u0000 Run')).toBe('Spice Run');
    expect(storableText('half \uD83C emoji')).toBe('half  emoji');
    expect(storableText('\uDC00tail')).toBe('tail');
    expect(storableText('A fox 🦊 races 🏁')).toBe('A fox 🦊 races 🏁');
    // H-H-L: only the unpaired high surrogate goes; the pair after it stays.
    expect(storableText('\uD83C🦊')).toBe('🦊');
    // Reversed pair (L then H): both are lone.
    expect(storableText('a\uDD8A\uD83Eb')).toBe('ab');
    // Tabs, line breaks, combining marks and ZWJ are not its business.
    expect(storableText('line1\n\tline2 ‍ గ్')).toBe('line1\n\tline2 ‍ గ్');
  });

  it('returns the same reference when there is nothing to fix (the common save pays one regex test)', () => {
    const clean = 'Nothing to see here 🙂';
    expect(storableText(clean)).toBe(clean);
  });
});

describe('clipText / enteredText', () => {
  it('never leaves half a pair at the cut', () => {
    expect(clipText('ab🦊', 3)).toBe('ab');
    expect(clipText('ab🦊', 4)).toBe('ab🦊');
    expect(clipText('abc', 2)).toBe('ab');
    expect(clipText('abc', 3)).toBe('abc');
  });

  it('enteredText = storable + trimmed + clipped, in that order', () => {
    expect(enteredText('  \u0000Hi there \uD800 ', 100)).toBe('Hi there');
    expect(enteredText(' x🦊', 2)).toBe('x');
    // A string whose NUL hid an overlong value is clipped after the clean, never before.
    expect(enteredText(`${'\u0000'.repeat(5)}abcdef`, 3)).toBe('abc');
  });
});
