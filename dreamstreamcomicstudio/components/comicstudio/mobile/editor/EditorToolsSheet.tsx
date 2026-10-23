// The page editor's tools, presented per form factor (mobile.md §4.3 "Page editor tools", §5.6):
//
//   sheet    phones and tablet portrait: a NON-modal bottom sheet inside the editor (no scrim; the page
//            stays live above it) with three detents — peek (Edit with AI + Apply), half (page actions,
//            versions, quality check), full (the script). Drag the header, or use the grabber button to
//            step through the detents. The editor shrinks the stage to the resting height, so the sheet
//            never covers the page; only a live drag overlays it.
//   side     landscape phones: a 320 px side sheet beside the stage, collapsible to a 44 px tab.
//   aside    tablet landscape / desktop: today's 360–400 px aside.
//   segment  foldables: the tools fill the second screen.
//
// It is rendered INSIDE the editor dialog (not portalled), so the dialog's focus trap and aria-modal
// keep working for keyboard and screen-reader users. The tools themselves are always one
// `aside[aria-label="Page tools"]` landmark.

import React, { useRef, useState } from 'react';
import { ChevronRight, PanelRightOpen, X } from 'lucide-react';
import { cycleToolsDetent, nextToolsDetent, toolsSheetHeights, type ToolsDetent } from './editorModel';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45';

export interface EditorToolsSheetProps {
  presentation: 'sheet' | 'side' | 'aside' | 'segment';
  /** Sheet / side: shown (phones may close the sheet; landscape collapses the side sheet to a tab). */
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Sheet: resting detent. */
  detent: ToolsDetent;
  onDetentChange(detent: ToolsDetent): void;
  /** Sheet: the editor body's height (px) the detents are measured against. */
  avail: number;
  /** Sheet: a drag below peek (or Close) closes it. Tablets keep it (no toolbar to reopen it). */
  dismissible?: boolean;
  /** Side / aside width (px). */
  width?: number;
  /** Stacked foldable segment (tools below the hinge): no left border. */
  stacked?: boolean;
  /** Extra content above the scroller (e.g. the mode row in a tabletop foldable). */
  header?: React.ReactNode;
  /** Sheet at the very bottom of the screen (no toolbar under it): pad the home-indicator inset. */
  padBottom?: boolean;
  children: React.ReactNode;
}

const DETENT_LABEL: Record<ToolsDetent, string> = { peek: 'Edit with AI', half: 'Actions and versions', full: 'Everything, with the script' };
const DRAG_SLOP = 6;

const ToolsAside: React.FC<{ className?: string; style?: React.CSSProperties; children: React.ReactNode }> = ({ className, style, children }) => (
  <aside aria-label="Page tools" className={cx('min-h-0 min-w-0 space-y-5 overflow-y-auto overscroll-contain bg-[var(--ds-surface)]', className)} style={style} data-testid="page-tools">
    {children}
  </aside>
);

