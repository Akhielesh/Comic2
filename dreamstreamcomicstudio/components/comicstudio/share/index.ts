// Client feature module: publishing and the Share sheet (cards: publish, share; header slot: share).
// Owner: P1-PUBLISH. Registered through ../features.ts (contract §13.2).

import React from 'react';
import type { FeatureModule } from '../extensions';
import { PublishCard } from './PublishCard';
import { ShareButton } from './ShareButton';
import { ShareCardView } from './ShareCardView';

const ShareHeaderSlot: React.FC<{ studio: import('../types').StudioController; compact: boolean }> = ({ studio, compact }) =>
  React.createElement(ShareButton, { studio, compact });

export const feature: FeatureModule = {
  cards: [
    { type: 'publish', Component: PublishCard },
    { type: 'share', Component: ShareCardView }
  ],
  headerSlots: [{ id: 'share', order: 10, Component: ShareHeaderSlot }]
};

export { ShareButton, openShareSheet, OPEN_SHARE_EVENT } from './ShareButton';
export { ShareSheet } from './ShareSheet';
export { LinkPreviewMock } from './LinkPreviewMock';
export { ShareStats } from './ShareStats';
export { QrCode } from './QrCode';
export { usePublicComic, readShareBoot } from './usePublicComic';
export { useShareCapabilities } from './useShareCapabilities';
