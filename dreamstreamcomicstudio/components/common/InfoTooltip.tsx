import React from 'react';
import { HelpCircle } from 'lucide-react';
import { GLOSSARY, type GlossaryEntry } from '../../services/modelGlossary';
import { cn } from '../../lib/utils';
import { FOCUS_RING } from '../chat/studioDesign';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ds/Tooltip';

// The glossary tooltip on the ds Tooltip (DS-1c, B-14): Radix positions it, flips it at the edge, portals it to
// <body> on the tooltip layer (Z.tooltip), opens it on keyboard focus at once and on a long press on touch, and
// points the trigger's aria-describedby at it. The bubble is the Tooltip's inverted ink, made wide enough for a
// definition. No TooltipProvider at the App root (DS-1c #6): a Tooltip outside any provider brings its own, and only
// the lazy model surfaces use this.

/** The bubble's width and alignment on top of the Tooltip panel (TOOLTIP_PANEL, INVERSE_SURFACE, Z.tooltip). */
export const INFO_TOOLTIP_BUBBLE = 'w-60 text-left';
/** The bubble's secondary line (the scale), in the page colour at 72 % (the inverse surface restates it in dark). */
export const INFO_TOOLTIP_SCALE = 'mt-1 text-[10.5px] font-medium text-[color:color-mix(in_srgb,var(--ds-canvas)_72%,transparent)]';

interface TooltipContent {
  title?: string;
  body: string;
  scale?: string;
}

/** Generic tooltip wrapper — pass explicit content and any trigger as children. */
export const InfoTooltip: React.FC<{ content: TooltipContent; children: React.ReactNode; className?: string }> = ({ content, children, className = '' }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span tabIndex={0} className={`${cn('relative inline-flex items-center rounded-[var(--ds-radius-sm,0.25rem)]', className)} ${FOCUS_RING}`}>
        {children}
      </span>
    </TooltipTrigger>
    <TooltipContent className={INFO_TOOLTIP_BUBBLE}>
      {content.title && <div className="text-xs font-semibold">{content.title}</div>}
      <div className="mt-0.5 text-[11.5px] leading-snug">{content.body}</div>
      {content.scale && <div className={INFO_TOOLTIP_SCALE}>{content.scale}</div>}
    </TooltipContent>
  </Tooltip>
);

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
