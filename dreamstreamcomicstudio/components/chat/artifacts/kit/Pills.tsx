import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { BULL, BEAR, NEUTRAL } from './theme';
import { formatSigned, formatPercent } from './format';

// Small shared status atoms: a trend pill (signed change + arrow), a generic badge,
// and a selectable chip. Used across finance/news/data cards.

export const TrendPill: React.FC<{ change: number; changePercent?: number; size?: 'sm' | 'md' }> = ({
  change,
  changePercent,
  size = 'md'
}) => {
  const up = change > 0;
  const down = change < 0;
  const color = up ? BULL : down ? BEAR : NEUTRAL;
  const Icon = up ? TrendingUp : down ? TrendingDown : Minus;
  const text = size === 'sm' ? 'text-[11px]' : 'text-xs';
  const icon = size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5';
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 font-bold ${text}`}
      style={{ color, backgroundColor: `${color}1a` }}
    >
      <Icon className={icon} />
      {formatSigned(change)}
      {typeof changePercent === 'number' && <span className="opacity-80">({formatPercent(changePercent)})</span>}
    </span>
  );
};

export const Badge: React.FC<{ children: React.ReactNode; color?: string; title?: string }> = ({
  children,
  color = NEUTRAL,
  title
}) => (
  <span
    title={title}
    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
    style={{ color, backgroundColor: `${color}1a` }}
  >
    {children}
  </span>
);

export const Chip: React.FC<{
  label: string;
  active?: boolean;
  accent?: string;
  onClick?: () => void;
}> = ({ label, active = false, accent = '#3B82F6', onClick }) => (
  <button
    onClick={onClick}
    aria-pressed={active}
    className={`rounded-full border-2 px-2.5 py-0.5 text-[11px] font-bold transition-colors ${
      active ? 'border-black text-white' : 'border-black/15 text-slate-600 hover:border-black/40'
    }`}
    style={active ? { backgroundColor: accent } : undefined}
  >
    {label}
  </button>
);
