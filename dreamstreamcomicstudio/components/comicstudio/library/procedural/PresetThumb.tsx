// Procedural style-preset thumbnail (contract §13.3; owner P1-LIBRARY).
// Wave 0 (P0-C) stub: today's gradient swatch (`preset.swatch`).

import React from 'react';
import type { StylePreset } from '../../../../shared/comic/stylePresets';

export interface PresetThumbProps {
  preset: StylePreset;
  /** Width in px; omitted ⇒ fills its container. */
  size?: number;
}

export const PresetThumb: React.FC<PresetThumbProps> = ({ preset, size }) => (
  <div
    aria-hidden
    className="aspect-[4/5] w-full rounded-[inherit]"
    style={{ background: preset.swatch, ...(size ? { width: size } : {}) }}
  />
);

export default PresetThumb;
