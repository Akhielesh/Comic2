// Typed history intents (versions plan §8): "history" / "show history" opens the panel, "undo last AI change" sends
// history_undo_ai — locally, free, never to the director — and only while Comic History is on. Anything richer goes
// to the director. A typed "undo" with nothing to undo locally offers the undo-AI sheet.

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { historyFixture } from './__scenes__/historyFixtures';
import { handleHistoryIntent, historyUndoFallback, matchHistoryIntent, type HistoryIntentHost } from './intents';

const host = (on = true, opened = true) => {
  const h = {
    caps: { ...DEFAULT_CAPS, history: on },
    doc: historyFixture('v5').live,
    act: vi.fn(async (_a: unknown) => undefined as unknown),
    openHistory: vi.fn((_r?: unknown) => opened),
    say: vi.fn((_t: string) => undefined)
  };
  return h satisfies HistoryIntentHost;
};

describe('matchHistoryIntent', () => {
  it('matches the short commands, with polite words and punctuation', () => {
    for (const t of ['history', 'History.', 'show history', 'Show me the history please', 'open version history', 'show versions', 'ok, see my history!']) expect(matchHistoryIntent(t), t).toEqual({ kind: 'open', view: 'list' });
    for (const t of ['undo last AI change', 'Undo the last AI change.', 'undo the AI edit', 'undo what the AI just did']) expect(matchHistoryIntent(t), t).toEqual({ kind: 'undo_ai' });
  });

  it('leaves everything else to the director', () => {
    for (const t of ['show me yesterday’s version', 'go back to how page 3 looked this morning', 'undo', 'the history of the market', 'write the history page', '']) expect(matchHistoryIntent(t), t).toBeNull();
  });
});

describe('handleHistoryIntent', () => {
  it('opens the panel; sends history_undo_ai (free) and says so', () => {
    const h = host();
    expect(handleHistoryIntent({ kind: 'open', view: 'list' }, h)).toBe(true);
    expect(h.openHistory).toHaveBeenCalledWith({ view: 'list' });
    expect(handleHistoryIntent({ kind: 'undo_ai' }, h)).toBe(true);
    expect(h.act).toHaveBeenCalledWith({ type: 'history_undo_ai' });
    expect(h.say.mock.calls[0][0]).toMatch(/free/);
  });

  it('does nothing while Comic History is off, or when no panel answered', () => {
    const off = host(false);
    expect(handleHistoryIntent({ kind: 'open' }, off)).toBe(false);
    expect(handleHistoryIntent({ kind: 'undo_ai' }, off)).toBe(false);
    expect(off.act).not.toHaveBeenCalled();
    expect(handleHistoryIntent({ kind: 'open' }, host(true, false))).toBe(false);
  });
});

describe('historyUndoFallback', () => {
  it('offers the undo-AI sheet (nothing happens without a tap), only while on', () => {
    const h = host();
    expect(historyUndoFallback(h)).toBe(true);
    expect(h.openHistory).toHaveBeenCalledWith({ view: 'undo_ai' });
    expect(h.act).not.toHaveBeenCalled();
    expect(historyUndoFallback(host(false))).toBe(false);
  });
});
