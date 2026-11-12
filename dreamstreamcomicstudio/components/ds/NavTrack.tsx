/**
 * NavTrack — the in-content navigation between places (redesign plan §4, Atlas WorkspaceNav; collisions B-20: the app
 * shell's NavRail / TabBar / AppHeader are DS-2's, this is the track inside content). Horizontal under the tablet
 * header (Home · Director · Story · Pages · Publish, 48 px) and vertical inside the Sidebar at 1440 px.
 *
 *   - a `<nav>` whose items carry `aria-current="page"` on the current place, named with the visible label first
 *     (the navItemName rule: "Pages 6/12, 6 of 12 pages ready, drawing"), so voice control can say what it sees;
 *   - one pill glides under the current item (SEGMENTED_PILL on the panel time and the spring; it jumps under reduced
 *     motion);
 *   - the arrow keys move between items (Left/Right horizontal, mirrored right-to-left; Up/Down vertical), Home/End
 *     jump; only the current item is in the tab order, so Tab leaves the track in one step;
 *   - a badge ("6/12") and a dot (`new` reply, `waiting` for approval, `live` drawing) sit beside the label, the dot
 *     always spoken. `live` is a still dot here: the one live pulse on a screen belongs to the StatusPill;
 *   - an unavailable item stays focusable (aria-disabled) and says why in its name and its tooltip.
 * Ink only: no spark anywhere in navigation (sparkGuard).
 */
import React, { useRef } from 'react';
import { navItemName } from './TabBar';
import { cn } from '../../lib/utils';
import { DENSITY, FOCUS_RING_FLUSH, SEGMENTED_ACTIVE_FILL, SEGMENTED_PILL, STATUS_DOT } from './recipes';
import { isRtl, nextRovingIndex } from './roving';
import { useGlidingPill } from './useGlidingPill';

export type NavTrackDot = 'new' | 'waiting' | 'live';

export interface NavTrackItem<Id extends string = string> {
  id: Id;
  label: string;
  icon?: React.ReactNode;
  /** Short visible badge ("6/12"). */
  badge?: string;
  /** The badge spoken ("6 of 12 pages ready"). */
  badgeLabel?: string;
  dot?: NavTrackDot;
  disabled?: boolean;
  disabledReason?: string;
  /** A link instead of a button (app routes). */
  href?: string;
}

export interface NavTrackProps<Id extends string = string> {
  items: readonly NavTrackItem<Id>[];
  current: Id;
  onSelect: (id: Id) => void;
  /** The nav landmark's name ("Comic places"). */
  label: string;
  orientation?: 'horizontal' | 'vertical';
  /** Labels shrink to fit narrow segments (the book posture's 441 px screen: 5 × ~80 px, labels ≤ 11 px). */
  dense?: boolean;
  className?: string;
}

const DOT_FOR_NAME = { new: 'accent', waiting: 'amber', live: 'pulse' } as const;
const DOT_CLASS: Record<NavTrackDot, string> = { new: STATUS_DOT.active, waiting: STATUS_DOT.attention, live: STATUS_DOT.active };

/** The spoken name of an item: visible label and badge first, then what the badge and the dot mean. */
export const navTrackItemName = (item: NavTrackItem): string =>
  navItemName({ label: item.label, badge: item.badge, badgeLabel: item.badgeLabel, dot: item.dot ? DOT_FOR_NAME[item.dot] : undefined, disabled: item.disabled, disabledReason: item.disabledReason });

export const NAV_TRACK_ITEM = `relative inline-flex min-w-0 items-center gap-2 rounded-[calc(var(--ds-radius-control)-2px)] px-3 text-[13px] font-medium text-[var(--ds-muted)] no-underline transition-colors duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] hover:text-[var(--ds-ink)] aria-[current=page]:text-[var(--ds-ink)] aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${DENSITY.coarse}`;

export function NavTrack<Id extends string = string>({ items, current, onSelect, label, orientation = 'horizontal', dense = false, className }: NavTrackProps<Id>) {
  const track = useRef<HTMLDivElement>(null);
  const refs = useRef<Array<HTMLElement | null>>([]);
  const vertical = orientation === 'vertical';
  const { rect, ready } = useGlidingPill(track, '[aria-current="page"]', '[data-nav-item]', `${current}|${items.length}|${orientation}`);
  const enabled = items.map(() => true);
  const currentIndex = items.findIndex((i) => i.id === current);
  const tabStop = currentIndex >= 0 ? currentIndex : 0;

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const horizontalKeys = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
    const verticalKeys = e.key === 'ArrowUp' || e.key === 'ArrowDown';
    if ((vertical && horizontalKeys) || (!vertical && verticalKeys)) return;
    const next = nextRovingIndex(e.key, index, enabled, isRtl(track.current));
    if (next === null) return;
    e.preventDefault();
    refs.current[next]?.focus();
  };

  return (
    <nav aria-label={label} data-slot="nav-track" data-orientation={orientation} className={cn('min-w-0', className)}>
      <div ref={track} className={cn('relative flex min-w-0 gap-0.5', vertical ? 'flex-col' : 'flex-row overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden')}>
        {rect && !vertical ? (
          <span
            aria-hidden="true"
            data-slot="nav-track-pill"
            className={cn(SEGMENTED_PILL, !ready && 'transition-none')}
            style={{ width: rect.width, transform: `translateX(${rect.left}px)` }}
          />
        ) : null}
        {items.map((item, i) => {
          const on = item.id === current;
          const name = navTrackItemName(item);
          const content = (
            <>
              {item.icon ? (
                <span aria-hidden="true" className="inline-flex shrink-0 [&_svg]:size-4">
                  {item.icon}
                </span>
              ) : null}
              <span className={cn('min-w-0 truncate', dense && 'text-[11px]')}>{item.label}</span>
              {item.badge ? (
                <>
                  {/* A real space: the visible text reads "Pages 4/6", the start of the accessible name. */}{' '}
                  <span className="shrink-0 text-[11px] tabular-nums text-[var(--ds-muted)]">{item.badge}</span>
                </>
              ) : null}
              {item.dot ? <span aria-hidden="true" data-slot="nav-dot" className={cn('size-1.5 shrink-0 rounded-full', DOT_CLASS[item.dot])} /> : null}
            </>
          );
          const common = {
            'data-nav-item': item.id,
            'aria-current': on ? ('page' as const) : undefined,
            'aria-disabled': item.disabled || undefined,
            'aria-label': name !== item.label ? name : undefined,
            title: item.disabled ? item.disabledReason : undefined,
            tabIndex: i === tabStop ? 0 : -1,
            onKeyDown: (e: React.KeyboardEvent) => onKeyDown(e, i),
            className: `${cn(NAV_TRACK_ITEM, vertical ? 'h-9 w-full justify-start' : 'h-10 shrink-0 justify-center', vertical && on && SEGMENTED_ACTIVE_FILL, dense && 'px-2')} ${FOCUS_RING_FLUSH}`
          };
          const select = (e: React.MouseEvent) => {
            if (item.disabled) {
              e.preventDefault();
              return;
            }
            if (!item.href) onSelect(item.id);
          };
          return item.href && !item.disabled ? (
            <a
              key={item.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              href={item.href}
              onClick={() => onSelect(item.id)}
              {...common}
            >
              {content}
            </a>
          ) : (
            <button
              key={item.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              onClick={select}
              {...common}
            >
              {content}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
