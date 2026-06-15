import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

// A small, easily-dismissed detail window anchored near a clicked element. Reusable
// across widgets (calendar events, list rows, …): click a component → get its details
// in a frosted popover that closes on Escape, a backdrop click, or the X. On-brand
// glass (theme tokens), portal'd to <body> so it escapes overflow/stacking contexts,
// and clamped to the viewport (flips above the anchor when there's no room below).

export interface PopoverAnchor {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
}

/** Anchor helper: the bounding rect of an element as a plain PopoverAnchor. */
export const anchorFromEvent = (el: HTMLElement): PopoverAnchor => {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width };
};

interface DetailPopoverProps {
  anchor: PopoverAnchor;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Accent strip color (e.g. an event's color). */
  accent?: string;
  width?: number;
  children: React.ReactNode;
}

const GAP = 8;

export const DetailPopover: React.FC<DetailPopoverProps> = ({ anchor, onClose, title, subtitle, accent, width = 320, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'below' | 'above' } | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Measure after mount so we can flip/clamp against the real popover height.
  useLayoutEffect(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(width, vw - 2 * GAP);
    const h = ref.current?.offsetHeight ?? 240;
    const spaceBelow = vh - anchor.bottom;
    const placement: 'below' | 'above' = spaceBelow < h + GAP && anchor.top > spaceBelow ? 'above' : 'below';
    const top = placement === 'below' ? Math.min(anchor.bottom + GAP, vh - h - GAP) : Math.max(GAP, anchor.top - h - GAP);
    const left = Math.min(Math.max(GAP, anchor.left), vw - w - GAP);
    setPos({ top: Math.max(GAP, top), left, placement });
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [anchor, width]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[120]" role="dialog" aria-modal="true">
      {/* Transparent backdrop: any outside click closes. */}
      <button aria-label="Close" tabIndex={-1} onClick={onClose} className="absolute inset-0 cursor-default" />
      <div
        ref={ref}
        style={{
          top: pos?.top ?? anchor.bottom + GAP,
          left: pos?.left ?? anchor.left,
          width: Math.min(width, typeof window !== 'undefined' ? window.innerWidth - 2 * GAP : width),
          transform: shown ? 'translateY(0) scale(1)' : `translateY(${pos?.placement === 'above' ? 4 : -4}px) scale(0.98)`,
          opacity: shown ? 1 : 0
        }}
        className="absolute max-h-[70vh] overflow-hidden rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] shadow-[0_8px_40px_rgba(0,0,0,0.18)] backdrop-blur-xl transition-[opacity,transform] duration-150 ease-out"
        onClick={(e) => e.stopPropagation()}
      >
        {accent && <div className="h-1 w-full" style={{ backgroundColor: accent }} />}
        {(title || subtitle) && (
          <div className="flex items-start justify-between gap-2 border-b border-[var(--ds-hairline-soft)] px-3.5 py-2.5">
            <div className="min-w-0">
              {title && <div className="truncate text-sm font-semibold text-[var(--ds-ink)]">{title}</div>}
              {subtitle && <div className="mt-0.5 text-[11px] text-[var(--ds-muted)]">{subtitle}</div>}
            </div>
            <button
              onClick={onClose}
              aria-label="Close details"
              className="-mr-1 -mt-0.5 shrink-0 rounded-lg p-1.5 text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <div className="max-h-[calc(70vh-3rem)] overflow-y-auto px-3.5 py-3 [scrollbar-width:thin]">{children}</div>
      </div>
    </div>,
    document.body
  );
};
