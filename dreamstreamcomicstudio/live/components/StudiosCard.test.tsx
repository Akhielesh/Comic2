import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AccountAccess } from '@/services/studioAccessApi';

const access: AccountAccess = {
  account: { id: 'u1', email: 'a@x.dev', name: 'Alice', since: null, plan: 'pro', admin: false },
  confined: true,
  studios: [
    { id: 'comic_studio', label: 'Comic Studio', tagline: 'Write, draw and publish comics with AI', status: 'locked', detail: 'Not part of your account yet', href: '/?view=dashboard', action: { label: 'Ask an admin for access', href: 'mailto:x' } },
    { id: 'stream_studio', label: 'Stream Studio', tagline: 'Go live from your browser', status: 'open', detail: 'Unlocked', href: '/live' },
    { id: 'baby_monitor', label: 'Baby monitor & family calls', tagline: 'A private nursery camera', status: 'open', detail: '2 nurseries', href: '/live#/monitor' },
  ],
};

vi.mock('@/services/studioAccessApi', () => ({ fetchAccountAccess: vi.fn(async () => access) }));
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
});
