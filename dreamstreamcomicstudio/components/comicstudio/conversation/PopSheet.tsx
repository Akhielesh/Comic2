// Anchored glass sheet (composer option panels, header popovers) and the right-side
// slide-over (Settings). Both are focus-trapped, close on Esc (topmost first) and on a
// click outside, and hand focus back to whatever opened them.

import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { HAIRLINE, SHADOW_SOFT, TRANSITION } from '../../chat/studioDesign';
import { cx } from './ui';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Open sheets, innermost last — Esc closes only the top one.
const openStack: string[] = [];

const focusables = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('data-focus-skip'));

/** Shared behaviour: stack-aware Esc, outside click, focus trap + restore. */
const useSheetBehaviour = (
  open: boolean,
  onClose: () => void,
  sheetRef: React.RefObject<HTMLElement | null>,
  anchorRef?: React.RefObject<HTMLElement | null>,
  closeOnOutside = true
) => {
  const id = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    openStack.push(id);

    // Focus the selected/first control once mounted.
    const raf = requestAnimationFrame(() => {
      const root = sheetRef.current;
      if (!root || root.contains(document.activeElement)) return;
      const preferred = root.querySelector<HTMLElement>('[data-autofocus],[aria-checked="true"],[aria-pressed="true"]');
      (preferred && !preferred.hasAttribute('disabled') ? preferred : focusables(root)[0] || root).focus();
    });

    const onKey = (e: KeyboardEvent) => {
      if (openStack[openStack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = sheetRef.current;
      if (!root) return;
      const items = focusables(root);
      if (!items.length) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    const onPointer = (e: PointerEvent) => {
      if (!closeOnOutside || openStack[openStack.length - 1] !== id) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (sheetRef.current?.contains(target) || anchorRef?.current?.contains(target)) return;
      onCloseRef.current();
    };

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      const idx = openStack.lastIndexOf(id);
      if (idx !== -1) openStack.splice(idx, 1);
      // Hand focus back to the opener unless the user already moved it elsewhere.
      const active = document.activeElement;
      if (!active || active === document.body || sheetRef.current?.contains(active)) {
        try {
          previouslyFocused?.focus?.();
        } catch {
          /* element gone */
        }
      }
    };
  }, [open, id, sheetRef, anchorRef, closeOnOutside]);
};

export interface PopSheetProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the sheet. */
  label: string;
  /** Element that toggles the sheet (clicks on it are not "outside"). */
  anchorRef?: React.RefObject<HTMLElement | null>;
  placement?: 'above' | 'below';
  align?: 'start' | 'end' | 'stretch';
  className?: string;
  children: React.ReactNode;
}

/** A glass sheet that pops above (or below) its positioned parent. */
export const PopSheet: React.FC<PopSheetProps> = ({
  open,
  onClose,
  label,
  anchorRef,
  placement = 'above',
  align = 'stretch',
  className,
  children
}) => {
  const ref = useRef<HTMLDivElement>(null);
  useSheetBehaviour(open, onClose, ref, anchorRef);
  if (!open) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className={cx(
        `absolute z-40 max-h-[min(70vh,560px)] overflow-y-auto overscroll-contain rounded-2xl ${HAIRLINE} ${SHADOW_SOFT} bg-[var(--ds-surface-strong)] backdrop-blur-xl animate-scale-in focus:outline-none`,
        placement === 'above' ? 'bottom-full mb-2' : 'top-full mt-2',
        align === 'stretch' ? 'left-0 right-0' : align === 'start' ? 'left-0' : 'right-0',
        className
      )}
    >
      {children}
    </div>
  );
};

export interface SlideOverProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

/** Right-side sheet over a dimmed backdrop (Settings). */
export const SlideOver: React.FC<SlideOverProps> = ({ open, onClose, title, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useSheetBehaviour(open, onClose, ref, undefined, false);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px] animate-fade-in" aria-hidden onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative flex h-full w-full max-w-[420px] flex-col ${HAIRLINE} border-y-0 border-r-0 bg-[var(--ds-canvas)] shadow-[0_0_48px_rgba(0,0,0,0.18)] studio-reveal focus:outline-none`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-[var(--ds-hairline-soft)] px-5 py-4">
          <h2 id={titleId} className="text-[15px] font-semibold tracking-tight text-[var(--ds-ink)]">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`rounded-lg p-1.5 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] ${TRANSITION}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
      </div>
    </div>
  );
};
