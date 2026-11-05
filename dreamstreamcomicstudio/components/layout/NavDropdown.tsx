import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { FOCUS_ITEM, FOCUS_RING, OVERLAY, OVERLINE } from '../chat/studioDesign';
import { nextRovingIndex } from '../ds/roving';
import { isPlainClick } from './siteLinks';
import { useDismiss } from './useDismiss';

export interface NavDropdownItem {
  label: string;
  description?: string;
  /** A leading mark or icon, hidden from assistive tech (the label names the item); it sizes itself. */
  icon?: React.ReactNode;
  /**
   * What a plain click does. Returning a promise keeps the menu open with the row marked busy (and
   * `busyLabel` in place of the description) until it settles: a crossing that waits on the server says so.
   */
  onClick?: () => void | Promise<unknown>;
  /** A real address: a middle-click or a new tab opens it; a plain click runs onClick when there is one. */
  href?: string;
  /** Leaves this site (an arrow says so; the link is followed as is). */
  external?: boolean;
  badge?: string;
  disabled?: boolean;
  /** The page on screen (aria-current="page" and a check). */
  current?: boolean;
  busyLabel?: string;
  /** A hairline above this row (a new group). */
  separated?: boolean;
}

interface NavDropdownProps {
  label: string;
  icon?: React.ReactNode;
  items: NavDropdownItem[];
  /** A small overline at the top of the menu (e.g. "Studios"). */
  caption?: string;
  /** Badge on the trigger itself, e.g. "Soon". */
  badge?: string;
  variant?: 'default' | 'muted';
  /** A page in this menu is on screen: the trigger reads in ink. */
  active?: boolean;
  /** Where the menu sits under its trigger. */
  align?: 'start' | 'center' | 'end';
  /** The menu's width and any other panel classes. */
  panelClassName?: string;
}

/** A mouse that leaves the trigger has this long to reach the menu (or come back) before it closes. */
export const HOVER_CLOSE_MS = 140;

const ALIGN: Record<NonNullable<NavDropdownProps['align']>, string> = {
  start: 'left-0',
  center: 'left-1/2 -translate-x-1/2',
  end: 'right-0'
};

const TRIGGER = `inline-flex items-center gap-1 rounded-[var(--ds-radius-control)] px-2.5 py-1.5 text-sm transition-colors duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] ${FOCUS_RING}`;
const ROW = `flex w-full items-start gap-3 rounded-[var(--ds-radius-panel)] px-3 py-2.5 text-left text-ds-ink transition-colors duration-[var(--ds-motion-fast)] ease-[var(--ds-ease)] hover:bg-ds-overlay-hover aria-disabled:pointer-events-none aria-disabled:opacity-50 ${FOCUS_ITEM}`;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  !!value && typeof (value as PromiseLike<unknown>).then === 'function';

/**
 * A header entry that opens a menu of destinations (the WAI disclosure-navigation pattern: a button that
 * shows and hides a list of links, not an application menu).
 *
 * - Mouse: hovering opens it, leaving closes it after a short grace. A click on a menu the hover opened
 *   keeps it open (it used to toggle it shut under the cursor); a second click closes it.
 * - Touch and pen: hover is ignored, a tap opens and closes it.
 * - Keyboard: Enter / Space toggles; ArrowDown / ArrowUp open it on the first / last row; inside, the
 *   arrows, Home and End move between rows; Escape closes it and returns to the trigger; Tab past the last
 *   row closes it.
 * - A press or focus anywhere else closes it; choosing a row runs it and closes the menu.
 */
