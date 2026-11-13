// The font picker's open list (PE-FONTS wave note 6, applied at the S2b integration): every row's name is drawn from the
// specimen sprite (a CSS mask, one image), so opening the list — with the Pro faces listed — constructs no FontFace and
// fetches no face. The Easy chips are live text in their own faces, so they still load (the control below proves the
// FontFace stub sees loads, so the zero above is not vacuous).

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PRO_FONT_IDS } from '../../../shared/comic/lettering/proFonts';
import { FONT_SPECIMENS } from './fontSpecimens';
import { FontPicker, LATIN_FONTS } from './FontPicker';
import { DENSITY } from '../../chat/studioDesign';

vi.mock('../../../shared/comic/ops', async (orig) => ({ ...(await orig<Record<string, unknown>>()), PRO_EDIT_OPS_PATCHABLE: true }));

let constructed: string[] = [];
const realFontFace = (globalThis as { FontFace?: unknown }).FontFace;
const realFonts = Object.getOwnPropertyDescriptor(document, 'fonts');

beforeEach(() => {
  constructed = [];
  class StubFontFace {
    family: string;
    constructor(family: string) {
      this.family = family;
      constructed.push(family);
    }
    load() {
      return Promise.resolve(this);
    }
  }
  (globalThis as { FontFace?: unknown }).FontFace = StubFontFace;
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: () => undefined, load: () => Promise.resolve([]), check: () => false, forEach: () => undefined, addEventListener: () => undefined }
  });
});

afterEach(() => {
  cleanup();
  (globalThis as { FontFace?: unknown }).FontFace = realFontFace;
  if (realFonts) Object.defineProperty(document, 'fonts', realFonts);
  else delete (document as { fonts?: unknown }).fonts;
});

/** Let the loader's lazy face tables and file loads settle. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => new Promise((r) => setTimeout(r, 20)));
};

describe('FontPicker open list: specimens, not faces', () => {
  // First: the loader caches faces per module, so the control must run before anything else could have loaded them.
  it('control: the Easy chips are live text in their faces, so they do load (the stub sees FontFace loads)', async () => {
    render(<FontPicker simple value="comic-neue" lang="en" onChange={() => undefined} />);
    await settle();
    expect(constructed.length).toBeGreaterThan(0);
  });

  it('opening the list (Pro faces included) constructs 0 FontFace objects and draws one specimen mask per option', async () => {
    render(<FontPicker value="comic-neue" lang="en" pro onChange={() => undefined} />);
    await settle();
    expect(constructed).toEqual([]);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await settle();
    const list = screen.getByRole('listbox');
    const options = within(list).getAllByRole('option');
    // The Pro switch is mocked on, so the Pro faces are listed after the base ones.
    expect(options).toHaveLength(LATIN_FONTS.length + PRO_FONT_IDS.length);
    for (const o of options) {
      const masks = o.querySelectorAll('[data-font-specimen]');
      expect(masks, o.textContent ?? '').toHaveLength(1);
      const id = masks[0].getAttribute('data-font-specimen')!;
      expect(Object.prototype.hasOwnProperty.call(FONT_SPECIMENS, id)).toBe(true);
      expect(masks[0].getAttribute('aria-hidden')).toBe('true');
      // The name is still there for assistive tech.
      expect(o.querySelector('.sr-only')?.textContent).toBeTruthy();
    }
    expect(options.length).toBe(list.querySelectorAll('[data-font-specimen]').length);
    expect(PRO_FONT_IDS.every((f) => list.querySelector(`[data-font-specimen="${f}"]`))).toBe(true);
    expect(constructed).toEqual([]);
  });
});

// Last: the loader caches faces per module (see the control above).
describe('FontPicker trigger: a touch target', () => {
  it('is at least 36 px with a fine pointer and the 44 px touch size under a coarse one (it was a fixed h-9 on phones)', () => {
    render(<FontPicker value="comic-neue" lang="en" onChange={() => undefined} />);
    const trigger = document.querySelector<HTMLElement>('[data-slot="font-picker-trigger"]')!;
    expect(trigger.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-h-9', ...DENSITY.coarse.split(' ')]));
    expect(trigger.className.split(/\s+/)).not.toContain('h-9');
  });
});
