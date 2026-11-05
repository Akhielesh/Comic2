import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fetchAccountAccess, type AccountAccess } from '@/services/studioAccessApi';

const access: AccountAccess = {
  account: { id: 'u1', email: 'a@x.dev', name: 'Alice', username: 'alice_1', since: null, plan: 'pro', admin: false },
  confined: true,
  studios: [
    { id: 'comic_studio', label: 'Comic Studio', tagline: 'Write, draw and publish comics with AI', status: 'locked', detail: 'Not part of your account yet', href: '/?view=dashboard', action: { label: 'Ask an admin for access', href: 'mailto:x' } },
    { id: 'stream_studio', label: 'Stream Studio', tagline: 'Go live from your browser', status: 'open', detail: 'Unlocked', href: '/live' },
    { id: 'baby_monitor', label: 'Baby monitor & family calls', tagline: 'A private nursery camera', status: 'open', detail: '2 nurseries', href: '/live#/monitor' },
  ],
};

const listeners = vi.hoisted(() => new Set<() => void>());
vi.mock('@/services/studioAccessApi', () => ({
  fetchAccountAccess: vi.fn(async () => access),
  onAccountAccessChange: (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
}));
vi.mock('../account', () => ({ useAccount: () => ({ status: 'member', userId: 'u1' }) }));

import { StudiosCard } from './StudiosCard';

describe('StudiosCard', () => {
  it('shows each studio with what you have there, and the one step for the locked ones', async () => {
    render(<StudiosCard />);
    await waitFor(() => expect(screen.getByText('Your studios')).toBeTruthy());
    expect(screen.getByText(/pro plan/)).toBeTruthy();
    expect(screen.getByText('2 nurseries')).toBeTruthy();
    expect(screen.getAllByText('Yours')).toHaveLength(2);
    expect(screen.getByText('Locked')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask an admin for access' })).toBeTruthy();
    expect(screen.getByText('An admin set which studios this account can use.')).toBeTruthy();
  });

  it('shows each studio’s own mark (decorative: the name is beside it), the baby monitor its icon tile', async () => {
    const withChat: AccountAccess = {
      ...access,
      studios: [access.studios[0], { id: 'chat_studio', label: 'Chat Studio', tagline: 'The assistant', status: 'open', detail: 'Included', href: '/?view=chat' }, ...access.studios.slice(1)],
    };
    vi.mocked(fetchAccountAccess).mockResolvedValueOnce(withChat);
    const { container } = render(<StudiosCard />);
    await waitFor(() => expect(screen.getByText('Your studios')).toBeTruthy());
    const rows = [...container.querySelectorAll('.studio-row')];
    const glyph = (row: Element) => row.querySelector('svg.studio-mark')?.getAttribute('data-studio') ?? (row.querySelector('.studio-ic') ? 'icon' : null);
    // Comic → the Grin, Chat → the D (it lives in the DreamStream app), Stream → On air.
    expect(rows.map(glyph)).toEqual(['comic', 'dreamstream', 'stream', 'icon']);
    for (const mark of container.querySelectorAll('svg.studio-mark')) expect(mark.getAttribute('aria-hidden')).toBe('true');
    // Ink when it's yours, muted when it isn't (the badge says which in words).
    expect(rows[0].classList.contains('st-locked')).toBe(true);
    expect(rows[2].classList.contains('st-open')).toBe(true);
  });

  it('the account menu’s chips carry the marks too, at the 16 px minimum', async () => {
    const { container } = render(<StudiosCard compact />);
    await waitFor(() => expect(container.querySelector('.studio-chips')).toBeTruthy());
    const chips = [...container.querySelectorAll('.studio-chip')];
    // Open is the norm and says nothing; only the exception says so, in words (no coloured dot).
    expect(chips.map((c) => c.textContent)).toEqual(['Comic Studio Locked', 'Stream Studio', 'Baby monitor']);
    expect(chips[0].querySelector('.studio-chip-state')?.textContent).toBe('Locked');
    expect(chips[0]).toHaveAccessibleName('Comic Studio Locked');
    expect(container.querySelectorAll('.studio-chip i')).toHaveLength(0);
    expect(chips.map((c) => c.querySelector('svg.studio-chip-mark')?.getAttribute('data-studio') ?? null)).toEqual(['comic', 'stream', null]);
    expect(chips[0].getAttribute('title')).toBe('Comic Studio — Not part of your account yet');
  });

  it('re-reads after the account changes (e.g. a rename in Settings)', async () => {
    render(<StudiosCard />);
    await waitFor(() => expect(screen.getByText('Your studios')).toBeTruthy());
    const before = vi.mocked(fetchAccountAccess).mock.calls.length;
    act(() => listeners.forEach((l) => l()));
    await waitFor(() => expect(vi.mocked(fetchAccountAccess).mock.calls.length).toBe(before + 1));
    expect(screen.getByText('Your studios')).toBeTruthy();
  });
});
