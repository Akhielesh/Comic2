import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

// The comic-card shell every rich-output component sits in. Owns the house style
// (border, hard shadow, fade-in) and an optional accent strip so a single `accent`
// prop recolors the card. Header/right/footer are slots; children are the body.

interface SurfaceProps {
  /** Left-aligned header content (title, subtitle). */
  header?: React.ReactNode;
  /** Right-aligned header content (price, controls). */
  right?: React.ReactNode;
  /** Accent hex used for the top strip; omit for no strip. */
  accent?: string;
  /** Optional footer row, divided from the body. */
  footer?: React.ReactNode;
  /**
   * Render flush for use INSIDE another surface (e.g. the Finance Terminal): drops the
   * heavy border, hard shadow, outer margin and accent strip so nested cards read as
   * one cohesive panel instead of borders-within-borders.
   */
  embedded?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export const Surface: React.FC<SurfaceProps> = ({ header, right, accent, footer, embedded = false, className = '', children }) => (
  <div
    className={
      embedded
        ? `rounded-lg border border-black/10 bg-white overflow-hidden ${className}`
        : `my-2 rounded-xl border-2 border-black bg-white shadow-comic overflow-hidden animate-fade-in ${className}`
    }
  >
    {!embedded && accent && <div className="h-1" style={{ backgroundColor: accent }} />}
    {(header || right) && (
      <div className="flex items-start justify-between gap-2 p-3 pb-2">
        <div className="min-w-0">{header}</div>
        {right && <div className="shrink-0 text-right">{right}</div>}
      </div>
    )}
    {children}
    {footer && <div className="border-t-2 border-black/10 bg-slate-50 px-3 py-2">{footer}</div>}
  </div>
);

// A reusable "More / Less detail" disclosure matching the WeatherCard pattern, so
// every card expands the same way.
export const Expandable: React.FC<{ moreLabel?: string; lessLabel?: string; children: React.ReactNode }> = ({
  moreLabel = 'More detail',
  lessLabel = 'Less detail',
  children
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-center gap-1 border-t-2 border-black/10 bg-slate-50 py-1.5 text-[11px] font-bold text-slate-600 hover:bg-slate-100 transition-colors"
        aria-expanded={open}
      >
        {open ? lessLabel : moreLabel}
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="animate-fade-in border-t border-black/5">{children}</div>}
    </>
  );
};
