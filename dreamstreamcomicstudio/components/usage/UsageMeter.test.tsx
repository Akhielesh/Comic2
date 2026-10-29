// Usage-left meter + Comic Studio header slot (P1-LIMITS): percent only, honest exhausted state,
// hidden for admins/own key, 44 px targets and no horizontal overflow at 360 px.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), put: vi.fn() }));
vi.mock('../../services/apiClient', () => api);

import { __resetAllowanceStore, getLastAllowanceStatus, normalizeAllowanceStatus, publishAllowanceStatus, type AllowanceStatus } from '../../services/usageAllowance';
import { UsageMeter, UsageMeterPill, UsageDetails, clampPopover, usageAriaLabel } from './UsageMeter';
import { feature } from '../comicstudio/usage/index';
import { UsageSlot, USAGE_SLOT_ORDER } from '../comicstudio/usage/UsageSlot';
import { DEFAULT_CAPS } from '../../shared/comic/capabilities';

const RAW = {
  enabled: true,
  governed: true,
  pctUsed: 62,
  pctLeft: 38,
  exhausted: false,
  crossed: [30],
  resetsAt: null,
  friendlyUnits: { standardPages: 55, draftPages: 70, pctPerStandardPage: 0.65, label: 'about 55 standard comic pages left' },
  usePlatformAllowance: true,
  byokFallbackMode: 'ask',
  byokAvailable: false
};
const status = (over: Record<string, unknown> = {}) => normalizeAllowanceStatus({ ...RAW, ...over }) as AllowanceStatus;
const MONEY = /\$\s?\d|usd|dollar/i;

const setViewport = (w: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  document.documentElement.style.width = `${w}px`;
};

beforeEach(() => {
  __resetAllowanceStore();
  api.get.mockReset().mockResolvedValue(RAW);
  setViewport(360);
});
afterEach(() => __resetAllowanceStore());

describe('UsageMeterPill', () => {
  it('shows percent left (never money) with an honest label', () => {
    render(<UsageMeterPill status={status()} />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveTextContent('38% left');
    expect(btn.getAttribute('aria-label')).toBe('Usage left: 38% — about 55 standard comic pages left. Open for details.');
    expect(btn.textContent).not.toMatch(MONEY);
    expect(btn.className).toMatch(/coarse:h-11/);
  });

  it('compact (phones) is a 44 px gauge with the number inside', () => {
    render(<UsageMeterPill status={status()} compact />);
    const btn = screen.getByRole('button');
    expect(btn.className).toMatch(/\bh-11\b/);
    expect(btn.className).toMatch(/\bw-11\b/);
    expect(btn).toHaveTextContent('38');
  });

  it('turns into a calm "used up" state', () => {
    render(<UsageMeterPill status={status({ pctUsed: 100, pctLeft: 0, exhausted: true })} />);
    expect(screen.getByRole('button')).toHaveTextContent('Usage used up');
    expect(usageAriaLabel(status({ exhausted: true }))).toBe('Usage left: none. Open for your options.');
  });
});

describe('UsageDetails', () => {
  it('explains the shared usage in friendly units, without dollars', () => {
    const { container } = render(<UsageDetails status={status()} />);
    expect(container).toHaveTextContent('38%');
    expect(container).toHaveTextContent('about 55 standard comic pages left');
    expect(container).toHaveTextContent('Shared across every studio');
    expect(container).toHaveTextContent('own API keys never uses it');
    expect(container.textContent).not.toMatch(MONEY);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '38');
    // width is clamped to the viewport (16 px gutters) — no horizontal overflow at 360 px
    expect((container.firstChild as HTMLElement).className).toContain('w-[min(20rem,calc(100vw-2rem))]');
  });

  it('exhausted: the honest hard stop with the top-up and own-key paths', () => {
    const { container } = render(<UsageDetails status={status({ pctUsed: 100, pctLeft: 0, exhausted: true })} />);
    expect(container).toHaveTextContent("You've used all of your DreamStream usage");
    expect(container).toHaveTextContent('top-up');
    expect(container).toHaveTextContent('Nothing more is spent');
    const link = screen.getByRole('link', { name: /add your own key/i });
    expect(link).toHaveAttribute('href', '/?view=settings&tab=settings');
    expect(container.textContent).not.toMatch(MONEY);
  });
});

