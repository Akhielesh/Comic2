// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MinuteRow } from '../../monitor/protocol';
import type { MonQuery } from '../../monitor/query';
import { SOUND_HISTORY_STALE_MS, SoundLevelCard } from './SoundLevelCard';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 22, 2);

let visibility: DocumentVisibilityState = 'visible';
const setVisible = (v: boolean) => {
  visibility = v ? 'visible' : 'hidden';
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};
const flush = () => act(async () => undefined);
const advance = (ms: number) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});

const minute = (m: number): MinuteRow => ({ dev: 'cam1', m, laeq: 38, lmax: 44, l90: 35, motion: 0, crib: 0, light: 0, state: 1, cal: 0, visit: 0, sounds: {} });

function setup(visibleAtStart = true) {
  visibility = visibleAtStart ? 'visible' : 'hidden';
  const ask = vi.fn(async (_q: string, args: Record<string, unknown>) => ({ from: Number(args.from), to: Number(args.to), res: 5 * MIN, pts: [] }));
  const query = { ask } as unknown as MonQuery;
  let minutes: MinuteRow[] = [];
  const props = () => ({ query, dev: 'cam1', spl: null, online: true, liveMinutes: minutes, machineCheck: true });
  const view = render(<SoundLevelCard {...props()} />);
  /** The room pushes a new minute row (MonitorViewer keeps the last 240 as liveMinutes). */
  const push = () => {
    minutes = [...minutes, minute(Date.now())].slice(-240);
    view.rerender(<SoundLevelCard {...props()} />);
  };
  return { ask, push, view };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(() => vi.useRealTimers());

describe('SoundLevelCard — push, not poll (ADR 0007 C2)', () => {
  it('asks for history once when shown, and holds no timers', async () => {
    const { ask } = setup();
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toBe('history');
    expect(vi.getTimerCount()).toBe(0);
    await advance(3 * 60 * MIN);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('while hidden: zero history queries, even as the room pushes minutes', async () => {
    const { ask, push } = setup(false);
    await flush();
    for (let i = 0; i < 30; i++) {
      await advance(MIN);
      push();
    }
    expect(ask).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    setVisible(true);
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('pushed minutes refresh a stale chart — at most once per chart bucket', async () => {
    const { ask, push } = setup();
    await flush();
    for (let i = 0; i < 4; i++) {
      await advance(MIN);
      push();
      await flush();
    }
    expect(ask).toHaveBeenCalledTimes(1); // still fresh (6 h chart = 5-min buckets)
    await advance(SOUND_HISTORY_STALE_MS['6h']);
    push();
    await flush();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('keeps refreshing after hours of pushes, when the viewer’s list of minutes is full', async () => {
    const { ask, push } = setup();
    await flush();
    for (let i = 0; i < 250; i++) {
      await advance(MIN);
      push();
    }
    await flush();
    const before = ask.mock.calls.length;
    await advance(SOUND_HISTORY_STALE_MS['6h']);
    push(); // the list stays at 240 rows; the newest one is new
    await flush();
    expect(ask.mock.calls.length).toBe(before + 1);
  });

  it('coming back to the page refreshes only if stale; hiding mid-way stops everything', async () => {
    const { ask } = setup();
    await flush();
    setVisible(false);
    setVisible(true);
    await flush();
    expect(ask).toHaveBeenCalledTimes(1); // fresh: no extra query
    setVisible(false);
    await advance(2 * 60 * MIN);
    expect(ask).toHaveBeenCalledTimes(1);
    setVisible(true);
    await flush();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('changing the range asks for that range right away', async () => {
    const { ask } = setup();
    await flush();
    fireEvent.click(screen.getByRole('radio', { name: '24 h' }));
    await flush();
    expect(ask).toHaveBeenCalledTimes(2);
    const [, args] = ask.mock.calls[1];
    expect(Number(args.to) - Number(args.from)).toBe(24 * 60 * MIN);
  });
});
