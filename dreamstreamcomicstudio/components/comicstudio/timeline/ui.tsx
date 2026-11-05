// Small building blocks for the timeline feature: a modal dialog that is a centred card on wide
// screens and a bottom sheet on phones, lazy in-view detection (signed URLs only for visible
// tiles), a guarded localStorage flag, reduced-motion and a few shared atoms. All chrome uses the
// --ds-* tokens; no comic fonts or comic borders.

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { DIALOG_TITLE_FROM_SM, TONE_CHIP, TONE_CHIP_ON_ART } from '../../chat/studioDesign';
import { useFocusTrap } from '../board/ui';

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');
export const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45';

/** prefers-reduced-motion (live). */
export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const read = () => {
    try {
      return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  const [reduce, setReduce] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(query);
    } catch {
      return;
    }
    const on = () => setReduce(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduce;
}

/** A boolean remembered in localStorage (every access guarded: private mode, blocked storage). */
export function useStoredFlag(key: string, fallback: boolean): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
      return raw === '1' ? true : raw === '0' ? false : fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next ? '1' : '0');
      } catch {
        /* storage unavailable: the choice lasts for this visit */
      }
    },
    [key]
  );
  return [value, set];
}

/** True once the element has come near the viewport (IntersectionObserver; true where unavailable). */
export function useInView<T extends Element>(rootMargin = '200px'): [React.RefCallback<T>, boolean] {
  const [seen, setSeen] = useState(false);
  const observer = useRef<IntersectionObserver | null>(null);
  const ref = useCallback(
    (el: T | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!el || seen) return;
      if (typeof IntersectionObserver === 'undefined') {
        setSeen(true);
        return;
      }
      observer.current = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            setSeen(true);
            observer.current?.disconnect();
          }
        },
        { rootMargin }
      );
      observer.current.observe(el);
    },
    [rootMargin, seen]
  );
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, seen];
}

/**
 * Modal dialog: centred card (≥ sm), bottom sheet on phones (safe-area aware). Esc closes, focus is
 * trapped and handed back to the opener. Rendered in a portal so no scroller can clip it.
 */
export const TimelineDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  /** Accessible name when the title is not plain text. */
  label?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}> = ({ open, onClose, title, label, children, footer, wide }) => {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Only the topmost dialog closes.
      const all = document.querySelectorAll('[data-timeline-dialog]');
      if (all[all.length - 1] !== ref.current) return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      try {
        if (opener && document.contains(opener)) opener.focus();
      } catch {
        /* opener gone */
      }
    };
  }, [open]);
  // After the opener was captured above (effects run in order): trap focus inside the dialog.
  useFocusTrap(ref, open);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/35 backdrop-blur-[2px]" aria-hidden onClick={onClose} />
      <div
        ref={ref}
        data-timeline-dialog=""
        role="dialog"
        aria-modal="true"
        aria-labelledby={label ? undefined : titleId}
        aria-label={label}
        tabIndex={-1}
        className={cx(
          'relative flex max-h-[min(92dvh,900px)] w-full min-w-0 flex-col overflow-hidden rounded-t-2xl border border-[var(--ds-hairline)] bg-[var(--ds-canvas)] shadow-[0_0_48px_rgba(0,0,0,0.22)] focus:outline-none sm:rounded-2xl',
          wide ? 'sm:max-w-[min(960px,100%)]' : 'sm:max-w-[640px]'
        )}
        style={{ paddingBottom: 'var(--sa-bottom-eff, 0px)' }}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--ds-hairline-soft)] px-4 py-3">
          <h2 id={titleId} className={cx('min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-[var(--ds-ink)]', DIALOG_TITLE_FROM_SM)}>
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={cx('tap-target inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]', FOCUS_RING)}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">{children}</div>
        {footer && <div className="shrink-0 border-t border-[var(--ds-hairline-soft)] px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body
  );
};

/**
 * A tiny pill badge (status, version, price). The pill is the flex box; the text sits in its own
 * `min-w-0 truncate` span — text directly inside a flex container is an anonymous flex item, so
 * `text-overflow` never applies to it and a long badge ("4:5, not 3:2") on a narrow card would be clipped
 * mid-word with no ellipsis (layoutLint `flex-truncate`).
 */
export const Badge: React.FC<{
  children: React.ReactNode;
  tone?: 'default' | 'accent' | 'warn' | 'danger' | 'ok';
  /** Drawn over an image (a thumbnail): an opaque tone surface (TONE_CHIP_ON_ART), readable over any art. */
  onArt?: boolean;
  className?: string;
  title?: string;
}> = ({ children, tone = 'default', onArt = false, className, title }) => {
  const chip = onArt ? TONE_CHIP_ON_ART : TONE_CHIP;
  return (
    <span
      title={title}
      data-badge=""
      data-on-art={onArt ? '' : undefined}
      className={cx(
        'inline-flex min-w-0 max-w-full items-center gap-1 rounded-full px-1.5 py-px text-[10.5px] font-semibold leading-4',
        tone === 'accent' && (onArt ? 'bg-[var(--ds-raised)] text-[var(--ds-ink)]' : 'bg-[#D97757]/15 text-[var(--ds-ink)]'),
        tone === 'warn' && chip.warning,
        tone === 'danger' && chip.danger,
        tone === 'ok' && chip.success,
        tone === 'default' && (onArt ? TONE_CHIP_ON_ART.neutral : 'bg-[var(--ds-well-strong)] text-[var(--ds-muted)]'),
        className
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
};

/** A neutral tile for an image the content check blocked: never an <img>. */
export const BlockedTile: React.FC<{ className?: string; compact?: boolean }> = ({ className, compact }) => (
  <div className={cx('flex h-full w-full items-center justify-center bg-[var(--ds-well-strong)] p-2 text-center text-[var(--ds-muted)]', className)} role="img" aria-label="Hidden by the content check">
    {!compact && <span className="text-[11px] leading-snug">Hidden by the content check</span>}
  </div>
);

/** "Oct 22, 14:05" in the viewer's locale (dates are informational; never fabricated). */
export const shortDate = (at: number): string => {
  if (!at || !Number.isFinite(at)) return '—';
  try {
    return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  }
};
