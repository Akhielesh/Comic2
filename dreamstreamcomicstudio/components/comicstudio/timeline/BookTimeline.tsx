// The book timeline dock (contract §13.3; owner P1-TIMELINE). Wave 0 (P0-C) stub: renders nothing.

import type React from 'react';
import type { StudioController } from '../types';

export interface BookTimelineProps {
  studio: StudioController;
  compact?: boolean;
  /** 'longpress' on touch (reorder must not fight scrolling). */
  reorderActivation?: 'longpress' | 'immediate';
}

export const BookTimeline: React.FC<BookTimelineProps> = () => null;

export default BookTimeline;
