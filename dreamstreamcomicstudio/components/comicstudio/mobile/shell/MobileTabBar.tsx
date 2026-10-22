// MobileTabBar (mobile.md §3.1): the phone portrait app navigation — Chat · Board · Read — at the
// bottom, in the thumb zone. 56 px + the bottom safe area; items ≥ 64×44 with an active pill; it
// hides while the on-screen keyboard is open (html.kb-open) so it never rides on the keyboard.
// NavigationRail renders the same items for phones in landscape.

import React from 'react';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export type StudioNavId = 'chat' | 'board' | 'read';

export interface StudioNavItem {
  id: StudioNavId;
  label: string;
  icon: React.ReactNode;
  /** Short visible badge text ("3/6"). */
  badge?: string;
  /** Spoken badge ("3 of 6 pages ready"). */
  badgeLabel?: string;
  /** A status dot: accent (new reply), amber (spend waiting), pulse (rendering). */
  dot?: 'accent' | 'amber' | 'pulse';
  disabled?: boolean;
  /** Why it is disabled (tooltip + spoken). */
  disabledReason?: string;
  current: boolean;
  onSelect: () => void;
}

const DOT_CLS: Record<NonNullable<StudioNavItem['dot']>, string> = {
  accent: 'bg-[var(--ds-accent)]',
  amber: 'bg-amber-500',
  pulse: 'bg-[var(--ds-accent)] animate-pulse motion-reduce:animate-none'
};

export const NavItemButton: React.FC<{ item: StudioNavItem; orientation: 'bar' | 'rail' }> = ({ item, orientation }) => {
  const spoken = [item.label, item.badgeLabel, item.dot === 'amber' ? 'waiting for your approval' : item.dot === 'accent' ? 'new reply' : item.dot === 'pulse' ? 'drawing' : null, item.disabled ? item.disabledReason : null]
    .filter(Boolean)
    .join(', ');
  return (
    <button
      type="button"
      onClick={item.onSelect}
      disabled={item.disabled}
      aria-current={item.current ? 'page' : undefined}
      aria-label={spoken}
      title={item.disabled ? item.disabledReason : undefined}
      data-nav={item.id}
      className={cx(
        'press group relative flex min-h-[44px] min-w-[64px] flex-col items-center justify-center gap-0.5 rounded-2xl px-2 text-[11px] font-medium leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 disabled:opacity-40',
        orientation === 'bar' ? 'flex-1' : 'w-14 py-1.5',
        item.current ? 'text-[var(--ds-ink)]' : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
      )}
    >
      <span
        aria-hidden
        className={cx(
          'relative grid h-7 w-14 place-items-center rounded-full transition-colors',
          item.current ? 'bg-[#D97757]/[0.14]' : 'group-hover:bg-[var(--ds-hover)]'
        )}
      >
        {item.icon}
        {item.dot && <span className={cx('absolute right-3 top-0.5 h-2 w-2 rounded-full ring-2 ring-[var(--ds-surface-strong)]', DOT_CLS[item.dot])} />}
      </span>
      <span aria-hidden className={cx('flex max-w-full items-center gap-1', orientation === 'rail' && '[html.kb-open_&]:hidden')}>
        <span className="truncate">{item.label}</span>
        {item.badge && <span className="rounded-full bg-[var(--ds-well-strong)] px-1 py-px text-[9.5px] font-semibold tabular-nums text-[var(--ds-muted)]">{item.badge}</span>}
      </span>
    </button>
  );
};

export const MobileTabBar: React.FC<{ items: StudioNavItem[] }> = ({ items }) => (
  <nav
    aria-label="Studio views"
    data-tabbar
    className="shrink-0 border-t border-[var(--ds-hairline-soft)] bg-[var(--ds-surface-strong)] backdrop-blur-xl [html.kb-open_&]:hidden"
    style={{ paddingBottom: 'var(--sa-bottom-eff, 0px)' }}
  >
    <div className="mx-auto flex h-[var(--tabbar-h,56px)] max-w-md items-stretch justify-around gap-1 px-2 py-1.5">
      {items.map((item) => (
        <NavItemButton key={item.id} item={item} orientation="bar" />
      ))}
    </div>
  </nav>
);

export default MobileTabBar;
