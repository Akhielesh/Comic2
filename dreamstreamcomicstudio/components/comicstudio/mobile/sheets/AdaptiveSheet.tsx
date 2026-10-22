// AdaptiveSheet (contract §13.3; owner P1-SHELL): one sheet that presents as a popover,
// bottom sheet or side sheet by form factor. Wave 0 (P0-C) stub: always today's PopSheet,
// so callers can adopt the final props now and get the adaptive behaviour when P1-SHELL lands.

import React from 'react';
import { PopSheet, type PopSheetProps } from '../../conversation/PopSheet';

export type SheetPresentation = 'auto' | 'popover' | 'bottom' | 'side';
export type SheetDetent = 'peek' | 'half' | 'full' | 'content' | number;

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
}

export const AdaptiveSheet: React.FC<AdaptiveSheetProps> = ({
  presentation: _presentation,
  detents: _detents,
  initialDetent: _initialDetent,
  side: _side,
  modal: _modal,
  title: _title,
  ...popSheet
}) => <PopSheet {...popSheet} />;

export default AdaptiveSheet;
