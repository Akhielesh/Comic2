// Dialog behaviour for the Model Library's two modals (model detail, compare):
//  - Escape closes it, from anywhere on the page;
//  - focus moves into the dialog when it opens (the panel itself, so its label is announced);
//  - Tab / Shift+Tab wrap inside it;
//  - focus returns to the element that opened it when it closes (without scrolling the page).
//    Pass `openerRef` with the button that opened it: Safari and Firefox on macOS do not focus a
//    button on click, so `document.activeElement` at open time is often <body>. Without a ref the
//    focused element at open time is used.
//
// The repo already has these pieces: components/studio/kit/useDialogA11y.ts (Escape + restore) and
// useFocusTrap in components/comicstudio/board/ui.tsx (Tab wrap). The trap is mirrored here rather than
// imported, because board/ui.tsx imports the comic engine (shared/comic/*), which would land in the
// Models route chunk. If the trap moves to a standalone file, import it from there instead.

import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const useModalA11y = (
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  openerRef?: React.RefObject<HTMLElement | null>
): void => {
  // Read the latest onClose at key time, so the listener can stay registered for the dialog's lifetime.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const root = ref.current;
    if (!root || typeof document === 'undefined') return;
    // Runs right after the dialog mounts, before anything inside it takes focus: this is the opener,
    // unless the caller recorded the button that was clicked.
    const focused = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    const opener = openerRef?.current ?? focused;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true'
      );
      if (!items.length) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || active === root || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    if (!root.contains(document.activeElement)) root.focus({ preventScroll: true });

    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener?.isConnected) {
        try {
          opener.focus({ preventScroll: true });
        } catch {
          /* the opener can no longer take focus */
        }
      }
    };
  }, [ref, openerRef]);
};
