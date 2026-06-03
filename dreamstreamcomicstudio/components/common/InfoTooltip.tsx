import React, { useState, useId } from 'react';
import { HelpCircle } from 'lucide-react';
import { GLOSSARY, type GlossaryEntry } from '../../services/modelGlossary';

// Lightweight hover/focus tooltip — the app previously relied only on native `title` attributes,
// which can't be styled, can't hold rich content, and don't help keyboard/touch users. This one
// is accessible (focusable, aria-describedby), positions itself above the trigger, and renders a
// title + body + optional scale footnote. Used across the Model Library to demystify jargon.

interface TooltipContent {
  title?: string;
  body: string;
  scale?: string;
}

const Bubble: React.FC<{ content: TooltipContent; id: string }> = ({ content, id }) => (
  <div
    role="tooltip"
    id={id}
    className="pointer-events-none absolute bottom-full left-1/2 z-[80] mb-2 w-60 -translate-x-1/2 rounded-lg border-2 border-black bg-white p-2.5 text-left shadow-comic"
  >
    {content.title && <div className="text-[11px] font-bold text-black">{content.title}</div>}
    <div className="mt-0.5 text-[11px] leading-snug text-slate-700">{content.body}</div>
    {content.scale && <div className="mt-1 text-[10px] font-bold uppercase text-slate-400">{content.scale}</div>}
    <span className="absolute left-1/2 top-full -mt-px h-2 w-2 -translate-x-1/2 rotate-45 border-b-2 border-r-2 border-black bg-white" />
  </div>
);

/** Generic tooltip wrapper — pass explicit content and any trigger as children. */
export const InfoTooltip: React.FC<{ content: TooltipContent; children: React.ReactNode; className?: string }> = ({ content, children, className = '' }) => {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      tabIndex={0}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open && <Bubble content={content} id={id} />}
    </span>
  );
};

/** A small "?" help dot that explains a label. Pass a glossary key OR explicit content. */
export const InfoDot: React.FC<{ term?: keyof typeof GLOSSARY; content?: TooltipContent; className?: string }> = ({ term, content, className = '' }) => {
  const resolved: TooltipContent | undefined = content || (term ? entryToContent(GLOSSARY[term]) : undefined);
  if (!resolved) return null;
  return (
    <InfoTooltip content={resolved} className={className}>
      <HelpCircle className="h-3 w-3 cursor-help text-slate-400 hover:text-slate-700" aria-label={resolved.title || 'More info'} />
    </InfoTooltip>
  );
};

/** Wrap a term in a dotted underline that reveals its glossary definition on hover/focus. */
export const GlossaryTerm: React.FC<{ term: keyof typeof GLOSSARY; children?: React.ReactNode; className?: string }> = ({ term, children, className = '' }) => {
  const entry = GLOSSARY[term];
  if (!entry) return <>{children}</>;
  return (
    <InfoTooltip content={entryToContent(entry)} className={className}>
      <span className="cursor-help border-b border-dotted border-slate-400">{children ?? entry.title}</span>
    </InfoTooltip>
  );
};

const entryToContent = (e?: GlossaryEntry): TooltipContent | undefined =>
  e ? { title: e.title, body: e.body, scale: e.scale } : undefined;
