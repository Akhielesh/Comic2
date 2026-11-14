import { useCallback, useRef } from 'react';

/** Shared dialogs have several card openers, so return to the exact control that opened them. */
export function useModelDialogFocus() {
  const opener = useRef<HTMLElement | null>(null);
  const remember = useCallback((control: HTMLElement) => { opener.current = control; }, []);
  const restore = useCallback((event: Event) => {
    event.preventDefault();
    if (opener.current?.isConnected) opener.current.focus();
  }, []);
  return { remember, restore };
}
