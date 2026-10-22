// Share button (contract §13.3; owner P1-PUBLISH): the studio header Share slot, and the reader's
// share action when given a `target`. Wave 0 (P0-C) stub: renders nothing.

import type React from 'react';
import type { StudioController } from '../types';

export interface ShareTarget {
  url: string;
  title: string;
  text?: string;
  coverUrl?: string;
}

export interface ShareButtonProps {
  studio?: StudioController;
  target?: ShareTarget;
  compact?: boolean;
}

export const ShareButton: React.FC<ShareButtonProps> = () => null;

export default ShareButton;
