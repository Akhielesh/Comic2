// Client feature module: book timeline, versions and the media bin (cards: versions; tabs: media).
// Owner: P1-TIMELINE (wave 1). Registered through ../features.ts (contract §13.2).
// BookTimeline itself is mounted by the shell's dock slot (P1-SHELL) and, compact, by the page
// editor (P2-EDITOR); VersionStack replaces ImageFrame's VersionStrip (P2-BOARD).

import React from 'react';
import { Images } from 'lucide-react';
import type { FeatureModule } from '../extensions';
import { hasMedia } from './bookModel';
import { MediaTab } from './MediaTab';
import { VersionsCard } from './VersionsCard';

export const feature: FeatureModule = {
  cards: [{ type: 'versions', Component: VersionsCard }],
  tabs: [
    {
      id: 'media',
      label: 'Media',
      icon: React.createElement(Images, { className: 'h-4 w-4', 'aria-hidden': true }),
      order: 500,
      Component: MediaTab,
      visible: (doc) => hasMedia(doc)
    }
  ]
};

export { BookTimeline } from './BookTimeline';
export type { BookTimelineProps } from './BookTimeline';
export { VersionStack } from './VersionStack';
export type { VersionStackProps } from './VersionStack';
export { MediaBin } from './MediaBin';
export { MediaTab } from './MediaTab';
export { VersionsCard } from './VersionsCard';
export { PlateView, PlateEditor } from './PlateView';
export { plateLayout, PLATE_COLORS, PLATE_FONTS, PLATE_WIDTH, type PlateKind, type PlateLayout } from './plates';
export { UndoToast, useTimelineEdit } from './UndoToast';
export { CompareView } from './CompareView';
export * as bookModel from './bookModel';
