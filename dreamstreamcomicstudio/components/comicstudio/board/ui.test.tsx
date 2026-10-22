// board/ui (visualqa P1-1, P1-2, P2-2, P2-6; mobile.md §2.4): fields ellipsize and re-measure, coarse
// pointers get 44 px controls, overlays never sit on top of placeholder copy, and a stuck render
// stops counting and offers a free re-check.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { GhostButton, IconButton, InlineField, PrimaryButton, RenderOverlay, STUCK_FACTOR, Segmented, isStuck } from './ui';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('InlineField', () => {
  it('single-line fields end in an ellipsis and carry the whole value as a title', () => {
    render(<InlineField label="Title" value="The Lighthouse Keeper of Willowmere Lake: A Watercolor Story" onCommit={vi.fn()} />);
    const input = screen.getByLabelText('Title');
    expect(input.className).toContain('text-ellipsis');
    expect(input).toHaveAttribute('title', 'The Lighthouse Keeper of Willowmere Lake: A Watercolor Story');
    expect(input.className).toContain('coarse:text-base');
  });

  it('multiline fields re-measure when their WIDTH changes (split drag), not on their own height changes', () => {
    let fire: ((records: Array<{ contentRect: { width: number } }>) => void) | null = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: (records: Array<{ contentRect: { width: number } }>) => void) {
          fire = cb;
        }
        observe() {}
        disconnect() {}
      }
    );
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    render(<InlineField label="Logline" multiline value="A long logline that wraps" onCommit={vi.fn()} />);
    const area = screen.getByLabelText('Logline') as HTMLTextAreaElement;
    let scrollHeight = 40;
    Object.defineProperty(area, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    scrollHeight = 120;
    act(() => fire?.([{ contentRect: { width: 180 } }]));
    expect(area.style.height).toBe('122px');
    scrollHeight = 200;
    act(() => fire?.([{ contentRect: { width: 180 } }])); // same width: no re-measure (no RO loop)
    expect(area.style.height).toBe('122px');
  });

  it('submitOnEnter: Enter commits a wrapping field, Shift+Enter is a newline', () => {
    const onCommit = vi.fn();
    render(<InlineField label="Name" multiline submitOnEnter value="Maya" onCommit={onCommit} />);
    const area = screen.getByLabelText('Name');
    area.focus();
    fireEvent.change(area, { target: { value: 'Maya Rao' } });
    expect(fireEvent.keyDown(area, { key: 'Enter', shiftKey: true })).toBe(true);
    fireEvent.keyDown(area, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('Maya Rao');
  });
});

describe('touch sizes (token-level, mobile.md §2.4)', () => {
  it('buttons, icon buttons and segments carry their coarse 44 px classes', () => {
    render(
      <>
        <PrimaryButton size="sm">Approve</PrimaryButton>
        <GhostButton size="xs">Not now</GhostButton>
        <IconButton label="Close">x</IconButton>
        <Segmented label="Mode" value="a" onChange={vi.fn()} options={[{ value: 'a', label: 'A' }]} size="xs" />
      </>
    );
    expect(screen.getByRole('button', { name: 'Approve' }).className).toContain('coarse:h-11');
    expect(screen.getByRole('button', { name: 'Not now' }).className).toContain('tap-target');
    expect(screen.getByRole('button', { name: 'Close' }).className).toContain('coarse:h-11');
    expect(screen.getByRole('radio', { name: 'A' }).className).toContain('coarse:min-h-[44px]');
  });
});

describe('RenderOverlay', () => {
  it('a failed overlay over a placeholder is opaque (the "Not drawn yet" copy never shows through)', () => {
    render(
      <div className="relative">
        <RenderOverlay status="failed" error="The model refused" onRetry={vi.fn()} />
      </div>
    );
    expect(screen.getByRole('alert').className).toContain('bg-[var(--ds-surface)]');
  });

  it('far past the usual time the clock stops and offers a free re-check (no "378d")', () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const onRefresh = vi.fn();
    render(
      <div className="relative">
        <RenderOverlay status="rendering" since={now - 378 * 86_400_000} typicalSec={30} onRefresh={onRefresh} />
      </div>
    );
    expect(screen.queryByText(/378d/)).toBeNull();
    expect(screen.getByText(/Still drawing · much longer than usual/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onRefresh).toHaveBeenCalled();
    expect(isStuck(30_000 * STUCK_FACTOR + 1, 30)).toBe(true);
    expect(isStuck(29_000, 30)).toBe(false);
  });
});
