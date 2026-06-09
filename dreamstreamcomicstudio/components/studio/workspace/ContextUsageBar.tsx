// ContextUsageBar — an honest, live read on how full the coding model's context window is.
//
// Sits in the chat column header. As the project + conversation grow, the bar fills; past ~85% it
// turns amber/rose and nudges the user (start a focused new project, or split the app) before the
// model starts forgetting detail. Pure presentation — the numbers come from contextUsage.ts.

import React from 'react';
import { Gauge } from 'lucide-react';
import { useStudioTheme } from '../kit';
import { formatTokens, type ContextUsage } from './contextUsage';

const TONE: Record<ContextUsage['level'], { bar: string; text: string }> = {
  ok: { bar: 'bg-emerald-500', text: 'text-emerald-500' },
  warn: { bar: 'bg-amber-500', text: 'text-amber-500' },
  high: { bar: 'bg-rose-500', text: 'text-rose-500' },
};

export interface ContextUsageBarProps {
  usage: ContextUsage;
  className?: string;
}

export const ContextUsageBar: React.FC<ContextUsageBarProps> = ({ usage, className }) => {
  const t = useStudioTheme();
  const tone = TONE[usage.level];
  const pctLabel = `${Math.round(usage.pct * 100)}%`;
  const title =
    `Context window: ~${formatTokens(usage.tokens)} of ${formatTokens(usage.window)} tokens (${pctLabel}).` +
    (usage.level === 'high'
      ? ' Nearly full — the model may start losing detail. Consider splitting the app or starting a focused new project.'
      : usage.level === 'warn'
        ? ' Filling up — keep an eye on it as the app grows.'
        : ' Plenty of room.');

  return (
    <div className={`flex items-center gap-2 ${className ?? ''}`} title={title} aria-label={title}>
      <Gauge className={`h-3.5 w-3.5 shrink-0 ${tone.text}`} />
      <div className={`relative h-1.5 flex-1 min-w-[60px] overflow-hidden rounded-full ${t.panelAlt}`}>
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${tone.bar} transition-[width] duration-500`}
          style={{ width: `${Math.max(2, usage.pct * 100)}%` }}
        />
      </div>
      <span className={`shrink-0 text-[10px] font-semibold tabular-nums ${usage.level === 'ok' ? t.textFaint : tone.text}`}>
        {formatTokens(usage.tokens)}/{formatTokens(usage.window)}
      </span>
    </div>
  );
};
