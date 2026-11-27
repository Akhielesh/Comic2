// The full-screen reader's settings sheet: the Reading mode hint says what the turn really does. On a low-power
// device only the styles that turn lighter there (the paper and the fade slide) promise a lighter transition; the flip
// and the slide play unchanged, so their hint stays their own.
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PageTurnStyle } from '../../../shared/comic/doc';
import { DEFAULT_PREFS, type TurnPref } from './readerPrefs';
import { ReaderSettingsSheet } from './ReaderSettingsSheet';
import { lighterOnLowPower, simpleTurnKind } from './turnPlan';

const LIGHTER = 'Use the arrows or swipe. A lighter transition keeps pages responsive.';

const sheet = (opts: { creatorTurn?: PageTurnStyle; turn?: TurnPref; lowPower?: boolean; osReducedMotion?: boolean }) =>
  render(
    <ReaderSettingsSheet
      open
      compact={false}
      prefs={{ ...DEFAULT_PREFS, turn: opts.turn ?? 'auto', ...(opts.turn && opts.turn !== 'auto' ? { turnPicked: true as const } : {}) }}
      onPrefs={() => undefined}
      layout={{ pref: 'auto', canTurnPages: true }}
      onLayout={() => undefined}
      creatorTurn={opts.creatorTurn ?? 'flip'}
      lowPower={opts.lowPower ?? false}
      osReducedMotion={opts.osReducedMotion ?? false}
      onShortcuts={() => undefined}
      onClose={() => undefined}
    />
  );
const modeHint = () => screen.getByRole('group', { name: 'Reading mode' }).querySelector('p')?.textContent;

describe('ReaderSettingsSheet: the Reading mode hint', () => {
  it('low power: the flip (the default) keeps its own hint, since it plays unchanged there', () => {
    const { unmount } = sheet({ lowPower: true });
    expect(modeHint()).toBe('Swipe, tap a page edge or use the arrows to turn the page.');
    unmount();
    sheet({ lowPower: true, creatorTurn: 'paper', turn: 'slide' });
    expect(modeHint()).not.toBe(LIGHTER);
  });

  it('low power: the paper and the fade (the creator’s or the reader’s own) say a lighter transition plays', () => {
    const { unmount } = sheet({ lowPower: true, creatorTurn: 'paper' });
    expect(modeHint()).toBe(LIGHTER);
    unmount();
    sheet({ lowPower: true, turn: 'fade' });
    expect(modeHint()).toBe(LIGHTER);
  });

  it('without low power the paper invites a drag and the others a swipe; reduced motion says so first', () => {
    const { unmount } = sheet({ creatorTurn: 'paper' });
    expect(modeHint()).toBe('Drag a page edge or use the arrows to turn the page.');
    unmount();
    const second = sheet({ lowPower: true, creatorTurn: 'paper', osReducedMotion: true });
    expect(modeHint()).toBe('Use the arrows or swipe. Reduced motion is on.');
    second.unmount();
    sheet({ turn: 'fade' });
    expect(modeHint()).toBe('Swipe, tap a page edge or use the arrows to turn the page.');
  });

  it('the hint follows the turn plan: lighter exactly where a low-power device swaps the motion', () => {
    for (const style of ['flip', 'paper', 'slide', 'fade'] as const) {
      expect(lighterOnLowPower(style), style).toBe(simpleTurnKind(style, true) !== style);
    }
    expect((['flip', 'paper', 'slide', 'fade'] as const).filter(lighterOnLowPower)).toEqual(['paper', 'fade']);
  });
});
