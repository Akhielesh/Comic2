// LookArt (stylepick SC-1): the one picture of a look on every surface where a look is chosen (the Style tab, the
// director's "Styles that fit" card, the composer Style panel, a question's preset option, the admin console).
//
// It paints static files only, named by lookSourcesOf (lookSources.ts): the picture is in the first render, with no
// placeholder before it, no library index and no call to the backend (so a style surface never wakes the container).
// The order:
//   1. the look's scene (tile: 320 wide; large: 640, or its first sample page when that is the only large picture);
//   2. the interim drawn thumbnail (PresetThumb) for a look with no picture yet; it leaves with SC-5, once every look
//      has real sample art;
//   3. when a picture fails to load: the look's swatch, a plain gradient tile with a hairline (no figure, no text).
// Phrasing content only (img and span; the interim thumb keeps its own root until SC-5 removes it), so it sits in a
// button or the ds/MediaTile and PresetTile art slot. It fills the caller's box (give it `absolute inset-0` or a
// sized parent); the picture covers the box unless the caller passes its own object-fit.

import React, { useState } from 'react';
import { getStylePreset } from '../../../shared/comic/stylePresets';
import { cn } from '../../../lib/utils';
import { lookPictureOf, lookSourcesOf, type LookArtSize } from './lookSources';
import { PresetThumb } from './procedural/PresetThumb';

export type { LookArtSize } from './lookSources';

export interface LookArtProps {
  /** The look (a style preset id). */
  presetId: string;
  size: LookArtSize;
  /** Defaults to "<look name> sample"; pass "" when the surrounding control already names the look. */
  alt?: string;
  className?: string;
}

/** The box the picture reserves before CSS sizes it: a 4:5 look tile at the size's width. */
const BOX: Record<LookArtSize, { width: number; height: number }> = {
  tile: { width: 320, height: 400 },
  large: { width: 640, height: 800 }
};

const FILL = 'block h-full w-full';

export const LookArt: React.FC<LookArtProps> = ({ presetId, size, alt, className }) => {
  const preset = getStylePreset(presetId);
  const src = lookPictureOf(lookSourcesOf(presetId), size);
  // The file that failed: a different look (a new src) tries its own picture again.
  const [failed, setFailed] = useState<string | null>(null);
  const label = alt ?? (preset ? `${preset.name} sample` : '');
  const named = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };

  if (src && failed !== src) {
    return (
      <img
        key={src}
        src={src}
        alt={label}
        width={BOX[size].width}
        height={BOX[size].height}
        loading="lazy"
        decoding="async"
        draggable={false}
        data-look-art="art"
        data-look={presetId}
        className={cn(FILL, !/\bobject-/.test(className || '') && 'object-cover', className)}
        onError={() => setFailed(src)}
      />
    );
  }

  if (!src && preset) {
    return (
      <span {...named} data-look-art="interim" data-look={presetId} className={cn(FILL, 'overflow-hidden [&>*]:h-full [&>*]:w-full', className)}>
        <PresetThumb preset={preset} />
      </span>
    );
  }

  return (
    <span
      {...named}
      data-look-art="swatch"
      data-look={presetId}
      className={cn(FILL, 'rounded-[inherit] border border-[var(--ds-hairline)]', !preset && 'bg-[var(--ds-well)]', className)}
      style={preset ? { background: preset.swatch } : undefined}
    />
  );
};

export default LookArt;
