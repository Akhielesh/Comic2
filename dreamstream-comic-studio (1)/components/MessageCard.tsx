import React from 'react';
import { Sparkles, ListOrdered, AlertTriangle, ArrowRightCircle } from 'lucide-react';
import { MessageBody } from './MessageBody';

type Section = {
  label: 'Summary' | 'Steps' | 'Warnings' | 'Next' | 'Body';
  content: string;
};

const SECTION_META: Record<string, { icon: React.ReactNode; className: string }> = {
  Summary: { icon: <Sparkles className="w-3 h-3" />, className: 'bg-brand-yellow/30 border-brand-yellow' },
  Steps: { icon: <ListOrdered className="w-3 h-3" />, className: 'bg-white border-black/30' },
  Warnings: { icon: <AlertTriangle className="w-3 h-3 text-brand-red" />, className: 'bg-red-50 border-brand-red/40' },
  Next: { icon: <ArrowRightCircle className="w-3 h-3" />, className: 'bg-brand-blue/10 border-brand-blue/40' },
  Body: { icon: null, className: 'bg-white border-black/20' }
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
            className={`border rounded-lg px-2 py-2 text-[13px] leading-relaxed ${meta.className}`}
          >
            {section.label !== 'Body' && (
              <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-slate-600 mb-1">
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
