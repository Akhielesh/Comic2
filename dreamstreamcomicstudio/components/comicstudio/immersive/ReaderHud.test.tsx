// ReaderHud: a hidden HUD takes no taps (P1-QA reader-hidden-hud-taps), keyboard focus still reaches it.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HUD_HIDDEN_ROW, ReaderHud, type ReaderHudProps } from './ReaderHud';

const props = (over: Partial<ReaderHudProps> = {}): ReaderHudProps => ({
  visible: true,
  title: 'Rooftop Heist',
  counter: 'Page 2 of 6',
  compact: false,
  guided: { on: false, playing: false, available: true },
  onGuided: vi.fn(),
  onPlay: vi.fn(),
  onPanel: vi.fn(),
  layout: { effective: 'single', allowSpread: true, show: true },
  onLayout: vi.fn(),
  onSettings: vi.fn(),
  settingsOpen: false,
  fullscreen: { on: false, supported: true },
  onFullscreen: vi.fn(),
  onClose: vi.fn(),
  scrubber: <div className="pointer-events-auto" data-testid="scrubber" />,
  rtl: false,
  onFocusWithin: vi.fn(),
  ...over
});

/** Every element that would take a pointer event on its own (pointer-events-auto, not overridden). */
const tappable = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>('.pointer-events-auto'));

describe('ReaderHud', () => {
  it('visible: the bars take taps', () => {
    const p = props();
    render(<ReaderHud {...p} />);
    const hud = screen.getByTestId('reader-hud');
    expect(tappable(hud).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Close reader' }));
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('hidden: no bar is pointer-events-auto, and both rows force every descendant (the host scrubber too) to none', () => {
    render(<ReaderHud {...props({ visible: false })} />);
    const hud = screen.getByTestId('reader-hud');
    expect(hud.dataset.visible).toBe('false');
    const rows = Array.from(hud.children) as HTMLElement[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      for (const cls of HUD_HIDDEN_ROW.split(' ')) expect(row.classList.contains(cls)).toBe(true);
      expect(row.className).toMatch(/opacity-0/);
    }
    // The only pointer-events-auto left is the host's scrubber, which the row's descendant rule overrides.
    expect(tappable(hud).map((el) => el.dataset.testid)).toEqual(['scrubber']);
    expect(HUD_HIDDEN_ROW).toContain('[&_*]:!pointer-events-none');
  });

  it('hidden: the controls stay in the accessibility tree and keyboard focus brings the HUD back', () => {
    const p = props({ visible: false });
    render(<ReaderHud {...p} />);
    const close = screen.getByRole('button', { name: 'Close reader' });
    expect(close).not.toHaveAttribute('inert');
    close.focus();
    expect(p.onFocusWithin).toHaveBeenCalled();
  });
});
