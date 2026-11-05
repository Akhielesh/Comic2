// NavigationRail (mobile.md §3.2): phones in landscape (height < 480) put the Chat · Board · Read
// items in a 72 px left rail — beside the keyboard, never under it — with Back at the top, so the
// 44 px header can drop its own Back. Labels collapse while the keyboard is open.

import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { NavItemButton, type StudioNavItem } from './MobileTabBar';

export const NavigationRail: React.FC<{ items: StudioNavItem[]; onBack: () => void }> = ({ items, onBack }) => (
  <nav
    aria-label="Studio views"
    data-rail
    className="flex w-[var(--rail-w,72px)] shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-[var(--ds-hairline-soft)] bg-[var(--ds-surface-strong)] py-1.5 [scrollbar-width:none]"
  >
    <button
      type="button"
      onClick={onBack}
      aria-label="Back to your projects"
      title="Back"
      className="press mb-1 grid h-11 w-11 shrink-0 place-items-center rounded-full text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
    </button>
    {items.map((item) => (
      <NavItemButton key={item.id} item={item} orientation="rail" />
    ))}
  </nav>
);

export default NavigationRail;
