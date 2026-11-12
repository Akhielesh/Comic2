// A composed page inside ComicPageView (pro plan B1, master plan §2.12 PE-COMPOSE). Two uses:
//   - panels mode: the whole art — the paper, every frame showing its cut of the page's drawing (all pieces share ONE
//     image URL, so it decodes once), other takes or images in their frames, the borders, then the overlays. It is the
//     page image (role img with the page's label).
//   - page mode with overlays: only the overlays, drawn over the plain <img> of the drawing (decorative: the page
//     image already carries the label).
// The tree comes from compose/pageNodes.ts and is the very one print and the exports draw. Lettering stays on top
// (BalloonLayer), as before.

import React from 'react';
import { ComposeLayer } from '../compose/ComposeLayer';
import type { ComposeScene } from '../compose/pageNodes';

export interface ComposedArtProps {
  scene: ComposeScene;
  /** The page's label when this is the page image (panels mode). */
  label?: string;
  /** A picture failed to load (its URL). */
  onImageError?: (url: string) => void;
}

export const ComposedArt: React.FC<ComposedArtProps> = ({ scene, label, onImageError }) => (
  <ComposeLayer
    scene={scene}
    label={label}
    onImageError={onImageError}
    testId={label ? 'composed-art' : 'composed-overlays'}
    className="pointer-events-none absolute inset-0 h-full w-full select-none"
  />
);

export default ComposedArt;
