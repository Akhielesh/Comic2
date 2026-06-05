// Shared dialog a11y: while a portaled modal is open, Escape closes it (from anywhere) and
// focus is restored to the previously-focused element when it closes.

import { useEffect } from 'react';

export const useDialogA11y = (open: boolean, onClose: () => void): void => {
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      try { previouslyFocused?.focus?.(); } catch { /* element gone */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
};
