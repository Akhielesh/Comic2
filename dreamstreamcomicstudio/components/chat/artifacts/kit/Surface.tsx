import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

// The macOS-glass card shell every rich-output component sits in. Owns the house
// style for widgets (hairline border, soft ambient shadow, frosted glass, rounded-2xl)
// so a single file restyles every card. An optional accent hex renders as a thin
// gradient strip so the AI can recolor a card with one prop.
//
// This is the "calm studio" widget language (see components/chat/studioDesign.ts):
// NO comic borders (`border-2 border-black`), NO hard offset shadows (`shadow-comic`),
// NO display lettering. Quiet, layered, precise.

interface SurfaceProps {
  /** Left-aligned header content (title, subtitle). */
  header?: React.ReactNode;
  /** Right-aligned header content (price, controls). */
  right?: React.ReactNode;
  /** Accent hex used for the top strip; omit for no strip. */
  accent?: string;
  /** Optional footer row, divided from the body. */
  footer?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

export const Surface: React.FC<SurfaceProps> = ({ header, right, accent, footer, className = '', children }) => (
  <div
    className={`my-2 rounded-2xl border border-black/10 bg-white/85 backdrop-blur-md shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.06)] overflow-hidden animate-fade-in ${className}`}
  >
    {accent && (
      <div
        className="h-[3px]"
        style={{ background: `linear-gradient(90deg, ${accent}, ${accent}66)` }}
      />
    )}
    {(header || right) && (
      <div className="flex items-start justify-between gap-2 p-3 pb-2">
        <div className="min-w-0">{header}</div>
        {right && <div className="shrink-0 text-right">{right}</div>}
      </div>
    )}
    {children}
    {footer && <div className="border-t border-black/5 bg-black/[0.025] px-3 py-2">{footer}</div>}
  </div>
);

// Standard widget header text: quiet semibold title + small muted subtitle, matching
// the calm-studio HEADING/MUTED tokens. Use these instead of font-display headers.
export const SurfaceTitle: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <h3 className={`text-sm font-semibold tracking-tight text-[#1a1915] truncate ${className}`}>{children}</h3>
);

export const SurfaceSubtitle: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <p className={`text-[11px] text-[#6e6a60] truncate ${className}`}>{children}</p>
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
        className="w-full flex items-center justify-center gap-1 border-t border-black/5 bg-black/[0.025] py-1.5 text-[11px] font-semibold text-[#6e6a60] hover:bg-black/5 transition-colors duration-200"
        aria-expanded={open}
      >
        {open ? lessLabel : moreLabel}
        <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="animate-fade-in border-t border-black/5">{children}</div>}
    </>
  );
};
