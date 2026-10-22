// "notice" card: a short, honest status line from the studio (missing key, billing,
// a finished job). Tones are tinted, never alarming unless it really is an error.
// Long URLs and tokens wrap anywhere so they never spill across the column (visualqa P1-3).

import React from 'react';
import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react';
import type { Card } from '../../../../shared/comic/doc';
import { cx } from '../ui';

type NoticeCardData = Extract<Card, { type: 'notice' }>;

const TONES: Record<NoticeCardData['tone'], { cls: string; icon: React.ReactNode; role: 'status' | 'alert' }> = {
  info: {
    cls: 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-ink)]',
    icon: <Info className="h-4 w-4 text-[var(--ds-muted)]" aria-hidden />,
    role: 'status'
  },
  success: {
    cls: 'border-emerald-500/25 bg-emerald-500/[0.08] text-[var(--ds-ink)]',
    icon: <CircleCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-300" aria-hidden />,
    role: 'status'
  },
  warn: {
    cls: 'border-amber-500/30 bg-amber-500/[0.08] text-[var(--ds-ink)]',
    icon: <TriangleAlert className="h-4 w-4 text-amber-600 dark:text-amber-300" aria-hidden />,
    role: 'status'
  },
  error: {
    cls: 'border-red-500/30 bg-red-500/[0.07] text-[var(--ds-ink)]',
    icon: <CircleX className="h-4 w-4 text-red-600 dark:text-red-300" aria-hidden />,
    role: 'alert'
  }
};

export const NoticeCard: React.FC<{ card: NoticeCardData }> = ({ card }) => {
  const tone = TONES[card.tone] || TONES.info;
  return (
    <div role={tone.role} className={cx('flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] leading-snug', tone.cls)}>
      <span className="mt-0.5 shrink-0">{tone.icon}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{typeof card.text === 'string' ? card.text : ''}</span>
    </div>
  );
};
