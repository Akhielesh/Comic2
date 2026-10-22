// Per-clip actions (timeline.md §4.2 "ClipMenu"; mobile.md §5.5 filmstrip menu). Every keyboard
// shortcut of the timeline is also an item here (no hidden-only paths). Free actions say "Free";
// paid ones show the registry price and go through the normal gate (never spent from here).
// Presented through AdaptiveSheet (popover on desktop, bottom sheet on phones once P1-SHELL lands),
// in a fixed, portal-mounted anchor so the filmstrip's scroller can never clip it.

import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Crop,
  EyeOff,
  Layers,
  Plus,
  RefreshCw,
  Sparkles,
  SplitSquareHorizontal,
  SquarePen,
  Trash2,
  Type
} from 'lucide-react';
import { formatUsd, PLAN_USD_PER_PAGE } from '../../../shared/comic/models';
import { AdaptiveSheet } from '../mobile/sheets/AdaptiveSheet';
import type { ClipVM } from './bookModel';
import { cx, FOCUS_RING } from './ui';

export type ClipAction =
  | 'open'
  | 'versions'
  | 'compare'
  | 'redraw'
  | 'fit'
  | 'duplicate'
  | 'insert'
  | 'write'
  | 'move_left'
  | 'move_right'
  | 'delete'
  | 'cover_redesign'
  | 'cover_text'
  | 'plate_edit'
  | 'plate_hide';

export interface ClipMenuItem {
  action: ClipAction;
  label: string;
  /** "Free", "≈ $0.06", "Alt+→" … */
  meta?: string;
  icon: React.ReactNode;
  disabled?: boolean;
  /** Why it is disabled (shown as the item's title and to screen readers). */
  reason?: string;
  danger?: boolean;
  shortcut?: string;
}

const icon = (C: React.ComponentType<{ className?: string }>) => <C className="h-4 w-4" />;

/** The items for a clip (pure; tested). */
export function clipMenuItems(
  clip: ClipVM,
  opts: { redrawUsd: number; coverUsd: number; canMoveLeft: boolean; canMoveRight: boolean; canAddPage: boolean; pageCount: number }
): ClipMenuItem[] {
  const busyReason = clip.busy ? `${clip.label} is still drawing — wait for it to finish.` : undefined;
  if (clip.plate) {
    return [
      { action: 'plate_edit', label: clip.kind === 'title' ? 'Edit title text' : clip.kind === 'end' ? 'Edit credits' : 'Edit blurb', meta: 'Free', icon: icon(Type) },
      { action: 'plate_hide', label: `Hide ${clip.label.toLowerCase()}`, meta: 'Free', icon: icon(EyeOff) }
    ];
  }
  if (clip.kind === 'cover') {
    const items: ClipMenuItem[] = [];
    if (clip.versions > 0) items.push({ action: 'versions', label: `Versions (${clip.versions})`, meta: 'Free', icon: icon(Layers), shortcut: 'V' });
    if (clip.versions > 1) items.push({ action: 'compare', label: 'Compare versions…', meta: 'Free', icon: icon(SplitSquareHorizontal) });
    if (clip.mismatch) items.push({ action: 'fit', label: `Fit to ${clip.mismatch.want}`, meta: 'Free', icon: icon(Crop), disabled: clip.busy, reason: busyReason });
    items.push({
      action: 'cover_redesign',
      label: clip.drawn ? 'Redesign the cover' : 'Draw the cover',
      meta: `≈ ${formatUsd(opts.coverUsd)}`,
      icon: icon(RefreshCw),
      disabled: clip.busy,
      reason: busyReason
    });
    items.push({ action: 'cover_text', label: 'Cover title & tagline', meta: 'Free', icon: icon(Type) });
    items.push({ action: 'insert', label: 'Add a blank page at the start', meta: 'Free', icon: icon(Plus), shortcut: 'I', disabled: !opts.canAddPage, reason: opts.canAddPage ? undefined : 'This comic is at its page limit.' });
    return items;
  }
  // Pages.
  const page = clip.page;
  const items: ClipMenuItem[] = [{ action: 'open', label: 'Open page', meta: 'Enter', icon: icon(SquarePen) }];
  if (clip.versions > 0) items.push({ action: 'versions', label: `Versions (${clip.versions})`, meta: 'Free', icon: icon(Layers), shortcut: 'V' });
  if (clip.versions > 1) items.push({ action: 'compare', label: 'Compare versions…', meta: 'Free', icon: icon(SplitSquareHorizontal) });
  if (clip.mismatch) items.push({ action: 'fit', label: `Fit to ${clip.mismatch.want}`, meta: 'Free', icon: icon(Crop), disabled: clip.busy, reason: busyReason });
  if (page?.panels.length) {
    items.push({
      action: 'redraw',
      label: clip.drawn ? 'Redraw (new take)' : 'Draw this page',
      meta: `≈ ${formatUsd(opts.redrawUsd)}`,
      icon: icon(RefreshCw),
      disabled: clip.busy,
      reason: busyReason
    });
  } else {
    items.push({ action: 'write', label: 'Write this page with AI', meta: `≈ ${formatUsd(PLAN_USD_PER_PAGE)}`, icon: icon(Sparkles) });
  }
  const full = opts.canAddPage ? undefined : 'This comic is at its page limit.';
  items.push({ action: 'duplicate', label: 'Duplicate', meta: 'Free', icon: icon(Copy), shortcut: 'D', disabled: clip.busy || !opts.canAddPage, reason: busyReason ?? full });
  items.push({ action: 'insert', label: 'Insert blank page after', meta: 'Free', icon: icon(Plus), shortcut: 'I', disabled: !opts.canAddPage, reason: full });
  items.push({ action: 'move_left', label: 'Move earlier', meta: 'Alt+←', icon: icon(ArrowLeft), disabled: !opts.canMoveLeft });
  items.push({ action: 'move_right', label: 'Move later', meta: 'Alt+→', icon: icon(ArrowRight), disabled: !opts.canMoveRight });
  items.push({
    action: 'delete',
    label: 'Delete page',
    meta: 'Undo',
    icon: icon(Trash2),
    danger: true,
    disabled: clip.busy || opts.pageCount <= 1,
    reason: busyReason ?? (opts.pageCount <= 1 ? 'A comic needs at least one page.' : undefined),
    shortcut: 'Del'
  });
  return items;
}

