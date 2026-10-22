// Overlay cover title (contract §13.3; owner P1-LETTER-UI). Renders only when
// `cover.lettering === 'overlay'`. Wave 0 (P0-C) stub: renders nothing (covers are painted).

import type React from 'react';
import type { ComicDoc } from '../../../shared/comic/doc';

export interface CoverTitleLayerProps {
  /** The (localized) doc. */
  doc: ComicDoc;
  aspect: number;
}

export const CoverTitleLayer: React.FC<CoverTitleLayerProps> = () => null;

export default CoverTitleLayer;
