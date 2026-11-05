// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

  it('an ended event is never asked again — not even when you switch back to the tab', async () => {
    vi.mocked(getEvent).mockResolvedValue(meta({ status: 'ended', endedAt: T0 - MIN }));
    renderPage();
    await act(async () => undefined);
    // Away and back every 10 minutes for an hour.
    for (let i = 0; i < 6; i++) {
      setVisible(false);
      await advance(10 * MIN);
      setVisible(true);
      await act(async () => undefined);
    }
    expect(getEvent).toHaveBeenCalledTimes(1);
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

describe('EventPage — the top bar fits a phone', () => {
  // Widths jsdom can't measure: the capture harness (stream-qa/scripts/topbar-event.mjs, a real
  // Chromium on the production build, touch and mouse) found the narrowest window each bar fits
  // on one line with the wordmark: 402 px for an ended event (mark + wordmark + legal links +
  // "Ended"), plus the pill's 12 px = 414 px; 422 px in Hanken Grotesk without the skin. A
  // scheduled event's bar (no pill): 353 px.
  const ENDED_BAR_NEEDS = 422;
  const PLAIN_BAR_NEEDS = 353;
  const css = (file: string) => readFileSync(path.join(process.cwd(), 'live/styles', file), 'utf8');
  /** The widest `max-width` media block that visually hides the wordmark for `selector`. */
  const hidesWordUnder = (selector: RegExp) => {
    let widest = 0;
    for (const m of css('features.css').matchAll(/@media \(max-width: (\d+)px\)\s*\{([\s\S]*?)\n\}/g)) {
      const rule = new RegExp(`${selector.source}[^{]*\\.ds-logo-word\\s*\\{([^}]*)\\}`).exec(m[2]);
      if (!rule) continue;
      // Visually hidden, never display: none — the mark's name is still read out.
      expect(rule[1]).toMatch(/position:\s*absolute[^}]*clip:/);
      expect(rule[1]).not.toMatch(/display:\s*none/);
      widest = Math.max(widest, Number(m[1]) + 1);
    }
    return widest;
  };

  it('marks the bar of an ended event, which also holds the "Ended" pill', async () => {
    vi.mocked(getEvent).mockResolvedValue(meta({ status: 'ended', endedAt: T0 - MIN }));
    renderPage();
    await act(async () => undefined);
    const bar = document.querySelector('.event-topbar')!;
    expect(bar.classList.contains('has-pill')).toBe(true);
    expect(bar.querySelector(':scope > .pill')?.textContent).toBe('Ended');
    expect(bar.querySelector('.ds-logo-word')).not.toBeNull();
  });

  it('leaves a scheduled event’s bar unmarked (no pill)', async () => {
    vi.mocked(getEvent).mockResolvedValue(meta());
    renderPage();
    await act(async () => undefined);
    const bar = document.querySelector('.event-topbar')!;
    expect(bar.classList.contains('has-pill')).toBe(false);
    expect(bar.querySelector('.pill')).toBeNull();
  });

  it('drops the wordmark from view wherever the bar would run off a touch screen', () => {
    // On touch screens the bar's legal links never wrap (app.css), so the wordmark must go first.
    expect(css('app.css')).toMatch(/\(pointer: coarse\)[\s\S]*\.event-topbar[^{]*\.legal-links\.compact\s*\{\s*flex-wrap:\s*nowrap/);
    expect(hidesWordUnder(/\.event-topbar\.has-pill/)).toBeGreaterThanOrEqual(ENDED_BAR_NEEDS);
    expect(hidesWordUnder(/\.event-topbar(?![.\w-])/)).toBeGreaterThanOrEqual(PLAIN_BAR_NEEDS); // any event bar
    // The pill's 12 px is part of the measured width.
    expect(css('screens.css')).toMatch(/\.event-topbar > \.pill\s*\{\s*margin-left:\s*12px/);
  });
});
