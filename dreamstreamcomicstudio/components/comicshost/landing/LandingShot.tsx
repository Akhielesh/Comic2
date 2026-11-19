// One still of the landing: the theme's WebP at its declared size, loaded lazily (every still sits below the first
// screen), decoded off the main thread, with alt text that says what the picture shows. The frame and caption belong
// to the caller (LandingFigure).
import React from 'react';
import type { LandingMedia } from './landingMedia';
import { useDarkClass } from './useDarkClass';

export const LandingShot: React.FC<{ media: LandingMedia }> = ({ media }) => {
  const dark = useDarkClass();
  const src = (dark ? media.dark : media.light).webp;
  return (
    <img
      src={src}
      alt={media.alt}
      width={media.width}
      height={media.height}
      loading="lazy"
      decoding="async"
      data-landing-media={media.id}
      className="landing-media"
    />
  );
};