export const NavDropdown: React.FC<NavDropdownProps> = ({
  label,
  icon,
  items,
  caption,
  badge,
  variant = 'default',
  active = false,
  align = 'center',
  panelClassName
}) => {
  const [open, setOpen] = useState(false);
  // Opened by a click / tap / key (stays open when the mouse leaves) rather than by hover.
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const focusOnOpen = useRef<'first' | 'last' | null>(null);
  const menuId = useId();

  const clearCloseTimer = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  useEffect(() => clearCloseTimer, []);

  const close = useCallback((returnFocus = false) => {
    clearCloseTimer();
    setOpen(false);
    setPinned(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useDismiss(
    open,
    (reason) => close(reason === 'escape' && !!rootRef.current?.contains(document.activeElement)),
    [rootRef]
  );

  const rows = (): HTMLElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[data-nav-row]:not([aria-disabled="true"])') ?? []);

  // Keyboard opening lands on a row once the menu is in the DOM.
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    const list = rows();
    (focusOnOpen.current === 'first' ? list[0] : list[list.length - 1])?.focus();
    focusOnOpen.current = null;
  }, [open]);

  const onPointerEnter = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    clearCloseTimer();
    setOpen(true);
  };
  const onPointerLeave = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || pinned) return;
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      // Never pull the menu out from under the keyboard.
      if (rootRef.current?.contains(document.activeElement) && document.activeElement !== triggerRef.current) return;
      setOpen(false);
    }, HOVER_CLOSE_MS);
  };

  const onTriggerClick = () => {
    clearCloseTimer();
    if (open && !pinned) {
      setPinned(true); // the hover opened it: the click keeps it open
      return;
    }
    if (open) {
      close();
      return;
    }
    setOpen(true);
    setPinned(true);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    focusOnOpen.current = e.key === 'ArrowDown' ? 'first' : 'last';
    setPinned(true);
    if (open) {
      const list = rows();
      (e.key === 'ArrowDown' ? list[0] : list[list.length - 1])?.focus();
      focusOnOpen.current = null;
    } else {
      setOpen(true);
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const list = rows();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const next = nextRovingIndex(e.key, at, list.map(() => true));
    if (next === null || e.key === 'ArrowLeft' || e.key === 'ArrowRight') return;
    e.preventDefault();
    list[next]?.focus();
  };

  const choose = (item: NavDropdownItem, index: number) => {
    if (busy !== null) return;
    const result = item.onClick?.();
    if (isThenable(result)) {
      setBusy(index);
      const settle = () => {
        setBusy(null);
        close();
      };
      result.then(settle, settle);
      return;
    }
    close();
  };

  const triggerTone = open || active ? 'font-medium text-ds-ink' : variant === 'muted' ? 'text-ds-muted/80 hover:text-ds-ink' : 'text-ds-muted hover:text-ds-ink';

  return (
    <div ref={rootRef} className="relative" onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      <button
        ref={triggerRef}
        type="button"
        onClick={onTriggerClick}
        onKeyDown={onTriggerKeyDown}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={cn(TRIGGER, triggerTone)}
      >
        {icon ? <span aria-hidden="true" className="contents">{icon}</span> : null}
        {label}
        {badge ? (
          <span className="rounded-[var(--ds-radius-chip)] border border-ds-hairline px-1.5 py-px text-[10px] font-medium leading-4 text-ds-muted">{badge}</span>
        ) : null}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-3.5 text-ds-muted transition-transform duration-[var(--ds-motion-panel)] ease-[var(--ds-ease)] motion-reduce:transition-none',
            open && 'rotate-180'
          )}
        />
      </button>

      {open ? (
        // pt-2 is the hover bridge: the pointer crosses it from the trigger to the menu without leaving.
        <div className={cn('absolute top-full pt-2', ALIGN[align])}>
          <div
            ref={menuRef}
            id={menuId}
            onKeyDown={onMenuKeyDown}
            className={cn(OVERLAY, 'ds-scale-in w-72 origin-top rounded-[var(--ds-radius-feature)] p-1.5', panelClassName)}
          >
            {caption ? <p className={cn(OVERLINE, 'px-3 pb-1 pt-2')}>{caption}</p> : null}
            <ul className="flex flex-col gap-0.5">
              {items.map((item, i) => {
                const isBusy = busy === i;
                const description = isBusy && item.busyLabel ? item.busyLabel : item.description;
                const body = (
                  <>
                    {/* A direct child of the row, so a studio mark plays its hover moment (studio-marks.css). */}
                    {item.icon ?? null}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-sm font-medium leading-5">
                        {item.label}
                        {item.badge ? (
                          <span className="rounded-[var(--ds-radius-chip)] border border-ds-hairline px-1.5 py-px text-[10px] font-medium leading-4 text-ds-muted">
                            {item.badge}
                          </span>
                        ) : null}
                        {item.external ? <ArrowUpRight aria-hidden="true" className="size-3.5 text-ds-muted" /> : null}
                      </span>
                      {description ? <span className="mt-0.5 block text-[13px] leading-5 text-ds-muted">{description}</span> : null}
                    </span>
                    {isBusy ? (
                      <Loader2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin text-ds-muted motion-reduce:animate-none" />
                    ) : item.current ? (
                      <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ds-ink" />
                    ) : null}
                  </>
                );
                const shared = {
                  'data-nav-row': '',
                  'aria-current': item.current ? ('page' as const) : undefined,
                  'aria-disabled': item.disabled || undefined,
                  'aria-busy': isBusy || undefined,
                  className: ROW
                };
                return (
                  <li key={`${item.label}-${i}`} className={item.separated ? 'mt-1 border-t border-ds-hairline pt-1' : undefined}>
                    {item.href ? (
                      <a
                        {...shared}
                        href={item.href}
                        rel={item.external ? 'noopener' : undefined}
                        onClick={(e) => {
                          if (item.disabled) {
                            e.preventDefault();
                            return;
                          }
                          if (!item.onClick) {
                            close();
                            return;
                          }
                          if (!isPlainClick(e)) return;
                          e.preventDefault();
                          choose(item, i);
                        }}
                      >
                        {body}
                      </a>
                    ) : (
                      <button {...shared} type="button" onClick={() => !item.disabled && choose(item, i)}>
                        {body}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
};
