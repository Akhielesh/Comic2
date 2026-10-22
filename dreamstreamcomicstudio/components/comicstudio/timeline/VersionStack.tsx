// Version stack for one render target (contract §13.3; owner P1-TIMELINE).
// Wave 0 (P0-C) stub: renders nothing.

import type React from 'react';
import type { RenderTarget } from '../../../shared/comic/doc';
import type { StudioController } from '../types';

export interface VersionStackProps {
  studio: StudioController;
  target: RenderTarget;
  compact?: boolean;
}

export const VersionStack: React.FC<VersionStackProps> = () => null;

export default VersionStack;
