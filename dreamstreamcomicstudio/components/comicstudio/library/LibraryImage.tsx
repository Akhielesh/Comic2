// A platform library image with a procedural fallback (contract §13.3; owner P1-LIBRARY).
// Wave 0 (P0-C) stub: renders only the fallback (no library is published yet).

import React from 'react';

export interface LibraryImageProps {
  /** Library id, e.g. "style.watercolor-storybook". */
  id: string;
  sizes?: string;
  /** Shown while loading, on error and when the asset is missing. */
  fallback: React.ReactNode;
  className?: string;
  alt?: string;
}

export const LibraryImage: React.FC<LibraryImageProps> = ({ fallback }) => <>{fallback}</>;

export default LibraryImage;
