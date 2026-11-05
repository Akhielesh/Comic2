// The board's "Media" tab (contract §13.2 tab ownership: media → P1-TIMELINE). One tab for every
// image of the comic plus examples from the platform library (critic: one tab, not two).

import React from 'react';
import type { StudioController } from '../types';
import { MediaBin } from './MediaBin';

export const MediaTab: React.FC<{ studio: StudioController }> = ({ studio }) => (
  <div className="min-w-0 p-3 sm:p-4">
    <MediaBin studio={studio} />
  </div>
);

export default MediaTab;
