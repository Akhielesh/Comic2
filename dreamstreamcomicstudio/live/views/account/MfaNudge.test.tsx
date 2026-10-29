// @vitest-environment jsdom
// The two-step sign-in nudge after creating a nursery (ADR 0006 WS-5).
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  account: { status: 'member', userId: 'u1', mfa: false } as Record<string, unknown>,
  nurseries: [] as { my_role: string }[],
  list: vi.fn(),
}));
vi.mock('../../account', () => ({ useAccount: () => h.account }));
vi.mock('../../monitor/client', () => ({ listNurseries: h.list }));

import { MfaNudge, NUDGE_KEY, resetMfaNudge } from './MfaNudge';

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

beforeEach(() => {
  localStorage.clear();
  resetMfaNudge();
  h.account = { status: 'member', userId: 'u1', mfa: false };
  h.nurseries = [{ my_role: 'parent' }];
  h.list.mockReset();
  h.list.mockImplementation(async () => ({ ok: true, nurseries: h.nurseries }));
});

describe('MfaNudge', () => {
  it('asks a parent without two-step sign-in, and "Set it up" goes to Security', async () => {
    const onSetUp = vi.fn();
    render(<MfaNudge onSetUp={onSetUp} />);
    await flush();
    expect(screen.getByText('Protect your nursery')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set it up' }));
    expect(onSetUp).toHaveBeenCalledOnce();
    expect(screen.queryByText('Protect your nursery')).toBeNull();
  });

  it('"Not now" holds it back for 30 days', async () => {
    const { unmount } = render(<MfaNudge onSetUp={vi.fn()} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(Number(localStorage.getItem(NUDGE_KEY))).toBeGreaterThan(0);
    unmount();
    render(<MfaNudge onSetUp={vi.fn()} />);
    await flush();
    expect(screen.queryByText('Protect your nursery')).toBeNull();
  });

  it('stays away from people who already have it, viewers and caregivers, and the signed out', async () => {
    h.account = { status: 'member', userId: 'u1', mfa: true };
    const a = render(<MfaNudge onSetUp={vi.fn()} />);
    await flush();
    expect(screen.queryByText('Protect your nursery')).toBeNull();
    a.unmount();

    h.account = { status: 'member', userId: 'u1', mfa: false };
    h.nurseries = [{ my_role: 'viewer' }, { my_role: 'caregiver' }];
    const b = render(<MfaNudge onSetUp={vi.fn()} />);
    await flush();
    expect(screen.queryByText('Protect your nursery')).toBeNull();
    b.unmount();

    h.account = { status: 'signed_out' };
    render(<MfaNudge onSetUp={vi.fn()} />);
    await flush();
    expect(screen.queryByText('Protect your nursery')).toBeNull();
  });

  it('a nursery created after a "no" counts at once (the no is asked again)', async () => {
    h.nurseries = [];
    const a = render(<MfaNudge onSetUp={vi.fn()} />);
    await flush();
    expect(screen.queryByText('Protect your nursery')).toBeNull();
    a.unmount();
    h.nurseries = [{ my_role: 'parent' }];
    render(<MfaNudge onSetUp={vi.fn()} />);
    await flush();
    expect(screen.getByText('Protect your nursery')).toBeInTheDocument();
  });
});