export const EditorToolsSheet: React.FC<EditorToolsSheetProps> = ({
  presentation,
  open,
  onOpenChange,
  detent,
  onDetentChange,
  avail,
  dismissible = false,
  width,
  stacked,
  header,
  padBottom,
  children
}) => {
  const [dragH, setDragH] = useState<number | null>(null);
  const drag = useRef<{ y: number; h: number; id: number; active: boolean; samples: { y: number; t: number }[] } | null>(null);
  const suppressClick = useRef(false);

  if (presentation === 'aside' || presentation === 'segment') {
    return (
      <div
        className={cx('flex min-h-0 min-w-0 flex-col bg-[var(--ds-surface)]', presentation === 'aside' ? 'shrink-0 border-l border-[var(--ds-hairline)]' : stacked ? 'flex-1' : 'h-full flex-1', stacked && 'border-t border-[var(--ds-hairline)]')}
        style={presentation === 'aside' && width ? { width } : undefined}
        data-tools="aside"
      >
        {header}
        <ToolsAside className="flex-1 p-4">{children}</ToolsAside>
      </div>
    );
  }

  if (presentation === 'side') {
    if (!open) {
      return (
        <button
          type="button"
          aria-label="Show page tools"
          aria-expanded={false}
          onClick={() => onOpenChange(true)}
          data-tools="side-tab"
          className={cx('press flex h-full w-11 shrink-0 flex-col items-center justify-center gap-2 border-l border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] text-[var(--ds-muted)] hover:text-[var(--ds-ink)]', FOCUS)}
          style={{ boxSizing: 'content-box', paddingRight: 'var(--sa-right, 0px)' }}
        >
          <PanelRightOpen className="h-4 w-4" aria-hidden />
          <span className="text-[11px] font-semibold [writing-mode:vertical-rl]">Tools</span>
        </button>
      );
    }
    return (
      <div
        className="flex h-full min-h-0 shrink-0 flex-col border-l border-[var(--ds-hairline)] bg-[var(--ds-surface)]"
        style={{ width: width ?? 320, boxSizing: 'content-box', paddingRight: 'var(--sa-right, 0px)' }}
        data-tools="side"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--ds-hairline)] pl-3 pr-1">
          <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--ds-ink)]">Page tools</h3>
          <button
            type="button"
            aria-label="Hide page tools"
            aria-expanded
            onClick={() => onOpenChange(false)}
            className={cx('grid h-11 w-11 place-items-center rounded-xl text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]', FOCUS)}
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <ToolsAside className="flex-1 p-3">{children}</ToolsAside>
      </div>
    );
  }

  // ── Bottom sheet ──
  if (!open) return null;
  const heights = toolsSheetHeights(avail);
  const resting = heights[detent];
  const height = dragH ?? resting;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag.current = { y: e.clientY, h: resting, id: e.pointerId, active: false, samples: [{ y: e.clientY, t: performance.now() }] };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dy = e.clientY - d.y;
    if (!d.active && Math.abs(dy) < DRAG_SLOP) return;
    if (!d.active) {
      d.active = true;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      } catch {
        /* jsdom / released pointer */
      }
    }
    const now = performance.now();
    d.samples.push({ y: e.clientY, t: now });
    while (d.samples.length > 2 && now - d.samples[0].t > 100) d.samples.shift();
    setDragH(Math.max(0, Math.min(heights.full, d.h - dy)));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId) return;
    if (!d.active) {
      setDragH(null);
      return;
    }
    suppressClick.current = true;
    window.setTimeout(() => (suppressClick.current = false), 0);
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const velocity = ((last.y - first.y) / Math.max(1, last.t - first.t)) * 1000;
    const h = Math.max(0, d.h - (e.clientY - d.y));
    setDragH(null);
    const next = nextToolsDetent(h, velocity, avail, dismissible);
    if (next === null) onOpenChange(false);
    else onDetentChange(next);
  };
  const onPointerCancel = () => {
    drag.current = null;
    setDragH(null);
  };

  return (
    <div
      role="region"
      aria-label="Page tools sheet"
      data-tools="sheet"
      data-detent={detent}
      className={cx(
        'absolute inset-x-0 bottom-0 z-[6] mx-auto flex w-full max-w-[720px] flex-col overflow-hidden rounded-t-[var(--sheet-radius,20px)] border border-b-0 border-[var(--ds-hairline)] bg-[var(--ds-surface)] shadow-[0_-8px_30px_rgba(0,0,0,0.14)]',
        dragH === null && 'transition-[height] duration-200 ease-out motion-reduce:transition-none'
      )}
      style={{ height }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && detent !== 'peek') {
          e.stopPropagation();
          onDetentChange('peek');
        }
      }}
    >
      <div
        className="relative flex h-11 shrink-0 touch-none select-none items-center gap-2 pl-4 pr-1"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        data-sheet-header
      >
        <button
          type="button"
          aria-label={`Resize page tools (now: ${DETENT_LABEL[detent]})`}
          onClick={() => {
            if (suppressClick.current) return;
            onDetentChange(cycleToolsDetent(detent));
          }}
          className={cx('absolute left-1/2 top-0 flex h-6 w-20 -translate-x-1/2 cursor-grab items-start justify-center pt-1.5', FOCUS)}
          data-hit-exempt="grabber: the whole 44 px header is its drag zone"
        >
          <span aria-hidden className="block h-1 w-9 rounded-full bg-[var(--ds-hairline)]" />
        </button>
        <h3 className="min-w-0 flex-1 truncate pt-1 text-[13px] font-semibold text-[var(--ds-ink)]">Page tools</h3>
        {dismissible && (
          <button
            type="button"
            aria-label="Close page tools"
            onClick={() => onOpenChange(false)}
            className={cx('mt-1 grid h-11 w-11 shrink-0 place-items-center rounded-full text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]', FOCUS)}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>
      {header}
      <ToolsAside className="flex-1 px-4 pb-4 pt-1" style={padBottom ? { paddingBottom: 'calc(var(--sa-bottom-eff, 0px) + 16px)' } : undefined}>
        {children}
      </ToolsAside>
    </div>
  );
};

export default EditorToolsSheet;
