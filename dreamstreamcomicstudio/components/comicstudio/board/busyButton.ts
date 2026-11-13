// The busy state shared by the studio button kits (board/ui and conversation/ui). This module has no imports of
// its own (only React types), so the conversation kit can use it without pulling the board kit and its
// dependencies into every chunk that shows a chat button.
import type React from 'react';

export type BusyButtonInput = {
  busy?: boolean;
  /**
   * While `busy`, keep the button focusable instead of disabling it (6B FL-1): it reads aria-disabled, swallows
   * clicks and Enter (preventDefault, so a submit button never submits), and keeps keyboard focus, as
   * components/ds/Button's `loading` does. A disabled button drops focus to <body> in the browser, so a keyboard
   * user who pressed Enter on Approve lost their place. Opt-in: without it, busy still means disabled.
   */
  keepFocusWhileBusy?: boolean;
  disabled?: boolean;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
};

/** Busy-state handling shared by the studio button kits (board and conversation). */
export const busyButtonProps = ({
  busy,
  keepFocusWhileBusy,
  disabled,
  onClick,
  onKeyDown
}: BusyButtonInput): Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, 'disabled' | 'aria-disabled' | 'onClick' | 'onKeyDown'> => {
  if (!busy || !keepFocusWhileBusy) return { disabled: disabled || busy, onClick, onKeyDown };
  return {
    // A button that is really unavailable stays disabled; only the busy hold keeps focus.
    disabled: disabled || undefined,
    'aria-disabled': true,
    onClick: (e) => e.preventDefault(),
    onKeyDown: (e) => {
      if (e.key === 'Enter') e.preventDefault();
      onKeyDown?.(e);
    }
  };
};

/** The busy look for a button that keeps focus (aria-disabled instead of disabled). */
export const ARIA_DISABLED = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-45';
