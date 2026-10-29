// MobileTabBar (mobile.md §3.1): the phone portrait app navigation — Chat · Board · Read — at the
// bottom, in the thumb zone. 56 px + the bottom safe area; items ≥ 64×44 with an active pill; it
// hides while the on-screen keyboard is open (html.kb-open) so it never rides on the keyboard.
// NavigationRail renders the same items for phones in landscape.

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { RADIUS_PILL } from '../../../chat/studioDesign';

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

/** How long the "why is this unavailable" bubble stays after a tap on a disabled item. */
export const DISABLED_HINT_MS = 2600;

/**
 * The reason a tapped, unavailable item can't open (touch has no tooltips, and a dead tap is silent):
 * a calm bubble beside the item, fixed to the viewport so the bar/rail can never clip it, and kept
 * inside 12 px gutters at every width.
 */
const DisabledHint: React.FC<{ text: string; rect: DOMRect; orientation: 'bar' | 'rail' }> = ({ text, rect, orientation }) => {
  if (typeof document === 'undefined') return null;
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  const centre = rect.left + rect.width / 2;
  const style: React.CSSProperties =
    orientation === 'bar'
      ? {
          left: 12,
          right: 12,
          bottom: Math.max(8, vh - rect.top + 8),
          justifyContent: centre > vw * 0.66 ? 'flex-end' : centre < vw * 0.33 ? 'flex-start' : 'center'
        }
      : { left: rect.right + 8, right: 12, top: Math.max(8, rect.top), justifyContent: 'flex-start' };
  return createPortal(
    <div role="status" data-nav-hint className="pointer-events-none fixed z-[70] flex" style={style}>
      <span className="max-w-[16rem] rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-3 py-2 text-[12.5px] leading-snug text-[var(--ds-ink)] shadow-[0_4px_16px_rgba(0,0,0,0.14)] backdrop-blur-md animate-fade-in">
        {text}
      </span>
    </div>,
    document.body
  );
};

/** Lower-case words, as WCAG 2.5.3 tools compare names ("6/12" → "6 12"). */
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * The item's accessible name. It starts with exactly what the item shows — the label, then the badge —
 * so a voice-control user can say what they see (WCAG 2.5.3 label in name), then adds what the badge and
 * the dot mean ("Board, 6 of 12 pages ready, drawing"). When the spoken badge already begins with the
 * visible one ("6 of 12" → "6 of 12 pages ready") it is not repeated.
 */
export const navItemName = (item: Pick<StudioNavItem, 'label' | 'badge' | 'badgeLabel' | 'dot' | 'disabled' | 'disabledReason'>): string => {
  const badgeSpoken = !!item.badge && !!item.badgeLabel && words(item.badgeLabel).startsWith(words(item.badge));
  const head = item.badge && !badgeSpoken ? `${item.label} ${item.badge}` : item.label;
  return [head, item.badgeLabel, item.dot === 'amber' ? 'waiting for your approval' : item.dot === 'accent' ? 'new reply' : item.dot === 'pulse' ? 'drawing' : null, item.disabled ? item.disabledReason : null]
    .filter(Boolean)
    .join(', ');
};

export const NavItemButton: React.FC<{ item: StudioNavItem; orientation: 'bar' | 'rail' }> = ({ item, orientation }) => {
  const [hint, setHint] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(null), DISABLED_HINT_MS);
    return () => clearTimeout(t);
  }, [hint]);
  const spoken = navItemName(item);
  return (
    <button
      type="button"
      // Unavailable items stay focusable and tappable (aria-disabled): a tap says why instead of nothing.
      onClick={(e) => {
        if (item.disabled) {
          if (item.disabledReason) setHint(e.currentTarget.getBoundingClientRect());
          return;
        }
        setHint(null);
        item.onSelect();
      }}
      aria-disabled={item.disabled || undefined}
      aria-current={item.current ? 'page' : undefined}
      aria-label={spoken}
      title={item.disabled ? item.disabledReason : undefined}
      data-nav={item.id}
      className={cx(
        'press group relative flex min-h-[44px] min-w-[64px] flex-col items-center justify-center gap-0.5 rounded-2xl px-2 text-[11px] font-medium leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45',
        orientation === 'bar' ? 'flex-1' : 'w-14 py-1.5',
        item.disabled ? 'cursor-not-allowed opacity-40' : '',
        item.current ? 'text-[var(--ds-ink)]' : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
      )}
    >
      <span
        aria-hidden
        className={cx(
          'relative grid h-7 w-14 place-items-center rounded-full transition-colors',
          item.current ? 'bg-[#D97757]/[0.14]' : !item.disabled && 'group-hover:bg-[var(--ds-hover)]'
        )}
      >
        {item.icon}
        {item.dot && <span className={cx('absolute right-3 top-0.5 h-2 w-2 rounded-full ring-2 ring-[var(--ds-surface-strong)]', DOT_CLS[item.dot])} />}
      </span>
      {/* The rail is 56 px wide: the badge goes under the label there instead of squeezing it to "B…".
          The space between label and badge keeps them two words for the accessible-name check. */}
      <span aria-hidden className={cx('flex max-w-full items-center gap-1', orientation === 'rail' && 'flex-col gap-0.5 [html.kb-open_&]:hidden')}>
        <span className="max-w-full truncate">{item.label}</span>{' '}
        {item.badge && (
          <span className={`whitespace-nowrap ${RADIUS_PILL} bg-[var(--ds-well-strong)] px-1 py-px text-[9.5px] font-semibold tabular-nums text-[var(--ds-muted)]`}>{item.badge}</span>
        )}
      </span>
      {hint && item.disabledReason && <DisabledHint text={item.disabledReason} rect={hint} orientation={orientation} />}
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