const MENU_W = 272;

export interface ClipMenuProps {
  open: boolean;
  onClose(): void;
  clip: ClipVM | null;
  anchor: DOMRect | null;
  items: ClipMenuItem[];
  onAction(action: ClipAction): void;
}

export const ClipMenu: React.FC<ClipMenuProps> = ({ open, onClose, clip, anchor, items, onAction }) => {
  const listRef = useRef<HTMLDivElement>(null);
  if (!open || !clip || typeof document === 'undefined') return null;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  const rect = anchor ?? ({ left: 8, top: vh - 8, bottom: vh - 8 } as DOMRect);
  const width = Math.min(MENU_W, vw - 16);
  const left = Math.max(8, Math.min(rect.left, vw - width - 8));
  const above = rect.top > Math.min(360, vh * 0.5);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const els = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);
    if (!els.length) return;
    e.preventDefault();
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length;
    els[next]?.focus();
  };
  return createPortal(
    <div className="fixed z-[58]" style={{ left, width, top: above ? rect.top : rect.bottom, height: 0 }}>
      <AdaptiveSheet open onClose={onClose} label={`${clip.label} actions`} title={clip.label} placement={above ? 'above' : 'below'} align="stretch" presentation="auto" detents={['content']}>
        <div ref={listRef} role="menu" aria-label={`${clip.label} actions`} className="p-1.5" onKeyDown={onKey}>
          {items.map((it, i) => (
            <button
              key={it.action}
              type="button"
              role="menuitem"
              data-autofocus={i === 0 ? '' : undefined}
              disabled={it.disabled}
              title={it.reason}
              aria-description={it.reason}
              onClick={() => {
                onClose();
                onAction(it.action);
              }}
              className={cx(
                'flex min-h-[40px] w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] hover:bg-[var(--ds-hover)] disabled:cursor-not-allowed disabled:opacity-45 coarse:min-h-[44px]',
                FOCUS_RING,
                it.danger ? 'text-red-600 dark:text-red-300' : 'text-[var(--ds-ink)]'
              )}
            >
              <span className="shrink-0 text-[var(--ds-muted)]" aria-hidden>
                {it.icon}
              </span>
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.meta && <span className="shrink-0 text-[11px] tabular-nums text-[var(--ds-muted)]">{it.meta}</span>}
            </button>
          ))}
        </div>
      </AdaptiveSheet>
    </div>,
    document.body
  );
};

export default ClipMenu;
