// @vitest-environment jsdom
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MonQuery } from '../../monitor/query';
import { WeekCard } from './WeekCard';

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
