// @vitest-environment jsdom
// The shell's navigation in both looks: the phone tab bar holds at most five places (Help & tours
// lives in the phone top bar and the account menu), the active place is marked for assistive tech,
// the phone top bar carries Help and the theme switch, and the accent picker exists only without
// the Atlas skin (hue never decorates under it). The views are stand-ins; the shell is real.
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveAccount } from './account';

const h = vi.hoisted(() => ({
  account: { status: 'member', userId: 'u1', email: 'ada@example.com', name: 'Ada Lovelace' } as LiveAccount,
  openHelp: vi.fn(),
  stub: (id: string) => () => <div data-testid={id} />,
}));

vi.mock('./account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./account')>()),
  consumeAuthReturn: vi.fn(async () => null),
  useAccount: () => h.account,
  openAuth: vi.fn(),
}));
vi.mock('./components/Guide', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./components/Guide')>()),
  openHelp: h.openHelp,
  GuideHost: () => null,
  useFirstVisitTour: () => undefined,
}));
vi.mock('./sync', () => ({ pullPrefsFromCloud: vi.fn(async () => undefined) }));
vi.mock('./components/SaveSheet', () => ({ sweepDiscardedRecordings: vi.fn(async () => undefined) }));
vi.mock('./calls/callCenter', () => ({ useCalls: () => ({ log: [], uid: null }) }));
vi.mock('./views/calls/CallHost', () => ({ CallHost: () => null }));
vi.mock('./views/monitor/InviteHost', () => ({ InviteHost: () => null }));
vi.mock('./components/AuthSheet', () => ({ AuthSheetHost: () => null }));
vi.mock('./components/StudiosCard', () => ({ StudiosCard: () => null }));
vi.mock('./monitor/push', () => ({ reconcileLegacyAlerts: vi.fn(async () => undefined) }));
vi.mock('./views/DashboardView', () => ({ DashboardView: h.stub('dashboard') }));
vi.mock('./views/CreateView', () => ({ CreateView: h.stub('create') }));
vi.mock('./views/SettingsView', () => ({ SettingsView: h.stub('settings') }));
vi.mock('./views/MonitorHome', () => ({ MonitorHome: h.stub('monitor'), NurseryHub: h.stub('nursery') }));
vi.mock('./views/CallsView', () => ({ CallsView: h.stub('calls') }));

import { LiveApp, TAB_LABELS } from './LiveApp';

const html = document.documentElement;
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const tabbar = () => document.querySelector<HTMLElement>('nav.tabbar')!;
const topbar = () => document.querySelector<HTMLElement>('header.mtop')!;

beforeEach(() => {
  localStorage.clear();
  h.openHelp.mockReset();
  history.replaceState(null, '', '/live');
  html.removeAttribute('style');
  for (const a of ['data-theme', 'data-ds-skin']) html.removeAttribute(a);
});
afterEach(() => {
  html.removeAttribute('data-ds-skin');
});

describe('the phone tab bar', () => {
  it('holds at most five places, with readable labels — Help is not one of them', async () => {
    render(<LiveApp />);
    await settle();
    const tabs = within(tabbar()).getAllByRole('button');
    expect(tabs.length).toBeLessThanOrEqual(5);
    expect(tabs.map((t) => t.textContent)).toEqual(Object.values(TAB_LABELS));
    expect(within(tabbar()).queryByText(/help/i)).toBeNull();
  });

  it('marks the current place, and moves with the route', async () => {
    render(<LiveApp />);
    await settle();
    expect(within(tabbar()).getByRole('button', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(within(tabbar()).getByRole('button', { name: 'Monitor' }));
    await settle();
    expect(within(tabbar()).getByRole('button', { name: 'Monitor' })).toHaveAttribute('aria-current', 'page');
    expect(within(tabbar()).getByRole('button', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  it('carries the welcome tour’s targets, so the tour works on phones too', async () => {
    render(<LiveApp />);
    await settle();
    for (const id of ['create', 'monitor', 'calls', 'settings']) expect(tabbar().querySelector(`[data-tour="nav-${id}"]`)).toBeTruthy();
  });
});

describe('the phone top bar', () => {
  it('opens Help & tours', async () => {
    render(<LiveApp />);
    await settle();
    fireEvent.click(within(topbar()).getByRole('button', { name: 'Help & tours' }));
    expect(h.openHelp).toHaveBeenCalledTimes(1);
    expect(topbar().querySelector('[data-tour="help"]')).toBeTruthy();
  });

  it('switches the theme (phones had no way to before)', async () => {
    render(<LiveApp />);
    await settle();
    expect(html.getAttribute('data-theme')).toBe('light');
    fireEvent.click(within(topbar()).getByRole('button', { name: 'Dark mode' }));
    await settle();
    expect(html.getAttribute('data-theme')).toBe('dark');
    expect(JSON.parse(localStorage.getItem('ds-live-appearance')!).theme).toBe('dark');
    expect(within(topbar()).getByRole('button', { name: 'Light mode' })).toBeTruthy();
  });
});

describe('the accent picker', () => {
  it('is in the rail without the Atlas skin, and colours the page as before', async () => {
    render(<LiveApp />);
    await settle();
    const picker = screen.getByRole('radiogroup', { name: 'Accent color' });
    fireEvent.click(within(picker).getByRole('radio', { name: 'Sage accent' }));
    await settle();
    expect(html.style.getPropertyValue('--accent')).toBe('#5f7d4f');
  });

  it('is gone under the Atlas skin, and nothing writes an accent — the stored one is kept', async () => {
    html.setAttribute('data-ds-skin', 'atlas');
    localStorage.setItem('ds-live-appearance', JSON.stringify({ theme: 'light', accent: 'plum', density: 'pro', corners: 'sharp', studioLayout: 'chat-right' }));
    render(<LiveApp />);
    await settle();
    expect(screen.queryByRole('radiogroup', { name: 'Accent color' })).toBeNull();
    expect(html.style.getPropertyValue('--accent')).toBe('');
    // Density and corners stay the person's choice.
    expect(html.getAttribute('data-density')).toBe('pro');
    expect(html.getAttribute('data-corners')).toBe('sharp');
    expect(JSON.parse(localStorage.getItem('ds-live-appearance')!).accent).toBe('plum');
  });
});
