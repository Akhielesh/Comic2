import { useEffect, useRef, type RefObject } from 'react';

export type DismissReason = 'escape' | 'outside' | 'focus';

/**
 * Closes an open popup the ways people expect: Escape, a press anywhere outside it, or focus moving outside
 * it (Tab past the last item, a click elsewhere). `inside` lists the elements that count as the popup (its
 * trigger and its panel). Only listens while `open`.
 */
export function useDismiss(open: boolean, onDismiss: (reason: DismissReason) => void, inside: ReadonlyArray<RefObject<HTMLElement | null>>): void {
  // The latest callback and refs, without re-subscribing on every render.
  const latest = useRef({ onDismiss, inside });
  latest.current = { onDismiss, inside };

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const within = (target: EventTarget | null): boolean =>
      target instanceof Node && latest.current.inside.some((ref) => !!ref.current && ref.current.contains(target));

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      latest.current.onDismiss('escape');
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!within(e.target)) latest.current.onDismiss('outside');
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!within(e.target)) latest.current.onDismiss('focus');
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open]);
}
