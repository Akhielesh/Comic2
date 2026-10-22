// Derived images (contract §12.8; fixes "4:5 page rendered 1:1" with a FREE fit). Wave-0
// stub by P0-B; owned in wave 1 by P1-STORAGE, which replaces fitToAspect IN PLACE.
//
// fitToAspect pads with the edge colour or crops ≤ 8 % to reach the requested aspect;
// AssetStore.fitToAspect stores the result as a NEW asset with source 'derived'.
// Stub behaviour: throws StudioError NOT_AVAILABLE (501).

import type { AspectRatio } from '../../../shared/comic/doc.js';
import { notAvailableError } from './extensions.js';
import type { EncodedImage } from './types.js';

export async function fitToAspect(_buffer: Buffer, _aspect: AspectRatio, _mode: 'pad' | 'crop' | 'auto'): Promise<EncodedImage> {
  throw notAvailableError("Fitting an image to its page shape isn't available yet.");
}
