// @vitest-environment jsdom
// The tester-access redeemer on Atlas (DS-3): a labelled code field, the DS Button, the "Tester" status chip in
// words and the healthy tone, the server's answer read out politely — and no comic chrome.
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STATUS_CHIP_TONE } from './chat/studioDesign';

const invites = vi.hoisted(() => ({ redeemInvite: vi.fn(), getInviteStatus: vi.fn() }));
vi.mock('../services/invites', () => invites);

import { RedeemInvite } from './RedeemInvite';

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RedeemInvite', () => {
  it('redeems the trimmed code from a labelled field and reads the answer out', async () => {
    invites.getInviteStatus.mockResolvedValue({ isTester: false });
    invites.redeemInvite.mockResolvedValue({ ok: true, message: 'Welcome to the tester program.' });
    const { container } = render(<RedeemInvite />);
    await settle();
    expect(screen.queryByText('Tester')).toBeNull();
    fireEvent.change(screen.getByLabelText('Invite code'), { target: { value: '  ds-ab12-cd34 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Redeem' }));
    await settle();
    expect(invites.redeemInvite).toHaveBeenCalledWith('ds-ab12-cd34');
    expect(screen.getByRole('status')).toHaveTextContent('Welcome to the tester program.');
    const chip = screen.getByText('Tester');
    for (const cls of STATUS_CHIP_TONE.healthy.split(' ')) expect(chip.className.split(/\s+/)).toContain(cls);
    expect(container.innerHTML).not.toMatch(/border-black|shadow-comic|font-comic|(?<![\w-])font-display|brand-(?:yellow|blue|red)|text-green-\d/);
  });

  it('cannot redeem an empty code', async () => {
    invites.getInviteStatus.mockResolvedValue(null);
    render(<RedeemInvite />);
    await settle();
    expect(screen.getByRole('button', { name: 'Redeem' })).toBeDisabled();
  });
});
