import React from 'react';

/**
 * Standardized section header for every block in the Model Library (auto-pick,
 * domain picks, top picks, provider groups, leaderboards). One geometry everywhere:
 * icon · display-font title · optional count chip — then a muted one-line subtitle,
 * with an optional right-aligned action slot. Sections may customize CONTENT, not
 * the frame, so the page reads as one system.
 */
export const SectionHeader: React.FC<{
  icon?: React.ReactNode;
  title: React.ReactNode;
  /** Small neutral count/meta chip rendered right after the title. */
  count?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Right-aligned actions (buttons, links). */
  right?: React.ReactNode;
  className?: string;
}> = ({ icon, title, count, subtitle, right, className = '' }) => (
  <div className={`flex flex-wrap items-start gap-x-3 gap-y-1 ${className}`}>
    <div className="min-w-0 flex-1">
      <div className="font-display text-lg flex items-center gap-2 leading-tight">
        {icon && <span className="shrink-0 inline-flex items-center">{icon}</span>}
        <span className="min-w-0">{title}</span>
        {count != null && (
          <span className="text-[10px] font-sans font-bold uppercase tracking-wide text-slate-500 bg-slate-100 border border-slate-300 rounded-full px-2 py-0.5">
            {count}
          </span>
        )}
      </div>
      {subtitle && <p className="text-xs text-slate-600 mt-0.5 max-w-2xl">{subtitle}</p>}
    </div>
    {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
  </div>
);
