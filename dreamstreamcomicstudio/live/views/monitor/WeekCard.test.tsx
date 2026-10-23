// @vitest-environment jsdom
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonQuery } from '../../monitor/query';
import { WEEK_STALE_MS, WeekCard } from './WeekCard';

const day = (i: number, over: Record<string, unknown>) => ({
  day: i * 86_400_000, sleepMin: 600, nightMin: 540, naps: 3, wakings: 3, longestMin: 150, cryMin: 20, cries: 3, alerts: 2, responseSec: 60, sleepLaeq: 42, loud: 0, ...over,
});
const query = (days: unknown[]) => ({ ask: async () => ({ days }) }) as unknown as MonQuery;

describe('WeekCard', () => {
  it('calls a better week better, with the right direction per metric', async () => {
    const days = [...Array.from({ length: 7 }, (_, i) => day(i, {})), ...Array.from({ length: 7 }, (_, i) => day(i + 7, { wakings: 1, cryMin: 8, longestMin: 240 }))];
    render(<WeekCard query={query(days)} baby="Aria" />);
    await waitFor(() => expect(screen.getByText(/A better week/)).toBeTruthy());
    const wakings = screen.getByText('Night wakings').closest('.wk-row')!;
    expect(wakings.querySelector('.wk-delta')!.className).toContain('good');
    expect(wakings.textContent).toContain('1.0 a night');
    expect(screen.getByText('Longest stretch').closest('.wk-row')!.querySelector('.wk-delta')!.className).toContain('good');
  });

  it('flags a rougher week gently, and waits for enough nights', async () => {
    const worse = [...Array.from({ length: 7 }, (_, i) => day(i, { wakings: 1 })), ...Array.from({ length: 7 }, (_, i) => day(i + 7, { wakings: 3 }))];
    const { unmount } = render(<WeekCard query={query(worse)} baby="Aria" />);
    await waitFor(() => expect(screen.getByText(/Worth a look/)).toBeTruthy());
    unmount();
    const empty = Array.from({ length: 14 }, (_, i) => day(i, { sleepMin: 0, nightMin: 0, longestMin: 0, cries: 0, cryMin: 0, responseSec: null, sleepLaeq: null }));
    render(<WeekCard query={query(empty)} baby="Aria" />);
    await waitFor(() => expect(screen.getByText(/appears after a couple of nights/)).toBeTruthy());
  });
});

describe('WeekCard — push, not poll (ADR 0007 C2)', () => {
  let visibility: DocumentVisibilityState = 'visible';
  const fire = (target: Document | Window, type: string) =>
    act(() => {
      target.dispatchEvent(new Event(type));
    });
  const setVisible = (v: boolean) => {
    visibility = v ? 'visible' : 'hidden';
    fire(document, 'visibilitychange');
  };
  const flush = () => act(async () => undefined);
  const advance = (ms: number) => act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  const days = Array.from({ length: 14 }, (_, i) => day(i, {}));
  const setup = (visible: boolean) => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 22, 7));
    visibility = visible ? 'visible' : 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    const ask = vi.fn(async () => ({ days }));
    render(<WeekCard query={{ ask } as unknown as MonQuery} baby="Aria" />);
    return ask;
  };
  afterEach(() => vi.useRealTimers());

  it('hidden: no history queries and no timers, however long it stays hidden', async () => {
    const ask = setup(false);
    await flush();
    await advance(6 * 60 * 60_000);
    expect(ask).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    setVisible(true);
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('shown: one query, then only on coming back to the page once it is 10 min stale', async () => {
    const ask = setup(true);
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await advance(5 * 60_000);
    fire(window, 'focus');
    await flush();
    expect(ask).toHaveBeenCalledTimes(1); // still fresh
    await advance(WEEK_STALE_MS);
    expect(ask).toHaveBeenCalledTimes(1); // stale, but nothing asked: no timer
    fire(window, 'focus');
    await flush();
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
