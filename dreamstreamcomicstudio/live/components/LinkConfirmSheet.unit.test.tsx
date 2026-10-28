// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LinkConfirmSheet } from './LinkConfirmSheet';
import type { AuthReturnConfirm } from '../account';

const link = (over: Partial<AuthReturnConfirm> = {}): AuthReturnConfirm => ({
  confirm: true,
  email: Promise.resolve(null),
  proceed: vi.fn(async () => ({ confirmed: true as const })),
  dismiss: vi.fn(),
  ...over,
});
const settle = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });

describe('LinkConfirmSheet', () => {
  it('asks before signing in, names the account once known, and wires Continue / Not now', async () => {
    const onContinue = vi.fn(async () => undefined);
    const onDecline = vi.fn();
    render(<LinkConfirmSheet link={link({ email: Promise.resolve('mallory@example.com') })} onContinue={onContinue} onDecline={onDecline} />);
    expect(screen.getByRole('dialog', { name: 'Finish signing in?' })).toBeInTheDocument();
    await settle();
    expect(screen.getByText(/This link signs this browser in to Stream Studio/)).toHaveTextContent(
      'This link signs this browser in to Stream Studio as mallory@example.com. Continue only if you asked for it.'
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onContinue).toHaveBeenCalledOnce();
    expect(onDecline).toHaveBeenCalledOnce();
  });

  it('shows at once with generic copy while the account is unknown (the lookup never holds it up)', () => {
    render(<LinkConfirmSheet link={link({ email: new Promise(() => undefined) })} onContinue={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByText(/This link signs this browser in to Stream Studio/)).toHaveTextContent(
      'This link signs this browser in to Stream Studio. Continue only if you asked for it.'
    );
  });

  it('says who is signed in and that continuing removes their Stream Studio data here', async () => {
    render(<LinkConfirmSheet link={link({ email: Promise.resolve('mallory@example.com') })} currentEmail="ada@example.com" onContinue={vi.fn()} onDecline={vi.fn()} />);
    await settle();
    expect(screen.getByText(/You’re signed in as/)).toHaveTextContent(
      'You’re signed in as ada@example.com. Continuing switches this browser to mallory@example.com, and ada@example.com’s Stream Studio data on this device (alerts, nursery setup) is removed.'
    );
  });

  it('…not when the link is for the account already signed in', async () => {
    render(<LinkConfirmSheet link={link({ email: Promise.resolve('Ada@Example.com') })} currentEmail="ada@example.com" onContinue={vi.fn()} onDecline={vi.fn()} />);
    await settle();
    expect(screen.queryByText(/You’re signed in as/)).toBeNull();
  });

  it('nobody signed in here, but another account’s Stream Studio data is on this device: says continuing removes it (never alongside a signed-in account’s own line)', () => {
    const { rerender } = render(<LinkConfirmSheet link={link()} otherAccountOnDevice onContinue={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByText(/Another account’s Stream Studio data/)).toHaveTextContent(
      'Another account’s Stream Studio data is on this browser. Continuing removes it here (that account gets its events back from its cloud copy when it signs in).'
    );
    expect(screen.queryByText(/You’re signed in as/)).toBeNull();
    rerender(<LinkConfirmSheet link={link()} onContinue={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.queryByText(/Another account’s Stream Studio data/)).toBeNull();
    rerender(<LinkConfirmSheet link={link()} otherAccountOnDevice currentEmail="ada@example.com" onContinue={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.queryByText(/Another account’s Stream Studio data/)).toBeNull();
    expect(screen.getByText(/You’re signed in as/)).toHaveTextContent('ada@example.com');
  });

  it('keyboard: focus starts on Continue, Escape is Not now', () => {
    const onDecline = vi.fn();
    render(<LinkConfirmSheet link={link()} onContinue={vi.fn()} onDecline={onDecline} />);
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDecline).toHaveBeenCalledOnce();
  });
});
