import React, { useState } from 'react';
import { Code2, Lock } from 'lucide-react';

interface ComingSoonTabProps {
  label?: string;
  tooltip?: string;
  icon?: React.ReactNode;
}

/**
 * A header nav item for a product that isn't shippable yet. It looks like a tab
 * but doesn't navigate anywhere — hovering (or tapping, for touch) reveals a
 * little "coming soon" tooltip instead.
 */
export const ComingSoonTab: React.FC<ComingSoonTabProps> = ({
  label = 'Code',
  tooltip = 'Code Studio is coming soon',
  icon
}) => {
  const [tapped, setTapped] = useState(false);

  return (
    <div className="relative group" onMouseLeave={() => setTapped(false)}>
      <button
        type="button"
        aria-disabled="true"
        onClick={() => setTapped(true)}
        className="flex cursor-not-allowed items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-bold text-slate-400 transition-colors hover:text-slate-500"
      >
        {icon ?? <Code2 size={13} />}
        {label}
        <span className="rounded-full border border-slate-300 bg-slate-200 px-1.5 py-0.5 text-[9px] font-extrabold uppercase leading-none tracking-wider text-slate-500">
          Soon
        </span>
      </button>

      {/* Tooltip — appears on hover, focus-within, or tap */}
      <div
        role="tooltip"
        className={`pointer-events-none absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 transition-all duration-150 ${
          tapped
            ? 'translate-y-0 opacity-100'
            : '-translate-y-1 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100'
        }`}
      >
        <div className="relative flex items-center gap-1.5 whitespace-nowrap rounded-lg border-2 border-black bg-black px-3 py-2 text-xs font-bold text-white shadow-comic">
          <Lock size={11} className="text-brand-yellow" />
          {tooltip}
          <span className="absolute -top-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-l-2 border-t-2 border-black bg-black" />
        </div>
      </div>
    </div>
  );
};
