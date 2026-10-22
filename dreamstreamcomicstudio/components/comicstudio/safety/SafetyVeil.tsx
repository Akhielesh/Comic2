// Safety veil around an image (contract §13.3; owner P1-SAFETY).
// Wave 0 (P0-C) stub: renders its children, except that a BLOCKED asset becomes a neutral tile —
// a blocked image is never put in an <img>, even before the real veil (redraw safer / change
// rating / check again) lands.

import React from 'react';
import type { AssetRef } from '../../../shared/comic/doc';
import { safetyStatusOf, type ContentRating } from '../../../shared/comic/safety';

export interface SafetyVeilProps {
  asset?: AssetRef;
  rating: ContentRating;
  children: React.ReactNode;
  onRedrawSafer?(): void;
  onChangeRating?(): void;
  onCheckAgain?(): void;
}

export const SafetyVeil: React.FC<SafetyVeilProps> = ({ asset, rating, children }) => {
  if (safetyStatusOf(asset?.safety, rating) !== 'blocked') return <>{children}</>;
  return (
    <div
      role="img"
      aria-label="Image withheld"
      data-safety="blocked"
      className="grid h-full min-h-[4rem] w-full place-items-center rounded-[inherit] bg-[var(--ds-well-strong)] px-3 text-center text-[12px] text-[var(--ds-muted)]"
    >
      Image withheld
    </div>
  );
};

export default SafetyVeil;
