// The studio's ⋯ menu (mobile.md §3.1, §9.1). On phones the header keeps only Back, the title, Share,
// the spend chip and ⋯; everything else lives here, in a thumb-reachable bottom sheet: the Easy/Pro
// view, Quality, spending (with "saved by software"), Read, Settings, Resync, and "Install app" when
// the browser offers it (never a nag). On tablets and desktop the same menu is a popover.

import React, { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { AdaptiveSheet } from '../sheets/AdaptiveSheet';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export interface MenuRow {
  id: string;
  label: string;
  icon: React.ReactNode;
  /** Right-hand detail (the tier, "$1.24 · saved $0.30"). */
  detail?: React.ReactNode;
  disabled?: boolean;
  /** Why it is disabled (shown under the label). */
  hint?: string;
  /** Opens another sheet (shows a chevron). */
  opensSheet?: boolean;
  onSelect: () => void;
}

export interface CompactHeaderMenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  rows: MenuRow[];
  /** Extra block above the rows (the Easy/Pro toggle on phones). */
  top?: React.ReactNode;
  title?: string;
}

/** Menu keyboard contract (role="menu"): ↑/↓ move between enabled items (wrapping), Home/End jump. */
export const onMenuKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));
  if (!items.length) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  let next = -1;
  if (e.key === 'ArrowDown') next = (i + 1) % items.length;
  else if (e.key === 'ArrowUp') next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  if (next < 0) return;
  e.preventDefault();
  items[next].focus();
};

export const CompactHeaderMenu: React.FC<CompactHeaderMenuProps> = ({ open, onClose, anchorRef, rows, top, title = 'Comic' }) => (
  <AdaptiveSheet open={open} onClose={onClose} label="More" title={title} anchorRef={anchorRef} placement="below" align="end" className="w-64 py-1">
    <div className="flex flex-col py-1">
      {top && <div className="border-b border-[var(--ds-hairline-soft)] px-4 pb-3 pt-1">{top}</div>}
      <div role="menu" aria-label="More" onKeyDown={onMenuKeyDown} className="flex flex-col p-1.5">
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            role="menuitem"
            disabled={r.disabled}
            onClick={() => {
              onClose();
              r.onSelect();
            }}
            className={cx(
              'press flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-1.5 text-left text-[14px] text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)] focus-visible:bg-[var(--ds-hover)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45 coarse:min-h-[48px]'
            )}
          >
            <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center text-[var(--ds-muted)]">
              {r.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{r.label}</span>
              {r.hint && <span className="block truncate text-[11.5px] text-[var(--ds-muted)]">{r.hint}</span>}
            </span>
            {r.detail !== undefined && <span className="max-w-[45%] shrink-0 truncate text-[12.5px] tabular-nums text-[var(--ds-muted)]">{r.detail}</span>}
            {r.opensSheet && <ChevronRight className="h-4 w-4 shrink-0 text-[var(--ds-muted)]" aria-hidden />}
          </button>
        ))}
      </div>
    </div>
  </AdaptiveSheet>
);

// ── Install (Android / desktop Chromium) ─────────────────────────────────────

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** The browser's install offer, captured while the studio is open (shown only as a ⋯ menu item). */
export const useInstallPrompt = (): { canInstall: boolean; install: () => void } => {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setEvt(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  return {
    canInstall: !!evt,
    install: () => {
      if (!evt) return;
      void evt.prompt().catch(() => undefined);
      setEvt(null);
    }
  };
};

export default CompactHeaderMenu;
