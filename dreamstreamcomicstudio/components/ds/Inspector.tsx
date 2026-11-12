/**
 * Inspector — details of the selected comic beside or over the grid (redesign plan §2 "Library inspector", §4, §5):
 * the Library's InspectorPanel and Discover's DualPanePreview become one component whose presentation layout.ts
 * decides (`library.inspector` / `discover.inspector`):
 *
 *   panel         a persistent column beside the grid (≥ 1280: 360 px, 380 px at 1440); no scrim, the grid stays
 *                 usable and drops a column;
 *   side-sheet    a sheet over the grid (tablets, a phone on its side) with the scrim (no blur);
 *   bottom-sheet  a phone's bottom sheet at 60 % that drags up to 92 %;
 *   segment       one screen of a foldable (book posture: the right segment; tabletop: the bottom one), ALWAYS
 *                 mounted — with nothing selected it says "Select a comic to see its details";
 *   none          nothing (Discover outside a foldable opens the comic instead).
 *
 * Never inside the studio: the Director owns the right side there from 1024 px. The body is the screen's (a
 * ComicCard hero, InlineMeta, the share row, the actions); the sheets come from components/ds/sheet.
 */
import React from 'react';
import { cn } from '../../lib/utils';
import type { InspectorLayout } from './layout';
import { BottomSheet, SideSheet } from './sheet';
import { RADIUS_PANEL } from './recipes';

export interface InspectorProps {
  layout: InspectorLayout;
  /** Whether something is selected and the inspector should show it (a segment shows its empty line instead). */
  open: boolean;
  onClose: () => void;
  /** The accessible name ("Comic details"). */
  label: string;
  /** The visible heading in a sheet. */
  title?: string;
  /** Shown in an always-mounted segment while nothing is selected. */
  emptyText?: string;
  anchorRef?: React.RefObject<HTMLElement | null>;
  children?: React.ReactNode;
  className?: string;
}

export const INSPECTOR_PANEL = `flex min-h-0 min-w-0 shrink-0 flex-col overflow-y-auto border border-[var(--ds-hairline)] bg-[var(--ds-surface)] text-[var(--ds-ink)] ${RADIUS_PANEL}`;

export function Inspector({ layout, open, onClose, label, title, emptyText = 'Select a comic to see its details', anchorRef, children, className }: InspectorProps) {
  switch (layout.mode) {
    case 'none':
      return null;
    case 'panel':
      if (!open) return null;
      return (
        <aside aria-label={label} data-slot="inspector" data-mode="panel" className={cn(INSPECTOR_PANEL, 'p-4', className)} style={{ width: layout.widthPx ?? 360 }}>
          {children}
        </aside>
      );
    case 'segment':
      return (
        <aside aria-label={label} data-slot="inspector" data-mode="segment" className={cn('flex h-full min-h-0 w-full min-w-0 flex-col overflow-y-auto p-4', className)}>
          {open ? (
            children
          ) : (
            <p className="m-auto max-w-xs text-center text-[length:var(--ds-text-base)] leading-6 text-[var(--ds-muted)]">{emptyText}</p>
          )}
        </aside>
      );
    case 'side-sheet':
      return (
        <SideSheet open={open} onClose={onClose} label={label} title={title} modal={layout.scrim} width={layout.widthPx ?? 400} anchorRef={anchorRef}>
          <div data-slot="inspector" data-mode="side-sheet" className={cn('min-w-0 p-4', className)}>
            {children}
          </div>
        </SideSheet>
      );
    case 'bottom-sheet':
      return (
        <BottomSheet
          open={open}
          onClose={onClose}
          label={label}
          title={title}
          detents={[...(layout.detents ?? [0.6, 0.92])]}
          anchorRef={anchorRef}
        >
          <div data-slot="inspector" data-mode="bottom-sheet" className={cn('min-w-0 px-4 pb-4', className)}>
            {children}
          </div>
        </BottomSheet>
      );
  }
}
