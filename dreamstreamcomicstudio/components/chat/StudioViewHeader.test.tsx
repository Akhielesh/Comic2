// P2-PLATFORM: Chat Studio's header shows the user's usage left (P1-LIMITS) — compact on
// phones, percent only, nothing for admins / exempt accounts.
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AllowanceStatus } from '../../services/usageAllowance';

const allowance = vi.hoisted(() => ({ status: null as AllowanceStatus | null }));
vi.mock('../usage/useUsageAllowance', () => ({ useUsageAllowance: () => allowance.status }));

import { StudioViewHeader } from './AIChatPlatform';

const status = (over: Partial<AllowanceStatus> = {}): AllowanceStatus => ({
  enabled: true,
  governed: true,
  pctUsed: 38,
  pctLeft: 62,
  exhausted: false,
  crossed: [30],
  resetsAt: null,
  friendlyUnits: { standardPages: 40, draftPages: 80, pctPerStandardPage: 1.46, label: 'about 40 standard comic pages left' },
  usePlatformAllowance: true,
  byokFallbackMode: 'ask',
  byokAvailable: false,
  ...over
});

describe('StudioViewHeader', () => {
  beforeEach(() => {
    allowance.status = null;
  });

  it('phone (compact): a 44 px gauge, the title truncates instead of overflowing', () => {
    allowance.status = status();
    render(<StudioViewHeader title="Home" sidebarOpen={false} onToggleSidebar={() => {}} compactMeter />);
    const meter = screen.getByRole('button', { name: /usage left: 62%/i });
    expect(meter.className).toContain('h-11');
    expect(meter.className).toContain('w-11');
    expect(meter.closest('span')?.className).toContain('ml-auto');
    expect(screen.getByText('Home').className).toContain('truncate');
    expect(screen.getByText('Home').className).toContain('min-w-0');
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });

  it('desktop: the pill reads "62% left" and opens the details', () => {
    allowance.status = status();
    render(<StudioViewHeader title="Home" sidebarOpen onToggleSidebar={() => {}} compactMeter={false} />);
    const meter = screen.getByRole('button', { name: /usage left/i });
    expect(meter.textContent).toContain('62% left');
    fireEvent.click(meter);
    expect(screen.getByRole('dialog', { name: 'Usage left' })).toBeTruthy();
  });

  it('admins / exempt accounts (not governed) and an unavailable backend: no meter', () => {
    allowance.status = status({ governed: false });
    const { rerender } = render(<StudioViewHeader title="Home" sidebarOpen={false} onToggleSidebar={() => {}} compactMeter />);
    expect(screen.queryByRole('button', { name: /usage left/i })).toBeNull();
    allowance.status = null;
    rerender(<StudioViewHeader title="Home" sidebarOpen={false} onToggleSidebar={() => {}} compactMeter={false} />);
    expect(screen.queryByRole('button', { name: /usage left/i })).toBeNull();
  });

  it('the sidebar toggle stays reachable and labelled', () => {
    const onToggle = vi.fn();
    render(<StudioViewHeader title="Home" sidebarOpen={false} onToggleSidebar={onToggle} compactMeter />);
    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
