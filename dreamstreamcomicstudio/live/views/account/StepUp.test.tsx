// @vitest-environment jsdom
// The step-up sheet (ADR 0006 WS-5): asked before admin actions and to finish a sign-in when
// two-step sign-in is on. `ensureStepUp` is what WS-6's screens call.
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  account: { status: 'member', email: 'ada@example.com' } as Record<string, unknown>,
  needed: false,
  stepUp: vi.fn(async (_code: string) => ({ ok: true }) as { ok: true } | { ok: false; code: string; error: string }),
  signOut: vi.fn(async () => undefined),
  secondStep: null as null | (() => void),
}));

vi.mock('../../account', () => ({
  failed: (r: { ok: boolean }) => r.ok === false,
  useAccount: () => h.account,
  stepUpNeeded: vi.fn(async () => h.needed),
  stepUp: h.stepUp,
  signOutThisDevice: h.signOut,
  registerSecondStepOpener: (fn: (() => void) | null) => {
    h.secondStep = fn;
  },
}));

import { StepUpHost, askForCode, ensureStepUp } from './StepUp';

const push = vi.fn();
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

beforeEach(() => {
  h.account = { status: 'member', email: 'ada@example.com' };
  h.needed = false;
  h.stepUp.mockReset();
  h.stepUp.mockResolvedValue({ ok: true });
  h.signOut.mockClear();
  push.mockClear();
});

describe('ensureStepUp — before an admin action', () => {
  it('goes ahead at once when no code is needed (no authenticator, or already aal2)', async () => {
    render(<StepUpHost push={push} />);
    await expect(ensureStepUp('Adding someone to the nursery')).resolves.toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks for the code, says why, and goes ahead once six digits are typed', async () => {
    h.needed = true;
    render(<StepUpHost push={push} />);
    let answer: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      answer = ensureStepUp('Adding someone to the nursery');
    });
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    expect(dialog).toHaveTextContent('Adding someone to the nursery needs the 6-digit code');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Code'), { target: { value: '123 456' } });
    });
    await flush();
    expect(h.stepUp).toHaveBeenCalledWith('123456');
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a wrong code is explained and can be retried; Cancel says no', async () => {
    h.needed = true;
    h.stepUp.mockResolvedValueOnce({ ok: false, code: 'invalid_code', error: 'That code didn’t match.' });
    render(<StepUpHost push={push} />);
    let answer: Promise<boolean> = Promise.resolve(true);
    await act(async () => {
      answer = ensureStepUp('Exporting history');
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Code'), { target: { value: '000000' } });
    });
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('That code didn’t match.');
    expect(screen.getByLabelText('Code')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(answer).resolves.toBe(false);
  });

  it('asks that arrive while the sheet is open share its one answer', async () => {
    h.needed = true;
    render(<StepUpHost push={push} />);
    let a: Promise<boolean> = Promise.resolve(false);
    let b: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      a = ensureStepUp('Creating a share link');
      b = ensureStepUp('Adding someone');
    });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Code'), { target: { value: '654321' } });
    });
    await flush();
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
    expect(h.stepUp).toHaveBeenCalledTimes(1);
  });

  it('with no sheet mounted it never pretends: the action does not go ahead', async () => {
    await expect(askForCode('Anything')).resolves.toBe(false);
  });
});

describe('finishing a sign-in', () => {
  it('opens by itself when the password was given and the code is still owed', async () => {
    h.account = { status: 'needs_mfa', email: 'ada@example.com' };
    render(<StepUpHost push={push} />);
    const dialog = await screen.findByRole('dialog', { name: 'Two-step sign-in' });
    expect(dialog).toHaveTextContent('finish signing in as ada@example.com');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('"Sign out instead" signs this device out', async () => {
    h.account = { status: 'needs_mfa', email: 'ada@example.com' };
    render(<StepUpHost push={push} />);
    await screen.findByRole('dialog', { name: 'Two-step sign-in' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out instead' }));
    });
    expect(h.signOut).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith('Signed out on this device', { icon: 'check' });
  });

  it('every "Sign in" button reopens it (the account module routes there)', async () => {
    h.account = { status: 'needs_mfa', email: 'ada@example.com' };
    render(<StepUpHost push={push} />);
    await screen.findByRole('dialog');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => h.secondStep?.());
    expect(screen.getByRole('dialog', { name: 'Two-step sign-in' })).toBeInTheDocument();
  });

  it('explains what to do after losing the phone, honestly', async () => {
    h.account = { status: 'needs_mfa' };
    render(<StepUpHost push={push} />);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Lost your phone?' }));
    expect(screen.getByText(/setup key you saved/)).toBeInTheDocument();
    expect(screen.getByText(/A new password alone won’t switch two-step sign-in off/)).toBeInTheDocument();
  });
});
