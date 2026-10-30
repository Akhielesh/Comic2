// Chat "usage left" banner (P1-LIMITS): percent only, and at 100% the honest hard stop is
// readable in full on a phone (no truncation) with its "API keys" path visible at every width.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), put: vi.fn() }));
vi.mock('../../services/apiClient', () => api);

import { __resetAllowanceStore, normalizeAllowanceStatus, publishAllowanceStatus, type AllowanceStatus } from '../../services/usageAllowance';
import { AllowanceBanner } from './AllowanceBanner';

const RAW = {
  enabled: true,
  governed: true,
  pctUsed: 72,
  pctLeft: 28,
  exhausted: false,
  crossed: [30, 70],
  resetsAt: null,
  friendlyUnits: { standardPages: 40, draftPages: 50, pctPerStandardPage: 0.65, label: 'about 40 standard comic pages left' },
  usePlatformAllowance: true,
  byokFallbackMode: 'ask',
  byokAvailable: false
};
const MONEY = /\$\s?\d|usd|dollar/i;

const show = async (over: Record<string, unknown>) => {
  const raw = { ...RAW, ...over };
  api.get.mockResolvedValue(raw);
  const view = render(<AllowanceBanner />);
  await act(async () => {
    publishAllowanceStatus(normalizeAllowanceStatus(raw) as AllowanceStatus);
  });
  return view;
};

beforeEach(() => {
  __resetAllowanceStore();
  api.get.mockReset();
  try {
    window.localStorage.clear();
  } catch {
    /* storage unavailable */
  }
});
afterEach(() => __resetAllowanceStore());

describe('AllowanceBanner', () => {
  it('shows usage left in percent and friendly units, never dollars', async () => {
    const { container } = await show({});
    const bar = screen.getByRole('status');
    expect(bar.textContent).toContain('28% of your DreamStream usage left');
    expect(bar.textContent).toContain('about 40 standard comic pages left');
    expect(container.textContent).not.toMatch(MONEY);
  });

  it('the 100% hard stop wraps (readable at 320 px) and keeps the API keys path visible on phones', async () => {
    const { container } = await show({ pctUsed: 100, pctLeft: 0, exhausted: true, crossed: [30, 70, 90, 100] });
    const bar = screen.getByRole('status');
    expect(bar.textContent).toContain("You've used all of your DreamStream usage.");
    expect(bar.textContent).toContain('ask us for a top-up, or add your own key');
    const copy = bar.querySelector('span.flex-1') as HTMLElement;
    expect(copy.className).not.toContain('truncate');
    // At 320 px the actions drop to a second line instead of squeezing the sentence to a sliver.
    expect(bar.className).toMatch(/(^|\s)flex-wrap(\s|$)/);
    expect(copy.className).toContain('min-w-[11rem]');
    const keys = screen.getByRole('button', { name: 'API keys' });
    expect(keys.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(container.textContent).not.toMatch(MONEY);
  });

  it('stays hidden for admins / exempt accounts and while the meter is unavailable', async () => {
    const admin = await show({ governed: false, pctUsed: 0, pctLeft: 100, crossed: [] });
    expect(admin.container.textContent).toBe('');
    admin.unmount();
    __resetAllowanceStore();
    const off = await show({ enabled: false, pctUsed: 95, pctLeft: 5, crossed: [30, 70, 90] });
    expect(off.container.textContent).toBe('');
  });
});
