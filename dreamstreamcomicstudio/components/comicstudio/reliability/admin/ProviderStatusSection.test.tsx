// Admin → Provider status (reliability.md §4): every registry model's live health and this server's breaker
// events, read-only, one request on open and one per Refresh — never a timer.
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderStatusReport } from '../statusApi';

const fetchReport = vi.fn<() => Promise<ProviderStatusReport>>();
vi.mock('../statusApi', async (orig) => ({ ...(await orig<typeof import('../statusApi')>()), fetchProviderStatusReport: () => fetchReport() }));

const { ProviderStatusSection } = await import('./ProviderStatusSection');
const { registeredAdminSections } = await import('../../features');

const NOW = new Date(2026, 9, 22, 17, 0, 0).getTime();
const report = (): ProviderStatusReport => ({
  now: NOW,
  bootedAt: NOW - 20 * 60_000,
  models: [
    {
      modelId: 'nano-banana-2.1',
      state: 'down',
      checkedAt: NOW,
      routes: [
        {
          route: 'openrouter',
          model: 'google/gemini-nano-banana-2.1',
          state: 'down',
          providers: [{ name: 'Google AI Studio', status: -1, uptime30m: 41, uptime1d: 93.4 }],
          observed: { ok: 0, upstreamFailures: 3, lastCode: 'RATE_LIMIT', lastFailureAt: NOW - 8 * 60_000 },
          reason: 'Our last 3 calls failed (RATE_LIMIT)',
          checkedAt: NOW - 2 * 60_000,
          source: 'openrouter'
        },
        { route: 'gemini', model: 'gemini-nano-banana-2.1', state: 'unknown', checkedAt: NOW, source: 'none' }
      ]
    },
    { modelId: 'nano-banana-pro', state: 'ok', checkedAt: NOW, routes: [{ route: 'openrouter', model: 'google/gemini-nano-banana-pro', state: 'ok', checkedAt: NOW, source: 'openrouter' }] }
  ],
  breakerEvents: [
    { at: NOW - 8 * 60_000, route: 'openrouter', model: 'google/gemini-nano-banana-2.1', event: 'opened', code: 'RATE_LIMIT', failures: 3 }
  ]
});

beforeEach(() => {
  fetchReport.mockReset();
  fetchReport.mockResolvedValue(report());
});
afterEach(() => vi.useRealTimers());

describe('ProviderStatusSection', () => {
  it('is registered as an admin section', () => {
    const entry = registeredAdminSections().find((s) => s.id === 'provider-status');
    expect(entry?.label).toBe('Provider status');
  });

  it('lists every model with its routes, providers, our own calls, and the breaker events since boot', async () => {
    render(<ProviderStatusSection />);
    await act(async () => undefined);
    expect(fetchReport).toHaveBeenCalledTimes(1);
    const models = screen.getByRole('list', { name: 'Image models' });
    const rows = within(models).getAllByRole('listitem').filter((li) => li.hasAttribute('data-model'));
    expect(rows.map((r) => r.getAttribute('data-model'))).toEqual(['nano-banana-2.1', 'nano-banana-pro']);
    const nb = rows[0];
    expect(nb).toHaveTextContent('Nano Banana 2.1');
    expect(nb).toHaveTextContent('our last 3 calls failed: rate limited');
    expect(within(nb).getByRole('list', { name: 'OpenRouter providers' })).toHaveTextContent('Google AI Studiostatus -130 min 41%24 h 93.4%');
    expect(nb).toHaveTextContent('Our calls (5 min): 0 ok · 3 upstream failures in a row · last RATE_LIMIT · last failure 16:52');
    expect(nb).toHaveTextContent('OpenRouter status, 2 min ago');
    expect(nb).toHaveTextContent('no live data');
    expect(screen.getByText('Breaker events on this server').parentElement).toHaveTextContent(/16:52\s*Paused\s*OpenRouter\s*google\/gemini-nano-banana-2\.1\s*after 3 failures \(RATE_LIMIT\)/);
    expect(screen.getByText(/Since it started 16:40 \(20 min ago\)/)).toBeInTheDocument();
  });

  it('refreshes only on click — no timers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    render(<ProviderStatusSection />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    expect(fetchReport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await act(async () => undefined);
    expect(fetchReport).toHaveBeenCalledTimes(2);
  });

  it('says so calmly when the report cannot be read', async () => {
    fetchReport.mockRejectedValueOnce(new Error('Admin access required'));
    render(<ProviderStatusSection />);
    await act(async () => undefined);
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't read provider status: Admin access required");
  });
});
