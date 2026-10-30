// The QA harness's History switch (wave 2b ig1 FIX wave note 4): `?surface=studio&history=1` turns Comic History on and
// answers it offline from the fake HistoryApi over the synthetic 'v5' history fixture, so the layout harness can open
// and measure the History panel with no backend. Without the param the studio is exactly as before: no History entry
// point, nobody answers an open request, nothing reads History.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// Any History read that escaped to the HTTP client would land here (the harness must never reach a backend).
const net = vi.hoisted(() => ({ get: vi.fn(async () => ({})), post: vi.fn(async () => ({})) }));
vi.mock('../services/apiClient', async (orig) => ({ ...(await orig<object>()), get: net.get, post: net.post }));

import { ComicQaApp } from './ComicQaApp';
import { clearQaOps, parseQaParams } from '../components/comicstudio/testing/qaController';
import { requestOpenHistory } from '../components/comicstudio/history/index';
import { resetBackStack } from '../components/comicstudio/mobile/backStack';

const settle = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  window.localStorage.clear();
  resetBackStack();
  clearQaOps();
  net.get.mockClear();
  net.post.mockClear();
});
afterEach(() => {
  cleanup();
  resetBackStack();
});

const historyReads = () => [...net.get.mock.calls, ...net.post.mock.calls].map((c) => String((c as unknown[])[0])).filter((u) => /history/i.test(u));

describe('?surface=studio&history=1', () => {
  it('shows the History entry and opens the panel on the fake v5 history, with no network', async () => {
    render(<ComicQaApp params={parseQaParams('?surface=studio&history=1')} />);
    await act(async () => {
      await settle();
    });
    const entry = document.querySelector('[data-history-entry="header"]') as HTMLButtonElement | null;
    expect(entry).not.toBeNull();
    fireEvent.click(entry!);
    await act(async () => {
      await settle(12);
    });
    // The fake's moments (historyFixture('v5')): a named draft and the AI revision are listed.
    expect(await screen.findAllByText('Draft 2')).not.toHaveLength(0);
    expect(screen.getAllByText(/AI revised pages 3–4/).length).toBeGreaterThan(0);
    expect(historyReads()).toEqual([]);
  });
});

describe('default QA (no history param) is unchanged', () => {
  it('no History entry point, and an open request is answered by nobody and reads nothing', async () => {
    render(<ComicQaApp params={parseQaParams('?surface=studio')} />);
    await act(async () => {
      await settle();
    });
    expect(document.querySelector('[data-history-entry]')).toBeNull();
    let handled = true;
    await act(async () => {
      handled = requestOpenHistory({ view: 'list' });
      await settle();
    });
    expect(handled).toBe(false);
    expect(document.querySelector('[data-history-sheet]')).toBeNull();
    expect(historyReads()).toEqual([]);
    expect(screen.queryByText('Draft 2')).toBeNull();
  });
});
