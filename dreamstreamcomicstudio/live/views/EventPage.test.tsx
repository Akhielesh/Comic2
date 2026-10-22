// @vitest-environment jsdom
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../nav';
import type { EventMeta } from '../protocol';

vi.mock('../api', () => ({ getEvent: vi.fn(), rsvpEvent: vi.fn() }));

import { getEvent } from '../api';
import { EventPage } from './EventPage';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 22, 18);

const meta = (over: Partial<EventMeta> = {}): EventMeta => ({
  id: 'ev1', title: 'Launch party', host: 'Ada', desc: '', cover: 0, access: 'open', quality: '720p', mime: '', segMs: 6000,
  status: 'idle', createdAt: T0 - 60 * MIN, scheduledAt: T0 + 50 * MIN, startedAt: null, endedAt: null, firstSeq: 0, latestSeq: 0,
  lastIngestAt: null, pinned: null, slowSec: 0, reactionsOn: true, maxViewers: 100, viewers: 0, rsvpCount: 0, rsvpNames: [], ...over,
});

let visibility: DocumentVisibilityState = 'visible';
const setVisible = (v: boolean) => {
  visibility = v ? 'visible' : 'hidden';
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};
const advance = async (ms: number) => {
  // Step a minute at a time so every scheduled look gets to run and reschedule.
  for (let left = ms; left > 0; left -= MIN) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(MIN, left));
    });
  }
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  vi.mocked(getEvent).mockReset();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

const renderPage = () => {
  const nav = { viewer: vi.fn() } as unknown as Nav & { viewer: ReturnType<typeof vi.fn> };
  render(<EventPage eventId="ev1" nav={nav} push={vi.fn()} />);
  return nav;
};

describe('EventPage — push, not poll (ADR 0007 C2)', () => {
  it('a waiting tab makes ≤ 6 looks (12 requests) an hour, not 120 (240)', async () => {
    vi.mocked(getEvent).mockResolvedValue(meta());
    renderPage();
    await advance(60 * MIN);
    const n = vi.mocked(getEvent).mock.calls.length;
    expect(n).toBeGreaterThanOrEqual(3); // still looking — 1 min before the start included
    expect(n).toBeLessThanOrEqual(6);
  });

  it('flips to the watch page within a couple of minutes of the host going live on time', async () => {
    vi.mocked(getEvent).mockResolvedValue(meta());
    const nav = renderPage();
    await advance(50 * MIN); // the start
    vi.mocked(getEvent).mockResolvedValue(meta({ status: 'live', startedAt: T0 + 50 * MIN }));
    await advance(2 * MIN);
    expect(nav.viewer).toHaveBeenCalledWith('ev1');
  });

  it('a hidden tab makes no requests and holds no timers; coming back looks once', async () => {
    vi.mocked(getEvent).mockResolvedValue(meta());
    renderPage();
    await act(async () => undefined);
    expect(getEvent).toHaveBeenCalledTimes(1);
    setVisible(false);
    expect(vi.getTimerCount()).toBe(0);
    await advance(3 * 60 * MIN);
    expect(getEvent).toHaveBeenCalledTimes(1);
    setVisible(true);
    await act(async () => undefined);
    expect(getEvent).toHaveBeenCalledTimes(2);
  });

  it('an ended event is never asked again', async () => {
    vi.mocked(getEvent).mockResolvedValue(meta({ status: 'ended', endedAt: T0 - MIN }));
    renderPage();
    await advance(2 * 60 * MIN);
    expect(getEvent).toHaveBeenCalledTimes(1);
    expect(screen.getByText('This event has ended')).toBeTruthy();
  });

  it('a network blip after the page loaded doesn’t turn it into “Event not found”', async () => {
    vi.mocked(getEvent).mockResolvedValueOnce(meta({ scheduledAt: null })).mockRejectedValue(new TypeError('Failed to fetch'));
    renderPage();
    await advance(10 * MIN);
    expect(vi.mocked(getEvent).mock.calls.length).toBeGreaterThan(1);
    expect(screen.queryByText('Event not found')).toBeNull();
    expect(screen.getByText('Launch party')).toBeTruthy();
  });
});
