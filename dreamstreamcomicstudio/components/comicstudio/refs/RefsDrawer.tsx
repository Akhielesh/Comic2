// Reference images drawer for one owner (contract §13.3; owner P1-REFS).
// Wave 0 (P0-C) stub: renders nothing.

import type React from 'react';
import type { RefOwner } from '../../../shared/comic/doc';
import type { StudioController } from '../types';

export interface RefsDrawerProps {
  studio: StudioController;
  owner: RefOwner;
  open: boolean;
  onClose(): void;
}

export const RefsDrawer: React.FC<RefsDrawerProps> = () => null;

export default RefsDrawer;
