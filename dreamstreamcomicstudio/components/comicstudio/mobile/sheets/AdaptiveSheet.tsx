// AdaptiveSheet (contract §13.3; mobile.md §4): ONE sheet API that presents as
//   - a popover on desktop / fine pointers (today's PopSheet; viewport-clamped when anchored),
//   - a BottomSheet with detents on phones (compact width or compact height),
//   - a SideSheet on touch tablets for panel-like content (`panel`), or when asked for 'side'.
// Callers keep PopSheet's props and get the right presentation on every form factor.

import React, { useLayoutEffect, useState } from 'react';
import { PopSheet, type PopSheetProps } from '../../conversation/PopSheet';
import { useFormFactor } from '../useFormFactor';
import { BottomSheet } from './BottomSheet';
import { SideSheet } from './SideSheet';
import { resolvePresentation, type ResolvedPresentation, type SheetDetent, type SheetPresentation } from './snap';

export type { SheetDetent, SheetPresentation } from './snap';
export { resolvePresentation, snapDetent, detentHeights } from './snap';

export interface AdaptiveSheetProps extends PopSheetProps {
  /** Default 'auto'. */
  presentation?: SheetPresentation;
  /** Bottom only; default ['content']. */
  detents?: SheetDetent[];
  initialDetent?: number;
  /** Side only. */
  side?: 'right' | 'left';
  /** Default: bottom=true, side=false, popover=false. */
  modal?: boolean;
  /** Shown in the sheet header on bottom/side. */
  title?: string;
  /** Panel-like content (settings, inspector, media): becomes a side sheet on touch tablets. */
  panel?: boolean;
  /** Side sheet width in px (default 420). */
  sideWidth?: number;
  /** Bottom sheets: whether drag-down / scrim / Esc may close it (default true). */
  dismissible?: boolean;
  /** Reports the presentation actually used (tests, callers that adapt their content). */
  onPresentation?: (p: ResolvedPresentation) => void;
}

export const AdaptiveSheet: React.FC<AdaptiveSheetProps> = ({
  presentation = 'auto',
  detents,
  initialDetent,
  side,
  modal,
  title,
  panel,
  sideWidth,
  dismissible,
  onPresentation,
  ...popSheet
}) => {
  const ff = useFormFactor();
  const { open, anchorRef } = popSheet;
  // Coarse pointers: a sheet that pops ABOVE its anchor (composer panels) with little room there — the
  // keyboard is up — becomes a bottom sheet. Header popovers open below and are never affected.
  const above = (popSheet.placement ?? 'above') === 'above';
  const [anchorTop, setAnchorTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!open || !ff.coarse || presentation !== 'auto' || !above) return;
    const r = anchorRef?.current?.getBoundingClientRect();
    setAnchorTop(r ? r.top : null);
  }, [open, ff.coarse, presentation, anchorRef, above]);

  const resolved = resolvePresentation(ff, presentation, { panel, anchorRect: above && anchorTop !== null ? { top: anchorTop } : null });
  useLayoutEffect(() => {
    if (open) onPresentation?.(resolved);
  }, [open, resolved, onPresentation]);

  if (resolved === 'bottom') {
    return (
      <BottomSheet
        open={popSheet.open}
        onClose={popSheet.onClose}
        label={popSheet.label}
        title={title}
        detents={detents}
        initialDetent={initialDetent}
        modal={modal ?? true}
        dismissible={dismissible}
        anchorRef={anchorRef}
      >
        {popSheet.children}
      </BottomSheet>
    );
  }
  if (resolved === 'side') {
    return (
      <SideSheet open={popSheet.open} onClose={popSheet.onClose} label={popSheet.label} title={title} side={side} modal={modal ?? false} width={sideWidth} anchorRef={anchorRef}>
        {popSheet.children}
      </SideSheet>
    );
  }
  // Anchored popovers are portalled and viewport-clamped unless the caller pinned a strategy; on a
  // dual-screen device they stay on the screen that holds their anchor (never across the fold).
  const sideBySide = ff.segments.count === 2 && ff.segments.axis === 'horizontal' ? ff.segments.rects : null;
  return <PopSheet {...popSheet} strategy={popSheet.strategy ?? (anchorRef ? 'fixed' : 'absolute')} segments={popSheet.segments ?? sideBySide} />;
};

export default AdaptiveSheet;
