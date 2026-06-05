import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

export interface NavDropdownItem {
  label: string;
  description?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  badge?: string;
  disabled?: boolean;
}

interface NavDropdownProps {
  label: string;
  icon?: React.ReactNode;
  items: NavDropdownItem[];
  /** Small muted intro line at the top of the menu (e.g. a coming-soon note). */
  caption?: string;
  /** Badge on the trigger itself, e.g. "Soon". */
  badge?: string;
  variant?: 'default' | 'blue' | 'muted';
}

/**
 * A header nav item that reveals a menu of specific options on hover (and on
 * tap, for touch). Each top-level product (Comic, AI Chat, Code, Models) uses
 * one so its sub-destinations are one hover away.
 */
export const NavDropdown: React.FC<NavDropdownProps> = ({
  label,
  icon,
  items,
  caption,
  badge,
  variant = 'default'
}) => {
  const [open, setOpen] = useState(false);

  const triggerColor =
    variant === 'blue' ? 'text-brand-blue' : variant === 'muted' ? 'text-slate-400' : 'text-slate-600';

  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-bold transition-colors hover:bg-white hover:text-black ${
          open ? 'bg-white text-black' : triggerColor
        }`}
      >
        {icon}
        {label}
        {badge && (
          <span className="rounded-full border border-slate-300 bg-slate-200 px-1.5 py-0.5 text-[9px] font-extrabold uppercase leading-none tracking-wider text-slate-500">
            {badge}
          </span>
        )}
        <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        // pt-3 keeps a hover "bridge" so moving cursor from trigger to menu doesn't close it.
        <div className="absolute left-1/2 top-full z-50 -translate-x-1/2 pt-3">
          <div className="w-64 rounded-xl border-2 border-black bg-white p-2 shadow-comic animate-fade-in">
            {caption && (
              <div className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">{caption}</div>
            )}
            {items.map((item, i) => (
              <button
                key={i}
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  item.onClick?.();
                  setOpen(false);
                }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
              >
                {item.icon && <span className="shrink-0 text-slate-500">{item.icon}</span>}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm font-bold text-black">
                    {item.label}
                    {item.badge && (
                      <span className="rounded-full border border-slate-300 bg-slate-100 px-1.5 py-0.5 text-[9px] font-extrabold uppercase leading-none tracking-wider text-slate-500">
                        {item.badge}
                      </span>
                    )}
                  </span>
                  {item.description && (
                    <span className="mt-0.5 block text-xs font-medium text-slate-500">{item.description}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
