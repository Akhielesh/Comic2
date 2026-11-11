/**
 * NavRail — the side navigation for a phone in landscape (`single-rail`; redesign plan §2 "Phone nav
 * outside the studio", §5.2 852×393, §11.3 M1c): the same items as TabBar, stacked in a rail the chrome
 * token wide (`--rail-w`, 72 px) plus the left safe area, and led by a Back item when the place has one to
 * go back to (the studio's "← + 5 places"). Labels hide while the on-screen keyboard is up, so the rail
 * never pushes its items under it.
 *
 * Generic over its ids, like TabBar; an unavailable item says why on a tap (the bubble opens beside the
 * rail).
 */
import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { cn } from '../../lib/utils';
import { FOCUS_RING_FLUSH } from './recipes';
import { TAB_ITEM, TAB_ITEM_IDLE, TAB_ITEM_ORIENTATION, TAB_PILL, TAB_PILL_IDLE, TabItemButton, type TabBarItem } from './TabBar';

/** The rail: the rail token wide plus the left safe area, items from the top, its own scroll when short. */
export const NAV_RAIL = 'flex h-full w-[calc(var(--rail-w,72px)+var(--sa-left,0px))] shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-[var(--ds-hairline-soft)] bg-[var(--ds-surface-strong)] py-2 pl-[var(--sa-left,0px)]';
/** The hairline between the Back item and the places. */
export const NAV_RAIL_DIVIDER = 'my-1 h-px w-8 shrink-0 bg-[var(--ds-hairline)]';

export interface NavRailBack {
  /** What Back says ("Back to your comics"); the visible word is "Back". */
  label: string;
  onBack: () => void;
}

export interface NavRailProps<Id extends string> {
  items: readonly TabBarItem<Id>[];
  /** The landmark's name. */
  label: string;
  /** The leading Back item (above the places, apart from them). */
  back?: NavRailBack;
  className?: string;
}

export function NavRail<Id extends string>({ items, label, back, className }: NavRailProps<Id>) {
  return (
    <nav aria-label={label} data-slot="nav-rail" className={cn(NAV_RAIL, className)}>
      {back ? (
        <>
          <button
            type="button"
            onClick={back.onBack}
            aria-label={back.label.toLowerCase().startsWith('back') ? back.label : `Back, ${back.label}`}
            title={back.label}
            data-nav-back=""
            className={`${cn(TAB_ITEM, TAB_ITEM_ORIENTATION.rail, TAB_ITEM_IDLE)} ${FOCUS_RING_FLUSH}`}
          >
            <span aria-hidden="true" className={cn(TAB_PILL, TAB_PILL_IDLE)}>
              <ArrowLeft />
            </span>
            <span aria-hidden="true" className="max-w-full truncate [html.kb-open_&]:hidden">
              Back
            </span>
          </button>
          <span aria-hidden="true" className={NAV_RAIL_DIVIDER} />
        </>
      ) : null}
      {items.map((item) => (
        <TabItemButton key={item.id} item={item} orientation="rail" />
      ))}
    </nav>
  );
}
