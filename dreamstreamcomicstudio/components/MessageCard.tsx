import React from 'react';
import { Sparkles, ListOrdered, AlertTriangle, ArrowRightCircle } from 'lucide-react';
import { MessageBody } from './MessageBody';
import { cn } from '../lib/utils';
import { OVERLINE, RADIUS_CONTROL, STATUS_INK, STATUS_SURFACE } from './chat/studioDesign';

type Section = {
  label: 'Summary' | 'Steps' | 'Warnings' | 'Next' | 'Body';
  content: string;
};

// Neutral surfaces with a hairline; hue only where it carries meaning (a warning, with its icon and its word).
const SECTION_META: Record<string, { icon: React.ReactNode; className: string }> = {
  Summary: { icon: <Sparkles className="w-3 h-3" aria-hidden="true" />, className: 'border-[var(--ds-hairline)] bg-[var(--ds-well-strong)]' },
  Steps: { icon: <ListOrdered className="w-3 h-3" aria-hidden="true" />, className: 'border-[var(--ds-hairline)] bg-[var(--ds-canvas)]' },
  Warnings: { icon: <AlertTriangle className={cn('w-3 h-3', STATUS_INK.attention)} aria-hidden="true" />, className: STATUS_SURFACE.attention },
  Next: { icon: <ArrowRightCircle className="w-3 h-3" aria-hidden="true" />, className: STATUS_SURFACE.active },
  Body: { icon: null, className: 'border-[var(--ds-hairline-soft)] bg-[var(--ds-canvas)]' }
};

const parseSections = (text: string): Section[] => {
  const pattern = /\*\*(Summary|Steps|Warnings|Next):\*\*/g;
  const matches: Array<{ label: Section['label']; index: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    matches.push({
      label: match[1] as Section['label'],
      index: match.index,
      end: match.index + match[0].length
    });
  }

  if (matches.length === 0) {
    return [{ label: 'Body', content: text }];
  }

  const sections: Section[] = [];
  const firstIndex = matches[0].index;
  if (firstIndex > 0) {
    sections.push({ label: 'Body', content: text.slice(0, firstIndex).trim() });
  }

  matches.forEach((entry, idx) => {
    const next = matches[idx + 1];
    const end = next ? next.index : text.length;
    const content = text.slice(entry.end, end).trim();
    if (content) {
      sections.push({ label: entry.label, content });
    }
  });

  return sections;
};

interface MessageCardProps {
  text: string;
}

export const MessageCard: React.FC<MessageCardProps> = ({ text }) => {
  const sections = parseSections(text).filter((section) => section.content);

  return (
    <div className="space-y-2">
      {sections.map((section, idx) => {
        const meta = SECTION_META[section.label] || SECTION_META.Body;
        return (
          <div
            key={`${section.label}-${idx}`}
            className={cn('border px-2 py-2 text-[13px] leading-relaxed text-[var(--ds-ink)]', RADIUS_CONTROL, meta.className)}
          >
            {section.label !== 'Body' && (
              <div className={cn('mb-1 flex items-center gap-2', OVERLINE)}>
                {meta.icon}
                <span>{section.label}</span>
              </div>
            )}
            <MessageBody text={section.content} />
          </div>
        );
      })}
    </div>
  );
};
