// ContextMenuSheet (mobile.md §5.5): the action list behind a long-press / right-click. A bottom sheet
// on phones (thumb-reachable 48 px rows), a popover at the press point elsewhere. Arrow keys move,
// Home/End jump, Esc closes; a danger item is visually distinct; disabled items say why (hint).

import React, { useEffect, useMemo, useRef } from 'react';
import { AdaptiveSheet } from '../sheets/AdaptiveSheet';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  /** Short secondary text (a price, "Free", or why it is disabled). */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface ContextMenuSheetProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name / sheet title ("Balloon", "Page 3"). */
  label: string;
  items: ContextMenuItem[];
  /** Where the press happened (client px); the popover opens there. */
  at?: { x: number; y: number } | null;
}

export const ContextMenuSheet: React.FC<ContextMenuSheetProps> = ({ open, onClose, label, items, at }) => {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const enabled = useMemo(() => items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0), [items]);

  // Keep the invisible anchor on the press point (fixed, so scrolling containers cannot clip it).
  useEffect(() => {
    const a = anchorRef.current;
    if (!a || !at) return;
    a.style.left = `${Math.round(at.x)}px`;
    a.style.top = `${Math.round(at.y)}px`;
  }, [at, open]);

  const onKey = (e: React.KeyboardEvent) => {
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') || []);
    if (!buttons.length) return;
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % buttons.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    if (next < 0) return;
    e.preventDefault();
    buttons[next].focus();
  };

  return (
    <>
      <span ref={anchorRef} aria-hidden className="pointer-events-none fixed h-px w-px" style={{ left: at?.x ?? 0, top: at?.y ?? 0 }} />
      <AdaptiveSheet open={open} onClose={onClose} label={label} title={label} anchorRef={anchorRef} placement="below" align="start" presentation="auto" detents={['content']} className="w-64 p-1">
        <div ref={listRef} role="menu" aria-label={label} onKeyDown={onKey} className="flex flex-col p-1.5">
          {items.map((it, i) => (
            <button
              key={it.id}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              data-autofocus={i === enabled[0] ? '' : undefined}
              onClick={() => {
                onClose();
                it.onSelect();
              }}
              className={cx(
                'press flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 text-left text-[14px] transition-colors hover:bg-[var(--ds-hover)] focus-visible:bg-[var(--ds-hover)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45 coarse:min-h-[48px]',
                it.danger ? 'text-red-600 dark:text-red-300' : 'text-[var(--ds-ink)]'
              )}
            >
              {it.icon && (
                <span aria-hidden className={cx('grid h-5 w-5 shrink-0 place-items-center', it.danger ? '' : 'text-[var(--ds-muted)]')}>
                  {it.icon}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.hint && <span className="shrink-0 text-[12px] tabular-nums text-[var(--ds-muted)]">{it.hint}</span>}
            </button>
          ))}
        </div>
      </AdaptiveSheet>
    </>
  );
};

export default ContextMenuSheet;
