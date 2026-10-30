// board/ui (visualqa P1-1, P1-2, P2-2, P2-6; mobile.md §2.4): fields ellipsize and re-measure, coarse
// pointers get 44 px controls, overlays never sit on top of placeholder copy, and a stuck render
// stops counting and offers a free re-check.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { GhostButton, IconButton, InlineField, PrimaryButton, RenderOverlay, STUCK_FACTOR, Segmented, SwitchRow, isStuck, registerStudioRefresh } from './ui';

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
    // Icon-only segments (the pane switcher) are 44 wide on touch too, not just 44 tall.
    expect(screen.getByRole('radio', { name: 'A' }).className).toContain('coarse:min-w-[44px]');
  });
});

describe('Segmented', () => {
  it('a mixed multi-selection (no option checked) keeps the first enabled option in the tab order', () => {
    render(
      <Segmented
        label="Weight"
        value={'' as 'a' | 'b' | 'c' | ''}
        onChange={vi.fn()}
        options={[
          { value: 'a', label: 'Regular', disabled: true },
          { value: 'b', label: 'Bold' },
          { value: 'c', label: 'Black' }
        ]}
      />
    );
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    expect(radios.every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
  });

  it('arrow keys from the mixed state move to and select an option', () => {
    const onChange = vi.fn();
    render(<Segmented label="Align" value={'' as 'l' | 'c' | ''} onChange={onChange} options={[{ value: 'l', label: 'Left' }, { value: 'c', label: 'Center' }]} />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Left' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('text labels truncate inside their segment instead of overlapping a neighbour', () => {
    render(<Segmented label="Kind" value="a" onChange={vi.fn()} options={[{ value: 'a', label: 'A very long segment label' }]} />);
    const label = screen.getByText('A very long segment label');
    expect(label.className).toContain('truncate');
    expect(label.className).toContain('min-w-0');
  });
});

describe('SwitchRow', () => {
  it('is a labelled switch with a 44 px row on touch', () => {
    const onChange = vi.fn();
    render(<SwitchRow label="Title page" description="The cover title on a page of its own" checked={false} onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Title page' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveAccessibleDescription('The cover title on a page of its own');
    expect(sw.className).toContain('coarse:min-h-[44px]');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('RenderOverlay', () => {
  it('a failed overlay is CALM: opaque over placeholders, when + why, Details on demand, no alert role', () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const onRetry = vi.fn();
    render(
      <div className="relative">
        <RenderOverlay status="failed" error="The model refused" since={now - 60_000} label="Page 2" onRetry={onRetry} />
      </div>
    );
    expect(screen.queryByRole('alert')).toBeNull();
    const group = screen.getByRole('group', { name: /^Page 2: failed \d\d:\d\d · the model declined$/ });
    expect(group.className).toContain('bg-[var(--ds-surface)]');
    expect(group).not.toHaveTextContent('The model refused');
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(group).toHaveTextContent('The model refused');
    expect(screen.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('a failure from an earlier day says which day (a stale outage is recognisable)', () => {
    const now = new Date(2026, 9, 22, 18, 0).getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    render(
      <div className="relative">
        <RenderOverlay status="failed" render={{ error: 'Provider error 503', updatedAt: new Date(2026, 9, 20, 16, 52).getTime() }} />
      </div>
    );
    expect(screen.getByRole('group', { name: 'failed Oct 20, 16:52 · provider busy' })).toBeInTheDocument();
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

  it('without a caller-supplied re-check, a stuck overlay uses the open studio’s free refresh — and offers no dead button outside one', () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const stuck = (
      <div className="relative">
        <RenderOverlay status="queued" since={now - 3 * 3_600_000} typicalSec={20} />
      </div>
    );
    const first = render(stuck);
    expect(screen.getByText(/Still queued · much longer than usual/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    first.unmount();

    const refresh = vi.fn();
    const unregister = registerStudioRefresh(refresh);
    try {
      render(stuck);
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });
});

// Device-matrix follow-ups (ui-findings 2026-10-29, P2-BOARD): two adjacent 36 px icon buttons stole
// each other's 44 px ::after; an icon-only sm button was 42 px wide; unselected segments measured
// 4.39:1; the overlay's Check again / Retry pills were 15–40 px tall and their ::after was clipped by
// the frame they sit in.
describe('touch sizes (device-matrix follow-ups)', () => {
  it('small icon buttons are a real 44 px square on touch (side by side, neither steals the other’s tap)', () => {
    render(<IconButton size="sm" label="Show the script">s</IconButton>);
    const b = screen.getByRole('button', { name: 'Show the script' });
    expect(b.className).toContain('coarse:h-11');
    expect(b.className).toContain('coarse:w-11');
    expect(b.className).not.toContain('tap-target');
  });

  it('icon-only sm/md buttons keep 44 px of width on touch', () => {
    render(
      <>
        <PrimaryButton size="sm" aria-label="Read full screen">
          x
        </PrimaryButton>
        <GhostButton size="md">Go</GhostButton>
      </>
    );
    expect(screen.getByRole('button', { name: 'Read full screen' }).className).toContain('coarse:min-w-[44px]');
    expect(screen.getByRole('button', { name: 'Go' }).className).toContain('coarse:min-w-[44px]');
  });

  it('unselected segments read in ink, not muted (muted on the well is 4.39:1, under AA)', () => {
    render(
      <Segmented
        label="Card size"
        value="a"
        onChange={vi.fn()}
        options={[
          { value: 'a', label: 'Large' },
          { value: 'b', label: 'Compact' }
        ]}
      />
    );
    const off = screen.getByRole('radio', { name: 'Compact' });
    expect(off.className).not.toContain('text-[var(--ds-muted)]');
    expect(off.className).toContain('text-[var(--ds-ink)]');
  });

  it('the overlay’s Check again and Retry are 44 px tall on touch (a real box, not a clipped ::after)', () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    render(
      <div className="relative">
        <RenderOverlay status="rendering" since={now - 20 * 60_000} typicalSec={30} onRefresh={vi.fn()} />
        <RenderOverlay status="failed" error="x" since={now} onRetry={vi.fn()} />
      </div>
    );
    expect(screen.getByRole('button', { name: 'Check again' }).className).toContain('coarse:min-h-[44px]');
    expect(screen.getByRole('button', { name: /Retry/ }).className).toContain('coarse:min-h-[44px]');
  });
});
