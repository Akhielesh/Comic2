/**
 * TabBar — the phone's bottom navigation (redesign plan §2 "Phone nav outside the studio", §4, §11.3 M1c):
 * generic over its ids (`Id extends string`), so the Library, Discover and the studio each pass their own
 * places. It is not a wrapper over the studio's MobileTabBar (typed 'chat' | 'board' | 'read'), which stays
 * as it is until the studio's v2 shell flips; the two share the naming rule (`navItemName`).
 *
 * Each item is `flex-1 min-w-0` (five fit a 320 px phone) and at least 44 px tall, with an icon pill, its
 * label, an optional badge ("3/6"), and a dot (a new reply, something waiting for approval, or live drawing,
 * which is the one sanctioned LiveDot). An unavailable item stays focusable and tappable (aria-disabled): a
 * tap shows WHY in a calm bubble for TAB_HINT_MS, since touch has no tooltips and a dead tap is silent.
 *
 * The bar is the chrome token tall (`--tabbar-h`) plus the bottom safe area, capped at 560 px and centred
 * from 600 px, and it hides while the on-screen keyboard is open (html.kb-open). NavRail renders the same
 * items for phones in landscape.
 */
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';
import { LiveDot } from './LiveDot';
import { PRESS } from '../chat/studioDesign';
import { DENSITY, FOCUS_RING_FLUSH, RADIUS_PILL, RISE_IN, SHADOW_SOFT, STATUS_DOT, Z } from './recipes';

/** A status dot on an item: `accent` a new reply, `amber` waiting for the person's approval, `pulse` drawing now. */
export type TabDot = 'accent' | 'amber' | 'pulse';

export interface TabBarItem<Id extends string = string> {
  id: Id;
  label: string;
  /** A lucide icon (decoration: the label names the item). */
  icon: React.ReactNode;
  /** Short visible badge text ("3/6"). */
  badge?: string;
  /** The badge in words ("3 of 6 pages ready"). */
  badgeLabel?: string;
  dot?: TabDot;
  disabled?: boolean;
  /** Why it is unavailable: the tooltip, the spoken name and the bubble a tap shows. */
  disabledReason?: string;
  current: boolean;
  onSelect: () => void;
}

/** How long the "why is this unavailable" bubble stays after a tap on a disabled item. */
export const TAB_HINT_MS = 2600;

/** Lower-case words, as WCAG 2.5.3 tools compare names ("6/12" → "6 12"). */
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * The item's accessible name (the studio MobileTabBar's rule, so both navigations speak alike). It starts
 * with exactly what the item shows — the label, then the badge — so a voice-control user can say what they
 * see (WCAG 2.5.3 label in name), then adds what the badge and the dot mean ("Board, 6 of 12 pages ready,
 * drawing"). When the spoken badge already begins with the visible one it is not repeated.
 */
export const navItemName = (item: Pick<TabBarItem, 'label' | 'badge' | 'badgeLabel' | 'dot' | 'disabled' | 'disabledReason'>): string => {
  const badgeSpoken = !!item.badge && !!item.badgeLabel && words(item.badgeLabel).startsWith(words(item.badge));
  const head = item.badge && !badgeSpoken ? `${item.label} ${item.badge}` : item.label;
  return [head, item.badgeLabel, item.dot === 'amber' ? 'waiting for your approval' : item.dot === 'accent' ? 'new reply' : item.dot === 'pulse' ? 'drawing' : null, item.disabled ? item.disabledReason : null]
    .filter(Boolean)
    .join(', ');
};

/** Colour changes on the nav, on the motion tokens (each read keeps its fallback). */
export const NAV_MOTION = 'transition-colors duration-[var(--ds-motion-fast,120ms)] ease-[var(--ds-ease,cubic-bezier(0.4,0,0.2,1))] motion-reduce:transition-none';

/** One nav item: a 44 px column of icon pill, label and badge. Add the orientation and the state. */
export const TAB_ITEM = `group relative flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-[var(--ds-radius-control,0.75rem)] px-1 text-[11px] font-medium leading-none ${DENSITY.touch} ${PRESS} ${NAV_MOTION}`;
export const TAB_ITEM_ORIENTATION = {
  bar: 'flex-1',
  rail: 'w-14 py-1.5'
} as const;
export const TAB_ITEM_CURRENT = 'text-[var(--ds-ink)]';
export const TAB_ITEM_IDLE = 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]';
export const TAB_ITEM_DISABLED = 'cursor-not-allowed opacity-50';

/** The pill behind the icon: the soft accent when current, the hover step otherwise. */
export const TAB_PILL = `relative grid h-7 w-12 place-items-center rounded-full ${NAV_MOTION} [&_svg]:size-[18px]`;
export const TAB_PILL_CURRENT = 'bg-[var(--ds-accent-soft)]';
export const TAB_PILL_IDLE = 'group-hover:bg-[var(--ds-hover)]';

