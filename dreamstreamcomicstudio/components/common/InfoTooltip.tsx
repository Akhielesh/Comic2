import React, { useState, useId, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';
import { GLOSSARY, type GlossaryEntry } from '../../services/modelGlossary';
import { cn } from '../../lib/utils';
import { FOCUS_RING, Z } from '../chat/studioDesign';

// Hover/focus tooltip rendered through a PORTAL with fixed positioning. The previous version was
// absolutely positioned inside its parent, so inside scroll/overflow containers (the detail &
// compare modals) the bubble got clipped or painted under sibling content. Portalling to <body>
// with a computed fixed position on the tooltip layer (Z.tooltip, the top of the ladder) fixes the
// clipping and the "overshadowing". The bubble is Atlas's tooltip: inverted ink (the ink as the
// fill, the page colour as the words), the control radius, the overlay shadow.
// (DS-1c's Tooltip primitive takes this over: a wave note, so the glossary keeps working meanwhile.)

/** The bubble: Atlas's inverted-ink tooltip on the tooltip layer. */
export const INFO_TOOLTIP_BUBBLE = 'pointer-events-none w-60 rounded-[var(--ds-radius-control,0.75rem)] bg-[var(--ds-ink)] px-3 py-2 text-left text-[var(--ds-canvas)] shadow-[shadow:var(--ds-shadow-overlay)]';
/** The bubble's secondary line (the scale), in the page colour at 72 %. */
export const INFO_TOOLTIP_SCALE = 'mt-1 text-[10.5px] font-medium text-[color:color-mix(in_srgb,var(--ds-canvas)_72%,transparent)]';

interface TooltipContent {
  title?: string;
  body: string;
  scale?: string;
}

interface BubblePos { top: number; left: number; placement: 'top' | 'bottom'; }

const Bubble: React.FC<{ content: TooltipContent; id: string; pos: BubblePos }> = ({ content, id, pos }) => (
  <div
    role="tooltip"
    id={id}
    style={{
      position: 'fixed',
      top: pos.top,
      left: pos.left,
      transform: pos.placement === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)'
    }}
    className={cn(INFO_TOOLTIP_BUBBLE, Z.tooltip)}
  >
    {content.title && <div className="text-xs font-semibold">{content.title}</div>}
    <div className="mt-0.5 text-[11.5px] leading-snug">{content.body}</div>
    {content.scale && <div className={INFO_TOOLTIP_SCALE}>{content.scale}</div>}
  </div>
);

/** Generic tooltip wrapper — pass explicit content and any trigger as children. */
export const InfoTooltip: React.FC<{ content: TooltipContent; children: React.ReactNode; className?: string }> = ({ content, children, className = '' }) => {
  const [pos, setPos] = useState<BubblePos | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();

  const open = useCallback(() => {
    const el = ref.current;
    if (!el || typeof window === 'undefined') return;
    const r = el.getBoundingClientRect();
    const placeBelow = r.top < 150; // not enough headroom → flip under the trigger
    const left = Math.min(Math.max(r.left + r.width / 2, 128), window.innerWidth - 128);
    setPos({ top: placeBelow ? r.bottom + 8 : r.top - 8, left, placement: placeBelow ? 'bottom' : 'top' });
  }, []);
  const close = useCallback(() => setPos(null), []);

  return (
    <span
      ref={ref}
      className={`${cn('relative inline-flex items-center rounded-[var(--ds-radius-sm,0.25rem)]', className)} ${FOCUS_RING}`}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
      tabIndex={0}
      aria-describedby={pos ? id : undefined}
    >
      {children}
      {pos && typeof document !== 'undefined' && createPortal(<Bubble content={content} id={id} pos={pos} />, document.body)}
    </span>
  );
};

/** A small "?" help dot that explains a label. Pass a glossary key OR explicit content. */
export const InfoDot: React.FC<{ term?: keyof typeof GLOSSARY; content?: TooltipContent; className?: string }> = ({ term, content, className = '' }) => {
  const resolved: TooltipContent | undefined = content || (term ? entryToContent(GLOSSARY[term]) : undefined);
  if (!resolved) return null;
  return (
    <InfoTooltip content={resolved} className={className}>
      <HelpCircle className="h-3 w-3 cursor-help text-[var(--ds-muted)] hover:text-[var(--ds-ink)]" aria-label={resolved.title || 'More info'} />
    </InfoTooltip>
  );
};

/** Wrap a term in a dotted underline that reveals its glossary definition on hover/focus. */
export const GlossaryTerm: React.FC<{ term: keyof typeof GLOSSARY; children?: React.ReactNode; className?: string }> = ({ term, children, className = '' }) => {
  const entry = GLOSSARY[term];
  if (!entry) return <>{children}</>;
  return (
    <InfoTooltip content={entryToContent(entry)} className={className}>
      <span className="cursor-help border-b border-dotted border-[var(--ds-control-border)]">{children ?? entry.title}</span>
    </InfoTooltip>
  );
};

const entryToContent = (e?: GlossaryEntry): TooltipContent | undefined =>
  e ? { title: e.title, body: e.body, scale: e.scale } : undefined;
