import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';
import { CHIP, CHIP_VARIANT, FOCUS_ITEM, FOCUS_RING_FLUSH, OVERLAY, OVERLINE, SCALE_IN, SEGMENTED_ACTIVE_FILL, Z } from '../chat/studioDesign';

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
  /**
   * Kept for callers: under Atlas hue never decorates, so `blue` reads as `default`; `muted` is a product
   * that is not open yet (the muted ink, its badge says why).
   */
  variant?: 'default' | 'blue' | 'muted';
}

/** Colour and fill changes on the nav, on the motion tokens (each read keeps its fallback). */
const NAV_MOTION = 'transition-[color,background-color,box-shadow] duration-[var(--ds-motion-fast,120ms)] ease-[var(--ds-ease,cubic-bezier(0.4,0,0.2,1))] motion-reduce:transition-none';

/**
 * A trigger in the header's nav track (Atlas WorkspaceNav on SEGMENTED_TRACK): muted ink at rest, ink on hover,
 * and the segment pill while its menu is open.
 */
export const NAV_TRIGGER = `flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[calc(var(--ds-radius-control,0.75rem)-2px)] px-3 text-[13px] font-medium coarse:min-h-[var(--ds-density-touch)] ${NAV_MOTION}`;
export const NAV_TRIGGER_OPEN = `${SEGMENTED_ACTIVE_FILL} text-[var(--ds-ink)]`;
export const NAV_TRIGGER_REST = 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]';

/** The menu: the overlay surface on the popover layer, rows highlighted in the overlay-row colour. */
export const NAV_MENU = `w-64 p-1.5 ${OVERLAY}`;
/**
 * The menu's entrance: the 280 ms overlay scale-in (styles/ds-motion.css), not the 420 ms page entrance
 * (redesign §2 Motion keeps enter-slow for a new page); still under reduced motion.
 */
export const NAV_MENU_ENTER = SCALE_IN;
export const NAV_MENU_ROW = `flex w-full items-center gap-3 rounded-[var(--ds-radius-control,0.75rem)] px-3 py-2 text-left hover:bg-[var(--ds-overlay-hover)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent coarse:min-h-[var(--ds-density-touch)] ${NAV_MOTION} ${FOCUS_ITEM}`;

/**
 * A header nav item that reveals a menu of specific options on hover (and on tap, for touch). Each top-level
 * product uses one so its sub-destinations are one hover away. Hover opens it for a real mouse only: a tap
 * fires a compatibility mouseenter before its click, which used to open the menu and then toggle it shut, so
 * on a touch screen from 1024 px (no phone toggle there) the products could not be reached. Touch and pen
 * open it with the click alone. Escape closes it and returns focus to the trigger; moving focus out of it
 * closes it too. The trigger is a disclosure (aria-expanded + aria-controls) over plain buttons, not a menu,
 * so it announces no menu semantics it does not have.
 */
export const NavDropdown: React.FC<NavDropdownProps> = ({ label, icon, items, caption, badge, variant = 'default' }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="relative"
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') setOpen(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') setOpen(false);
      }}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-variant={variant}
        className={`${cn(NAV_TRIGGER, open ? NAV_TRIGGER_OPEN : NAV_TRIGGER_REST, variant === 'muted' && !open && 'opacity-90')} ${FOCUS_RING_FLUSH}`}
      >
        {icon}
        {label}
        {badge && <span className={cn(CHIP, CHIP_VARIANT.outline, 'px-1.5 text-[10px] leading-3')}>{badge}</span>}
        <ChevronDown aria-hidden="true" size={13} className={cn('transition-transform duration-[var(--ds-motion-fast,120ms)] motion-reduce:transition-none', open && 'rotate-180')} />
      </button>

      {open && (
        // pt-2 keeps a hover "bridge" so moving the cursor from trigger to menu doesn't close it.
        <div className={cn('absolute left-1/2 top-full -translate-x-1/2 pt-2', Z.popover)}>
          <div id={menuId} data-slot="nav-menu" className={cn(NAV_MENU, NAV_MENU_ENTER)}>
            {caption && <p className={cn('m-0 px-3 pb-1 pt-1.5', OVERLINE)}>{caption}</p>}
            {items.map((item, i) => (
              <button
                key={i}
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  item.onClick?.();
                  setOpen(false);
                }}
                className={NAV_MENU_ROW}
              >
                {item.icon && <span aria-hidden="true" className="shrink-0 text-[var(--ds-muted)]">{item.icon}</span>}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[length:var(--ds-text-base)] font-medium text-[var(--ds-ink)]">
                    {item.label}
                    {item.badge && <span className={cn(CHIP, CHIP_VARIANT.outline)}>{item.badge}</span>}
                  </span>
                  {item.description && <span className="mt-0.5 block text-xs text-[var(--ds-muted)]">{item.description}</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
