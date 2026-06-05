// Smoke + reduced-motion coverage for the studio Motion Kit (Sprint 0, S0.5).

import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, renderHook } from '@testing-library/react';
import { Reveal } from './Reveal';
import { Stagger, StaggerItem } from './Stagger';
import { Lift } from './Lift';
import { Shimmer, Skeleton } from './Shimmer';
import { StatusPulse } from './StatusPulse';
import { usePrefersReducedMotion } from './motion';

/** Install a matchMedia mock that reports `reduce` for the reduced-motion query. */
const mockMatchMedia = (reduce: boolean) => {
  const listeners = new Set<() => void>();
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    addListener: (cb: () => void) => listeners.add(cb),
    removeListener: (cb: () => void) => listeners.delete(cb),
    dispatchEvent: () => true,
    onchange: null,
  });
};

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe('Motion Kit primitives render their children', () => {
  it('Reveal renders children', () => {
    render(<Reveal><span>hello-reveal</span></Reveal>);
    expect(screen.getByText('hello-reveal')).toBeInTheDocument();
  });

  it('Stagger + StaggerItem render children', () => {
    render(
      <Stagger>
        <StaggerItem><span>item-a</span></StaggerItem>
        <StaggerItem><span>item-b</span></StaggerItem>
      </Stagger>
    );
    expect(screen.getByText('item-a')).toBeInTheDocument();
    expect(screen.getByText('item-b')).toBeInTheDocument();
  });

  it('Lift renders children', () => {
    render(<Lift><button>press-me</button></Lift>);
    expect(screen.getByText('press-me')).toBeInTheDocument();
  });

  it('Skeleton + Shimmer carry the shimmer class', () => {
    const { container } = render(<><Skeleton className="h-4 w-10" /><Shimmer lines={2} /></>);
    expect(container.querySelectorAll('.studio-shimmer').length).toBe(3); // 1 skeleton + 2 lines
  });
});

describe('StatusPulse', () => {
  it('labels each status and exposes a status role', () => {
    const { rerender } = render(<StatusPulse status="idle" />);
    expect(screen.getByRole('status')).toHaveTextContent('Idle');
    rerender(<StatusPulse status="starting" />);
    expect(screen.getByRole('status')).toHaveTextContent('Starting');
    rerender(<StatusPulse status="live" />);
    expect(screen.getByRole('status')).toHaveTextContent('Live');
    rerender(<StatusPulse status="error" />);
    expect(screen.getByRole('status')).toHaveTextContent('Error');
  });

  it('honours a custom label', () => {
    render(<StatusPulse status="live" label="Booting preview" />);
    expect(screen.getByRole('status')).toHaveTextContent('Booting preview');
  });
});

describe('usePrefersReducedMotion', () => {
  beforeEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  it('returns false when matchMedia is unavailable (jsdom default)', () => {
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  it('returns true when the user prefers reduced motion', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });

  it('returns false when the user does not prefer reduced motion', () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });
});
