// Enter on Approve keeps focus: the studio button kits gain an opt-in `keepFocusWhileBusy`. While busy such a
// button stays focusable (aria-disabled, not disabled), swallows clicks and Enter (preventDefault, so a submit
// button never submits) and keeps keyboard focus. Without the prop a busy button is disabled exactly as before.
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { GhostButton, PrimaryButton } from './ui';
import { GhostButton as ConvGhostButton, PrimaryButton as ConvPrimaryButton } from '../conversation/ui';

type Kit = React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; keepFocusWhileBusy?: boolean }>;
const KITS: Array<[string, Kit]> = [
  ['board PrimaryButton', PrimaryButton as Kit],
  ['board GhostButton', GhostButton as Kit],
  ['conversation PrimaryButton', ConvPrimaryButton as Kit],
  ['conversation GhostButton', ConvGhostButton as Kit]
];

describe.each(KITS)('%s', (_name, Btn) => {
  it('keepFocusWhileBusy + type=submit inside a form: Enter and click send nothing, focus stays, aria-disabled', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    const onClick = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <input aria-label="Note" />
        <Btn type="submit" busy keepFocusWhileBusy onClick={onClick}>
          Approve
        </Btn>
      </form>
    );
    const btn = screen.getByRole('button', { name: 'Approve' });
    btn.focus();
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('aria-busy', 'true');
    // Enter: the browser would turn it into a click; the keydown's default is prevented first.
    const enterAllowed = fireEvent.keyDown(btn, { key: 'Enter' });
    expect(enterAllowed).toBe(false);
    // A click (or the browser's implicit submission from the field) is swallowed: default prevented, no handler.
    const clickAllowed = fireEvent.click(btn);
    expect(clickAllowed).toBe(false);
    fireEvent.submit((btn as HTMLButtonElement).form!); // control: the form itself still works when submitted directly
    expect(onClick).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(btn);
  });

  it('a click on the busy submit button does not submit its form', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Btn type="submit" busy keepFocusWhileBusy>
          Send
        </Btn>
      </form>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('when not busy, keepFocusWhileBusy changes nothing: clicks run, no aria-disabled', () => {
    const onClick = vi.fn();
    render(
      <Btn keepFocusWhileBusy onClick={onClick}>
        Approve
      </Btn>
    );
    const btn = screen.getByRole('button', { name: 'Approve' });
    expect(btn).not.toHaveAttribute('aria-disabled');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a genuinely disabled button stays disabled even with the prop', () => {
    render(
      <Btn busy keepFocusWhileBusy disabled>
        Approve
      </Btn>
    );
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('without the prop a busy button behaves exactly as today (disabled)', () => {
    const onClick = vi.fn();
    render(
      <Btn busy onClick={onClick}>
        Approve
      </Btn>
    );
    const btn = screen.getByRole('button', { name: 'Approve' });
    expect(btn).toBeDisabled();
    expect(btn).not.toHaveAttribute('aria-disabled');
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});