describe('UsageDetails — usage used up while a personal key is already on file (360 px)', () => {
  const keyed = (byokFallbackMode: 'ask' | 'auto' | 'never') =>
    status({ pctUsed: 100, pctLeft: 0, exhausted: true, crossed: [30, 70, 90, 100], byokAvailable: true, byokFallbackMode });

  it("'ask': offers the consent action instead of telling the user to add a key they already added", async () => {
    api.patch.mockResolvedValue({ ...RAW, pctUsed: 100, pctLeft: 0, exhausted: true, crossed: [30, 70, 90, 100], byokAvailable: true, byokFallbackMode: 'auto' });
    const { container } = render(<UsageDetails status={keyed('ask')} />);
    expect(container).toHaveTextContent("You've used all of your DreamStream usage");
    expect(container).toHaveTextContent('on file');
    // Without the fix: the "Add your own key" link and no consent action.
    expect(screen.queryByText(/add your own key/i)).toBeNull();
    const consent = screen.getByRole('button', { name: /continue with my key/i });
    expect(consent.className).toMatch(/coarse:h-11/);
    expect(screen.getByRole('link', { name: /api keys/i })).toHaveAttribute('href', '/?view=settings&tab=settings');
    expect(container.textContent).not.toMatch(MONEY);
    expect((container.firstChild as HTMLElement).className).toContain('w-[min(20rem,calc(100vw-2rem))]');
    await act(async () => {
      fireEvent.click(consent);
    });
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch.mock.calls[0][0]).toBe('/api/account/billing-prefs');
    expect(api.patch.mock.calls[0][1]).toEqual({ byokFallbackMode: 'auto' });
    // The consent lands in the shared store, so every meter and the chat banner follow at once.
    expect(getLastAllowanceStatus()?.byokFallbackMode).toBe('auto');
  });

  it("'auto': says the key is what is used now — no 'add' link, no consent button", () => {
    const { container } = render(<UsageDetails status={keyed('auto')} />);
    expect(container).toHaveTextContent(/runs on your own key/i);
    expect(screen.queryByText(/add your own key/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /continue with my key/i })).toBeNull();
    expect(screen.getByRole('link', { name: /api keys/i })).toHaveAttribute('href', '/?view=settings&tab=settings');
    expect(container.textContent).not.toMatch(MONEY);
  });

  it("'never': says why the key on file is not used and where to change that", () => {
    const { container } = render(<UsageDetails status={keyed('never')} />);
    expect(container).toHaveTextContent(/set to never be used/i);
    expect(container).toHaveTextContent('Nothing more is spent');
    expect(screen.queryByText(/add your own key/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /continue with my key/i })).toBeNull();
    expect(screen.getByRole('link', { name: /api keys/i })).toHaveAttribute('href', '/?view=settings&tab=settings');
    expect(container.textContent).not.toMatch(MONEY);
  });
});

describe('UsageMeter (self-contained)', () => {
  it('opens a viewport-clamped popover at 360 px and closes on Escape', () => {
    render(<UsageMeter status={status()} />);
    fireEvent.click(screen.getByRole('button', { name: /usage left/i }));
    const dialog = screen.getByRole('dialog', { name: 'Usage left' });
    const left = parseFloat(dialog.style.left);
    const width = parseFloat(dialog.style.width);
    expect(left).toBeGreaterThanOrEqual(16);
    expect(left + width).toBeLessThanOrEqual(360 - 16);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clampPopover keeps 16 px gutters on any anchor', () => {
    expect(clampPopover({ left: 10, right: 40, bottom: 50 }, 320, 360)).toEqual({ left: 16, top: 58, width: 320 });
    expect(clampPopover({ left: 300, right: 350, bottom: 50 }, 320, 320)).toEqual({ left: 16, top: 58, width: 288 });
  });

  it('renders nothing for admins/exempt accounts or a hidden backend', () => {
    const { container, rerender } = render(<UsageMeter status={status({ governed: false })} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<UsageMeter status={status({ enabled: false })} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<UsageMeter status={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Comic Studio header slot', () => {
  const studio = (over: Record<string, unknown> = {}) => ({ doc: { spend: { totalUsd: 0.12 } }, caps: { ...DEFAULT_CAPS, byok: false }, ...over }) as never;

  it('registers one header slot between the spend chip and Read', () => {
    expect(feature.headerSlots).toEqual([{ id: 'usage', order: USAGE_SLOT_ORDER, Component: UsageSlot }]);
    expect(USAGE_SLOT_ORDER).toBeGreaterThan(210);
    expect(USAGE_SLOT_ORDER).toBeLessThan(300);
  });

  it('reads usage on mount (no timer) and shows percent left', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    await act(async () => {
      render(<UsageSlot studio={studio()} compact={false} />);
    });
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/api/usage/allowance', undefined);
    expect(screen.getByRole('button', { name: /usage left: 38%/i })).toBeInTheDocument();
  });

  it('hides when the comic renders on the user’s own key', () => {
    publishAllowanceStatus(status());
    const { container } = render(<UsageSlot studio={studio({ caps: { ...DEFAULT_CAPS, byok: true } })} compact />);
    expect(container).toBeEmptyDOMElement();
  });
});