export const TAB_BADGE = `whitespace-nowrap ${RADIUS_PILL} bg-[var(--ds-well-strong)] px-1 py-px text-[9.5px] font-semibold tabular-nums text-[var(--ds-muted)]`;

/** The dot on the pill's corner (the pulse dot holds a LiveDot, drawn in the accent ink through currentColor). */
export const TAB_DOT_PLACE = 'absolute right-2 top-0.5 size-2 rounded-full ring-2 ring-[var(--ds-surface-strong)]';
export const TAB_DOT: Record<TabDot, string> = {
  accent: 'bg-[var(--ds-accent)]',
  amber: STATUS_DOT.attention,
  pulse: 'text-[var(--ds-accent)]'
};

/** The "why is this unavailable" bubble (role="status": it says itself once). */
export const TAB_HINT = `max-w-[16rem] rounded-[var(--ds-radius-panel,1rem)] border border-[var(--ds-overlay-edge)] bg-[var(--ds-raised)] px-3 py-2 text-[12.5px] leading-snug text-[var(--ds-ink)] ${SHADOW_SOFT}`;

/** The bar itself: the tab-bar token tall plus the bottom safe area; hidden while the keyboard is up. */
export const TAB_BAR = `shrink-0 border-t border-[var(--ds-hairline-soft)] bg-[var(--ds-surface-strong)] pb-[var(--sa-bottom-eff,0px)] [html.kb-open_&]:hidden`;
export const TAB_BAR_ROW = 'mx-auto flex h-[var(--tabbar-h,56px)] w-full max-w-[560px] items-stretch gap-1 px-2 py-1';

/**
 * The reason a tapped, unavailable item can't open: beside the item, fixed to the viewport so the bar or the
 * rail never clips it, and kept inside 12 px gutters at every width.
 */
function DisabledHint({ text, rect, orientation }: { text: string; rect: DOMRect; orientation: 'bar' | 'rail' }) {
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
    <div role="status" data-nav-hint="" className={cn('pointer-events-none fixed flex', Z.tooltip)} style={style}>
      <span className={cn(TAB_HINT, RISE_IN)}>{text}</span>
    </div>,
    document.body
  );
}

export interface TabItemButtonProps<Id extends string> {
  item: TabBarItem<Id>;
  orientation: 'bar' | 'rail';
}

/** One item of TabBar or NavRail. */
export function TabItemButton<Id extends string>({ item, orientation }: TabItemButtonProps<Id>) {
  const [hint, setHint] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!hint) return undefined;
    const t = window.setTimeout(() => setHint(null), TAB_HINT_MS);
    return () => window.clearTimeout(t);
  }, [hint]);
  return (
    <button
      type="button"
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
      aria-label={navItemName(item)}
      title={item.disabled ? item.disabledReason : undefined}
      data-nav={item.id}
      className={`${cn(TAB_ITEM, TAB_ITEM_ORIENTATION[orientation], item.current ? TAB_ITEM_CURRENT : TAB_ITEM_IDLE, item.disabled && TAB_ITEM_DISABLED)} ${FOCUS_RING_FLUSH}`}
    >
      <span aria-hidden="true" data-slot="nav-pill" className={cn(TAB_PILL, item.current ? TAB_PILL_CURRENT : !item.disabled && TAB_PILL_IDLE)}>
        {item.icon}
        {item.dot ? (
          <span data-dot={item.dot} className={cn(TAB_DOT_PLACE, TAB_DOT[item.dot])}>
            {item.dot === 'pulse' ? <LiveDot /> : null}
          </span>
        ) : null}
      </span>
      {/* On the rail the badge goes under the label instead of squeezing it; the space keeps label and
          badge two words for the accessible-name check. */}
      <span aria-hidden="true" className={cn('flex max-w-full items-center gap-1', orientation === 'rail' && 'flex-col gap-0.5 [html.kb-open_&]:hidden')}>
        <span className="max-w-full truncate">{item.label}</span>{' '}
        {item.badge ? <span className={TAB_BADGE}>{item.badge}</span> : null}
      </span>
      {hint && item.disabledReason ? <DisabledHint text={item.disabledReason} rect={hint} orientation={orientation} /> : null}
    </button>
  );
}

export interface TabBarProps<Id extends string> {
  items: readonly TabBarItem<Id>[];
  /** The landmark's name ("Library", "Studio views"). */
  label: string;
  className?: string;
}

export function TabBar<Id extends string>({ items, label, className }: TabBarProps<Id>) {
  return (
    <nav aria-label={label} data-slot="tab-bar" className={cn(TAB_BAR, className)}>
      <div className={TAB_BAR_ROW}>
        {items.map((item) => (
          <TabItemButton key={item.id} item={item} orientation="bar" />
        ))}
      </div>
    </nav>
  );
}
