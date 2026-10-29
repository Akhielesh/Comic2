// Device-matrix follow-ups (ui-findings 2026-10-29, P2-BOARD): hover-only and sub-44 px controls on the
// Style and Cast tabs. Touch (pointer: coarse) gets visible 44 px controls; fine pointers keep the
// compact hover-revealed look (the desktop look is unchanged).

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import { CastTab } from './CastTab';
import { StyleTab } from './StyleTab';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
  // The platform library is unavailable in tests: every surface falls back to procedural art.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('offline');
    })
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const touch = formFactorFor({ w: 882, h: 1104, coarse: true });
const mouse = formFactorFor({ w: 1440, h: 900, coarse: false });

const renderStyle = (ff: typeof touch) => {
  const doc = makeSampleDoc();
  render(
    <FormFactorProvider value={ff}>
      <StyleTab studio={makeStudio(doc)} doc={doc} />
    </FormFactorProvider>
  );
  return doc;
};

describe('StyleTab palette and "Never" chips', () => {
  it('on touch the "Remove #hex" buttons are visible 44 px targets, never hover-revealed 20 px dots', () => {
    const doc = renderStyle(touch);
    const palette = screen.getByRole('group', { name: 'Palette' });
    const remove = within(palette).getAllByRole('button', { name: /^Remove #/ });
    expect(remove.length).toBe(doc.style.palette!.length);
    for (const b of remove) {
      expect(b.className).toContain('h-11');
      expect(b.className).toContain('w-11');
      expect(b.className).not.toContain('hover-reveal');
    }
  });

  it('with a mouse the palette keeps its compact, hover-revealed remove dots', () => {
    renderStyle(mouse);
    const palette = screen.getByRole('group', { name: 'Palette' });
    for (const b of within(palette).getAllByRole('button', { name: /^Remove #/ })) expect(b.className).toContain('hover-reveal');
  });

  it('a "Never" chip’s remove button is a 44 px square on touch (its hit area never reaches the field below)', () => {
    renderStyle(touch);
    const b = within(screen.getByRole('group', { name: 'Avoid' })).getByRole('button', { name: /^Allow / });
    expect(b.className).toContain('coarse:h-11');
    expect(b.className).toContain('coarse:w-11');
  });
});

describe('CastTab card', () => {
  it('the "Look details" disclosure is 44 px tall on touch', () => {
    const doc = makeSampleDoc();
    render(
      <FormFactorProvider value={touch}>
        <CastTab studio={makeStudio(doc)} doc={doc} />
      </FormFactorProvider>
    );
    const b = screen.getAllByRole('button', { name: /Look details/ })[0];
    expect(b.className).toContain('coarse:min-h-[44px]');
  });
});
