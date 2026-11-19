import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../../../lib/utils';
import { FOCUS_RING, SECTION_CARD } from '../../studioDesign';

// The card shell every rich-output component sits in, built from the Atlas section-card
// recipe (SECTION_CARD: an opaque --ds-surface, a hairline, the soft shadow and the panel
// radius, no blur), so a single file restyles every card and every card matches the
// sibling DS cards around it.
//
// NO comic borders (`border-2 border-black`), NO hard offset shadows (`shadow-comic`),
// NO display lettering, NO spelled radius, shadow or hue.

interface SurfaceProps {
  /** Left-aligned header content (title, subtitle). */
  header?: React.ReactNode;
  /** Right-aligned header content (price, controls). */
  right?: React.ReactNode;
  /**
   * Kept for callers and model data that still pass a colour. The card no longer draws a
   * coloured strip: identity comes from the content (a chart's series, a status chip),
   * never from the card edge.
   */
  accent?: string;
  /** Optional footer row, divided from the body. */
  footer?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

export const Surface: React.FC<SurfaceProps> = ({ header, right, footer, className = '', children }) => (
  <div className={cn('my-2 animate-fade-in', SECTION_CARD, className)}>
    {(header || right) && (
      <div className="flex items-start justify-between gap-2 p-3 pb-2">
        <div className="min-w-0">{header}</div>
        {right && <div className="shrink-0 text-right">{right}</div>}
      </div>
    )}
    {children}
    {footer && <div className="border-t border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-3 py-2">{footer}</div>}
  </div>
);

// Standard widget header text: quiet semibold title + small muted subtitle, matching
// the calm-studio HEADING/MUTED tokens. Use these instead of font-display headers.
export const SurfaceTitle: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <h3 className={`text-sm font-semibold tracking-tight text-[var(--ds-ink)] truncate ${className}`}>{children}</h3>
);

export const SurfaceSubtitle: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <p className={`text-[11px] text-[var(--ds-muted)] truncate ${className}`}>{children}</p>
);

// A reusable "More / Less detail" disclosure so every card expands the same way.
export const Expandable: React.FC<{
  moreLabel?: string;
  lessLabel?: string;
  /** Render expanded on first paint (used by the detailed density mode). */
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ moreLabel = 'More detail', lessLabel = 'Less detail', defaultOpen = false, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn('w-full flex items-center justify-center gap-1 border-t border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] py-1.5 text-[11px] font-semibold text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] transition-colors duration-[var(--ds-motion-medium)] coarse:min-h-[44px]', FOCUS_RING)}
        aria-expanded={open}
      >
        {open ? lessLabel : moreLabel}
        <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-[var(--ds-motion-medium)] motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && <div className="animate-fade-in border-t border-[var(--ds-hairline-soft)]">{children}</div>}
    </>
  );
};
