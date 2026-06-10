import React from 'react';
import { Gauge, AlertTriangle } from 'lucide-react';
import { HAIRLINE, MENU, MUTED } from './studioDesign';

interface ChatContextMeterProps {
  usedTokens: number;
  contextLength: number;
  features: { reasoning: boolean; vision: boolean; webSearch: boolean; longContext: boolean };
}

const fmt = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export const ChatContextMeter: React.FC<ChatContextMeterProps> = ({ usedTokens, contextLength, features }) => {
  const known = contextLength > 0;
  const pct = known ? Math.min(100, Math.round((usedTokens / contextLength) * 100)) : 0;
  const warn = known && pct >= 75;
  const critical = known && pct >= 90;

  const barColor = critical ? 'bg-red-500' : warn ? 'bg-amber-400' : 'bg-[#D97757]';

  const tooltip = [
    known
      ? `Context window: ${fmt(contextLength)} tokens. Using ~${fmt(usedTokens)} (${pct}%).`
      : `Context window unknown for this model. Using ~${fmt(usedTokens)} tokens.`,
    critical
      ? 'Nearly full — older messages may be dropped. Start a new chat or branch to keep quality high.'
      : warn
        ? 'Filling up — consider branching or starting a new chat soon.'
        : '',
    `Capabilities: ${[
      features.reasoning ? 'reasoning' : null,
      features.vision ? 'vision' : null,
      features.webSearch ? 'web' : null,
      features.longContext ? 'long-context' : null
    ].filter(Boolean).join(', ') || 'text'}.`
  ].filter(Boolean).join('\n');

  return (
    <div
      className={`group relative hidden md:flex items-center gap-1.5 text-[11px] font-semibold ${HAIRLINE} rounded-full px-2.5 py-1 cursor-default transition-all duration-200 ${
        critical ? 'bg-red-50 text-red-600' : warn ? 'bg-amber-50 text-amber-700' : `bg-white/70 ${MUTED}`
      }`}
      title={tooltip}
    >
      {critical ? <AlertTriangle className="w-3.5 h-3.5 text-red-500" /> : <Gauge className="w-3.5 h-3.5" />}
      <span className="tabular-nums">
        {known ? `${fmt(usedTokens)}/${fmt(contextLength)}` : `~${fmt(usedTokens)}`}
      </span>
      {known && (
        <span className="w-14 h-1.5 rounded-full bg-black/10 overflow-hidden">
          <span className={`block h-full ${barColor}`} style={{ width: `${pct}%` }} />
        </span>
      )}

      {/* Hover card */}
      <div className={`absolute right-0 top-9 z-30 hidden group-hover:block w-64 ${MENU} p-3 text-left font-normal normal-case`}>
        <div className="text-xs font-semibold mb-1 flex items-center gap-1 text-[#1a1915]"><Gauge className="w-3.5 h-3.5" /> Context usage</div>
        <p className={`text-[11px] ${MUTED} whitespace-pre-line`}>{tooltip}</p>
      </div>
    </div>
  );
};
